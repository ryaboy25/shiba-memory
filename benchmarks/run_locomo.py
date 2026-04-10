"""
Shiba LoCoMo Benchmark
=======================

10 multi-session conversations with 7,500+ QA pairs.
Categories: single-hop, multi-hop, temporal, open-domain, adversarial.

Dataset: snap-research/locomo (locomo10.json)
"""

import sys
import json
import time
import os
sys.path.insert(0, ".")

import httpx
from shiba_adapter import ShibaAdapter, IngestItem, RecallQuery

LLAMA_ENDPOINT = "http://localhost:8080"
LLAMA_TIMEOUT = 60
DATA_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
DATA_CACHE = "results/locomo10.json"


def llm_chat(prompt, max_tokens=200):
    resp = httpx.post(
        f"{LLAMA_ENDPOINT}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "temperature": 0.1},
        timeout=LLAMA_TIMEOUT,
    )
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    content = msg.get("content", "")
    reasoning = msg.get("reasoning_content", "")
    if not content.strip() and reasoning.strip():
        if "<channel|>" in reasoning:
            content = reasoning.split("<channel|>")[-1].strip()
        else:
            content = reasoning.strip()
    return content.strip()


def download_dataset():
    """Download locomo10.json if not cached."""
    if os.path.exists(DATA_CACHE):
        print(f"Using cached {DATA_CACHE}")
        with open(DATA_CACHE) as f:
            return json.load(f)

    print(f"Downloading LoCoMo dataset from {DATA_URL}...")
    resp = httpx.get(DATA_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    os.makedirs("results", exist_ok=True)
    with open(DATA_CACHE, "w") as f:
        json.dump(data, f)
    return data


def run():
    # Test LLM
    print("Testing llama.cpp connection...")
    try:
        test = llm_chat("Say OK", max_tokens=20)
        print(f"  LLM: {test[:30]}")
    except Exception as e:
        print(f"  WARNING: LLM not available ({e})")

    data = download_dataset()
    print(f"Loaded {len(data)} conversations\n")

    adapter = ShibaAdapter()

    cat_names = {
        1: "Single-Hop",
        2: "Multi-Hop",
        3: "Temporal",
        4: "Open-Domain",
        5: "Adversarial",
    }

    results = {
        "total": 0,
        "correct": 0,
        "by_category": {},
        "retrieval_hits": 0,
        "latencies": [],
    }

    for conv_idx, conv in enumerate(data):
        namespace = f"locomo-{conv_idx}"
        adapter.cleanup(namespace=namespace)

        # Get conversation sessions
        conversation = conv.get("conversation", {})
        session_keys = sorted([k for k in conversation.keys() if k.startswith("session_")],
                              key=lambda x: int(x.split("_")[1]) if x.split("_")[1].isdigit() else 0)

        # Ingest all sessions — store individual turns + session summaries + round pairs
        speaker_a = conversation.get("speaker_a", "Speaker A")
        speaker_b = conversation.get("speaker_b", "Speaker B")

        for sess_key in session_keys:
            session = conversation[sess_key]
            if not isinstance(session, list):
                continue

            session_texts = []
            # Store individual turns
            for turn in session:
                if isinstance(turn, dict):
                    text = turn.get("text", turn.get("content", ""))
                    speaker = turn.get("speaker", turn.get("role", "unknown"))
                    if text:
                        full_text = f"[{speaker}] {text}"
                        session_texts.append(full_text)
                        adapter.ingest(
                            [IngestItem(
                                content=full_text,
                                metadata={
                                    "title": f"{sess_key} - {speaker}",
                                    "type": "episode",
                                    "role": "user",
                                },
                            )],
                            namespace=namespace,
                        )

            # Store consecutive turn pairs (round-level context for multi-hop)
            for i in range(0, len(session_texts) - 1, 2):
                pair = session_texts[i] + "\n" + session_texts[i + 1] if i + 1 < len(session_texts) else session_texts[i]
                adapter.ingest(
                    [IngestItem(
                        content=pair,
                        metadata={
                            "title": f"{sess_key} round {i//2 + 1}",
                            "type": "episode",
                            "importance": 0.6,
                        },
                    )],
                    namespace=namespace,
                )

            # Store session summary
            if session_texts:
                summary = " ".join(session_texts)[:800]
                adapter.ingest(
                    [IngestItem(
                        content=f"[Session {sess_key} summary] {summary}",
                        metadata={
                            "title": f"{sess_key} summary",
                            "type": "episode",
                            "importance": 0.7,
                        },
                    )],
                    namespace=namespace,
                )

        # Answer QA questions
        qa_list = conv.get("qa", [])
        for qa in qa_list:
            question = str(qa.get("question", ""))
            expected = str(qa.get("answer", ""))
            category = qa.get("category", 0)

            if not question or not expected:
                continue

            results["total"] += 1
            cat_key = cat_names.get(category, f"Category-{category}")
            if cat_key not in results["by_category"]:
                results["by_category"][cat_key] = {"total": 0, "correct": 0, "retrieval_hits": 0}
            results["by_category"][cat_key]["total"] += 1

            # Recall from Shiba
            start = time.time()
            recalled = adapter.recall(
                RecallQuery(query=question, top_k=10),
                namespace=namespace,
            )
            latency = time.time() - start
            results["latencies"].append(latency)

            # Raw retrieval check
            recalled_text = " ".join(r.content.lower() for r in recalled)
            if expected.lower().strip() in recalled_text:
                results["retrieval_hits"] += 1
                results["by_category"][cat_key]["retrieval_hits"] += 1

            # Generate answer
            chunks = [r.content for r in recalled[:10]]
            context = "\n".join(f"[{i+1}] {c}" for i, c in enumerate(chunks))
            try:
                answer = llm_chat(
                    f"Answer concisely based on context.\n\nContext:\n{context}\n\nQuestion: {question}\nAnswer:",
                    max_tokens=200,
                )
            except Exception:
                answer = ""

            # Judge
            try:
                judgment = llm_chat(
                    f"Does the generated answer match the expected answer? Reply with ONLY correct or incorrect.\n\nQuestion: {question}\nExpected: {expected}\nGenerated: {answer}\n\nVerdict:",
                    max_tokens=200,
                )
                combined = (judgment + " " + (answer or "")).lower()
                ic = combined.count("incorrect")
                c = combined.count("correct") - ic
                if c > ic:
                    results["correct"] += 1
                    results["by_category"][cat_key]["correct"] += 1
            except Exception:
                pass

        adapter.cleanup(namespace=namespace)
        total = max(results["total"], 1)
        acc = results["correct"] / total * 100
        ret = results["retrieval_hits"] / total * 100
        print(f"  Conv {conv_idx + 1}/{len(data)} | QA: {results['total']} | LLM-Judge: {acc:.1f}% | Retrieval: {ret:.1f}%")

    adapter.close()

    # Final results
    total = max(results["total"], 1)
    overall = results["correct"] / total * 100
    ret_overall = results["retrieval_hits"] / total * 100
    avg_lat = sum(results["latencies"]) / max(len(results["latencies"]), 1)

    print("\n" + "=" * 70)
    print("  Shiba — LoCoMo Benchmark Results (LLM-as-Judge)")
    print("=" * 70)
    print(f"  Overall Accuracy:     {overall:.1f}% ({results['correct']}/{results['total']})")
    print(f"  Raw Retrieval:        {ret_overall:.1f}%")
    print(f"  Avg Latency:          {avg_lat*1000:.0f}ms")
    print()
    print("  By Category:")
    for cat, d in sorted(results["by_category"].items()):
        cat_acc = d["correct"] / max(d["total"], 1) * 100
        cat_ret = d["retrieval_hits"] / max(d["total"], 1) * 100
        print(f"    {cat:<20} LLM-Judge: {cat_acc:>5.1f}% | Retrieval: {cat_ret:>5.1f}% ({d['correct']}/{d['total']})")

    # Save
    output = {
        "benchmark": "LoCoMo",
        "system": "Shiba",
        "overall_accuracy": round(overall, 1),
        "raw_retrieval": round(ret_overall, 1),
        "avg_latency_ms": round(avg_lat * 1000),
        "by_category": {k: {"accuracy": round(v["correct"]/max(v["total"],1)*100, 1), **v} for k, v in results["by_category"].items()},
    }
    with open("results/locomo_results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to results/locomo_results.json")


if __name__ == "__main__":
    import os
    os.makedirs("results", exist_ok=True)
    run()
