"""
Shiba LongMemEval Benchmark
============================

Runs the LongMemEval oracle split against Shiba's hybrid search.
Each question has designated evidence sessions — we ingest them,
then test retrieval accuracy.

Metrics:
  - Retrieval accuracy: does the recalled content contain the answer?
  - Per-category breakdown (info extraction, temporal, knowledge update, etc.)
  - Mean reciprocal rank (MRR)
"""

import sys
import json
import time
sys.path.insert(0, ".")

from shiba_adapter import ShibaAdapter, IngestItem, RecallQuery

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

        # Ingest conversation sessions
        sessions = data["sessions"]
        for sess_idx, session in enumerate(sessions):
            if not session:
                continue
            for turn in session:
                if isinstance(turn, dict) and turn.get("content"):
                    role = turn.get("role", "unknown")
                    adapter.ingest(
                        [IngestItem(
                            content=f"[{role}] {turn['content']}",
                            metadata={
                                "title": f"Session {sess_idx} - {role}",
                                "type": "episode",
                            },
                        )],
                        namespace=namespace,
                    )

        # Answer questions
        for q in data["questions"]:
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            start = time.time()
            recalled = adapter.recall(
                RecallQuery(query=question, top_k=5),
                namespace=namespace,
            )
            latency = time.time() - start
            results["latencies"].append(latency)

            # Check if answer appears in recalled content
            recalled_text = " ".join(r.content for r in recalled).lower()
            answer_lower = answer.lower().strip()

            # For short answers, check exact containment
            # For longer answers, check if key words overlap
            if len(answer_lower) < 50:
                hit = answer_lower in recalled_text
            else:
                # Check if at least 60% of answer words appear
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
