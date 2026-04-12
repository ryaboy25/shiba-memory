"""
Shiba LongMemEval Benchmark
============================

Runs the LongMemEval oracle split against Shiba's hybrid search.
Each question has designated evidence sessions — we ingest them,
then test retrieval accuracy.

Optimizations:
  - Overlapping 3-turn window ingestion (captures conversational context)
  - Iterative multi-hop retrieval with query expansion
  - Higher top_k (15) for broader coverage
  - All benchmark data at confidence=0.95

Metrics:
  - Retrieval accuracy: does the recalled content contain the answer?
  - Per-category breakdown (info extraction, temporal, knowledge update, etc.)
  - Mean reciprocal rank (MRR)
"""

import sys
import json
import time
import re
sys.path.insert(0, ".")

from shiba_adapter import ShibaAdapter, IngestItem, RecallQuery


def expand_query(question):
    """Generate query reformulations for broader retrieval coverage."""
    expansions = [question]
    q_lower = question.lower().strip()

    # Strip question framing to get core query
    core = re.sub(r'^(what|who|where|when|how|which|do|did|does|is|are|was|were|have|has|had|can|could|would|should)\s+(is|are|was|were|do|does|did|has|have|had)?\s*', '', q_lower, flags=re.IGNORECASE).strip()
    core = re.sub(r'\?$', '', core).strip()
    if core and core != q_lower.rstrip('?') and len(core) > 5:
        expansions.append(core)

    # Convert questions to statements
    statement_patterns = [
        (r'what (?:is|are|was|were) (?:my|the) (.+)\??', r'\1'),
        (r'what (.+) (?:do|did|does|have|has) (?:i|we|you) (.+)\??', r'\2 \1'),
        (r'where (?:do|did|does) (?:i|we) (.+)\??', r'I \1 at'),
        (r'who (?:is|are|was) (.+)\??', r'\1'),
        (r'when (?:did|do|does) (?:i|we) (.+)\??', r'I \1'),
        (r"(?:do|did|does) (?:i|we) (?:have|own|like|prefer|want|use|need) (.+)\??", r"I have \1"),
    ]
    for pattern, replacement in statement_patterns:
        match = re.match(pattern, q_lower)
        if match:
            try:
                statement = re.sub(pattern, replacement, q_lower).strip().rstrip('?')
                if statement and statement not in expansions:
                    expansions.append(statement)
            except Exception:
                pass
            break

    return expansions[:3]


def iterative_recall(adapter, question, namespace, top_k=15):
    """Multi-pass retrieval with query expansion and entity extraction."""
    seen_ids = set()
    all_results = []

    # Pass 1: Query + expansions
    for q in expand_query(question):
        try:
            recalled = adapter.recall(
                RecallQuery(query=q, top_k=top_k),
                namespace=namespace,
            )
            for r in recalled:
                if r.document_id not in seen_ids:
                    seen_ids.add(r.document_id)
                    all_results.append(r)
        except Exception:
            pass

    # Pass 2: Extract entities from results and re-query
    if all_results:
        top_content = " ".join(r.content[:200] for r in all_results[:5])
        entities = set()
        for match in re.finditer(r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+', top_content):
            entities.add(match.group())
        for match in re.finditer(r'"([^"]{2,30})"', top_content):
            entities.add(match.group(1))

        for entity in list(entities)[:3]:
            try:
                recalled = adapter.recall(
                    RecallQuery(query=entity, top_k=5),
                    namespace=namespace,
                )
                for r in recalled:
                    if r.document_id not in seen_ids:
                        seen_ids.add(r.document_id)
                        all_results.append(r)
            except Exception:
                pass

    all_results.sort(key=lambda r: r.score, reverse=True)
    return all_results[:top_k]


def run():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return

    print("Loading LongMemEval oracle split...")
    # Use streaming to avoid downloading the 2.7GB medium split
    ds = list(load_dataset(
        "xiaowu0162/longmemeval-cleaned",
        split="longmemeval_oracle",
        streaming=True,
    ))
    print(f"Loaded {len(ds)} questions\n")

    adapter = ShibaAdapter()
    results = {
        "total": 0,
        "retrieval_hits": 0,
        "by_type": {},
        "mrr_sum": 0.0,
        "latencies": [],
    }

    # Group questions by sample_id to batch ingestion
    samples = {}
    for row in ds:
        sid = row.get("sample_id", row.get("question_id", ""))
        if sid not in samples:
            samples[sid] = {"sessions": [], "questions": []}

        # Collect sessions (only need to ingest once per sample)
        if not samples[sid]["sessions"] and row.get("haystack_sessions"):
            samples[sid]["sessions"] = row["haystack_sessions"]

        samples[sid]["questions"].append(row)

    processed = 0
    total_samples = len(samples)

    for sid, data in samples.items():
        namespace = f"lme-{sid}"
        adapter.cleanup(namespace=namespace)

        # Ingest with overlapping windows
        sessions = data["sessions"]
        total_sessions = len(sessions)
        for sess_idx, session in enumerate(sessions):
            if not session:
                continue

            from datetime import datetime, timedelta, timezone
            base_time = datetime.now(timezone.utc) - timedelta(days=(total_sessions - sess_idx))
            created_at_str = base_time.isoformat()

            turns = []
            for turn in session:
                if isinstance(turn, dict) and turn.get("content"):
                    role = turn.get("role", "unknown")
                    turns.append(f"[{role}] {turn['content']}")

            # Individual turns
            for i, turn_text in enumerate(turns):
                adapter.ingest(
                    [IngestItem(
                        content=turn_text,
                        metadata={
                            "title": f"Session {sess_idx} turn {i}",
                            "type": "episode",
                            "tags": [f"session-{sess_idx}"],
                        },
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )

            # Overlapping 3-turn windows
            window_size = 3
            stride = 2
            for i in range(0, len(turns), stride):
                window = turns[i:i + window_size]
                if len(window) >= 2:
                    window_text = "\n".join(window)
                    adapter.ingest(
                        [IngestItem(
                            content=window_text,
                            metadata={
                                "title": f"Session {sess_idx} window {i//stride}",
                                "type": "episode",
                                "importance": 0.7,
                                "tags": [f"session-{sess_idx}", "window"],
                            },
                            created_at=created_at_str,
                        )],
                        namespace=namespace,
                    )

            # Full session summary
            if turns:
                summary = "\n".join(turns)[:1000]
                adapter.ingest(
                    [IngestItem(
                        content=f"[Session {sess_idx} full transcript] {summary}",
                        metadata={
                            "title": f"Session {sess_idx} summary",
                            "type": "episode",
                            "importance": 0.8,
                            "tags": [f"session-{sess_idx}", "session-summary"],
                        },
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )

        # Answer questions with iterative retrieval
        for q in data["questions"]:
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            start = time.time()
            recalled = iterative_recall(adapter, question, namespace, top_k=15)
            latency = time.time() - start
            results["latencies"].append(latency)

            # Check if answer appears in recalled content
            recalled_text = " ".join(r.content for r in recalled).lower()
            answer_lower = answer.lower().strip()

            if len(answer_lower) < 50:
                hit = answer_lower in recalled_text
            else:
                answer_words = set(answer_lower.split())
                found = sum(1 for w in answer_words if w in recalled_text)
                hit = found / max(len(answer_words), 1) >= 0.6

            # MRR: find first relevant result
            mrr = 0.0
            for rank, r in enumerate(recalled, 1):
                if answer_lower in r.content.lower():
                    mrr = 1.0 / rank
                    break
            results["mrr_sum"] += mrr

            results["total"] += 1
            if hit:
                results["retrieval_hits"] += 1

            if q_type not in results["by_type"]:
                results["by_type"][q_type] = {"total": 0, "hits": 0}
            results["by_type"][q_type]["total"] += 1
            if hit:
                results["by_type"][q_type]["hits"] += 1

        adapter.cleanup(namespace=namespace)
        processed += 1
        if processed % 10 == 0 or processed == total_samples:
            acc = results["retrieval_hits"] / max(results["total"], 1) * 100
            print(f"  [{processed}/{total_samples}] Running accuracy: {acc:.1f}%")

    adapter.close()

    # Print results
    total = max(results["total"], 1)
    overall_acc = results["retrieval_hits"] / total * 100
    mrr = results["mrr_sum"] / total
    avg_latency = sum(results["latencies"]) / max(len(results["latencies"]), 1)
    p95_latency = sorted(results["latencies"])[int(len(results["latencies"]) * 0.95)] if results["latencies"] else 0

    print("\n" + "=" * 60)
    print("  Shiba — LongMemEval Benchmark Results")
    print("=" * 60)
    print(f"  Overall Retrieval Accuracy: {overall_acc:.1f}% ({results['retrieval_hits']}/{results['total']})")
    print(f"  Mean Reciprocal Rank (MRR): {mrr:.3f}")
    print(f"  Avg Latency: {avg_latency*1000:.0f}ms | P95: {p95_latency*1000:.0f}ms")
    print()
    print("  By Question Type:")
    for q_type, data in sorted(results["by_type"].items()):
        acc = data["hits"] / max(data["total"], 1) * 100
        print(f"    {q_type}: {acc:.1f}% ({data['hits']}/{data['total']})")

    # Save results
    output = {
        "benchmark": "LongMemEval (oracle)",
        "system": "Shiba",
        "overall_accuracy": round(overall_acc, 1),
        "mrr": round(mrr, 3),
        "avg_latency_ms": round(avg_latency * 1000),
        "p95_latency_ms": round(p95_latency * 1000),
        "by_type": {k: {"accuracy": round(v["hits"]/max(v["total"],1)*100, 1), **v} for k, v in results["by_type"].items()},
    }
    with open("results/longmemeval_results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to results/longmemeval_results.json")

    return output


if __name__ == "__main__":
    import os
    os.makedirs("results", exist_ok=True)
    run()
