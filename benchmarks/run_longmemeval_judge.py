"""
Shiba LongMemEval Benchmark — LLM-as-Judge Scoring
====================================================

Same as run_longmemeval.py but uses a local LLM (Gemma 4 via llama.cpp)
to generate answers from recalled context, then judge correctness.

This produces scores comparable to Mem0, Zep, and Honcho benchmarks.

Pipeline:
  1. Recall top-5 chunks from Shiba
  2. Feed chunks + question to Gemma 4 → generate answer
  3. Feed question + expected answer + generated answer to Gemma 4 → judge correctness
"""

import sys
import json
import time
sys.path.insert(0, ".")

import httpx
from shiba_adapter import ShibaAdapter, IngestItem, RecallQuery

LLAMA_ENDPOINT = "http://localhost:8080"
LLAMA_TIMEOUT = 60


def llm_chat(prompt, max_tokens=200):
    """Call llama.cpp OpenAI-compatible chat endpoint.
    Returns only the content field (actual answer), ignoring reasoning_content."""
    resp = httpx.post(
        f"{LLAMA_ENDPOINT}/v1/chat/completions",
        json={
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.1,
        },
        timeout=LLAMA_TIMEOUT,
    )
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    content = msg.get("content", "")
    # Fallback: if content is empty but reasoning has the answer (channel format)
    if not content.strip() and "<channel|>" in msg.get("reasoning_content", ""):
        content = msg["reasoning_content"].split("<channel|>")[-1].strip()
    return content.strip()


def llm_chat_raw(prompt, max_tokens=200):
    """Returns BOTH reasoning_content + content for judge analysis."""
    resp = httpx.post(
        f"{LLAMA_ENDPOINT}/v1/chat/completions",
        json={
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.1,
        },
        timeout=LLAMA_TIMEOUT,
    )
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    reasoning = msg.get("reasoning_content", "")
    content = msg.get("content", "")
    return f"{reasoning} {content}".strip()


def generate_answer(question, context_chunks):
    """Use LLM to answer a question given recalled context. (Phase 4A)"""
    context = "\n\n".join(f"[Memory {i+1}] {chunk}" for i, chunk in enumerate(context_chunks[:10]))
    prompt = f"""You are answering questions about past conversations. Use ONLY the provided context.
If the context contains contradictory information, prefer the more recent memory (higher number = more recent).
If the answer is not in the context, say "I don't have enough information."

Context:
{context}

Question: {question}
Answer concisely in 1-2 sentences:"""
    return llm_chat(prompt, max_tokens=300)


def judge_answer(question, expected, generated):
    """Use LLM to judge if the generated answer matches the expected answer. (Phase 4B)"""
    prompt = f"""You are an evaluation judge. Determine if the Generated Answer correctly answers the Question, compared to the Expected Answer.
Consider the answer correct if it contains the essential information from the Expected Answer, even if worded differently. Minor details may differ.
Reply with ONLY "correct" or "incorrect".

Question: {question}
Expected Answer: {expected}
Generated Answer: {generated}

Verdict:"""
    # Use raw response to capture reasoning + final answer (Gemma thinks before answering)
    result = llm_chat_raw(prompt, max_tokens=300)
    result_lower = result.lower()

    # Parse the verdict from Gemma's reasoning chain
    # Look for final verdict indicators first (strongest signals)
    if "verdict: correct" in result_lower or "verdict:correct" in result_lower:
        return True
    if "verdict: incorrect" in result_lower or "verdict:incorrect" in result_lower:
        return False

    # Look for conclusion patterns in reasoning
    # Gemma often says "the answer is correct" or "this is incorrect" in its thinking
    conclusion_patterns_correct = [
        "the answer is correct",
        "is correct",
        "correctly answers",
        "conveys the same",
        "matches the expected",
        "essentially correct",
        "the generated answer is correct",
        "word: correct",
    ]
    conclusion_patterns_incorrect = [
        "the answer is incorrect",
        "is incorrect",
        "does not correctly",
        "does not match",
        "does not convey",
        "essentially incorrect",
        "the generated answer is incorrect",
        "word: incorrect",
        "not enough information",
        "doesn't match",
        "doesn't correctly",
    ]

    # Count matches for each side
    correct_hits = sum(1 for p in conclusion_patterns_correct if p in result_lower)
    incorrect_hits = sum(1 for p in conclusion_patterns_incorrect if p in result_lower)

    if correct_hits > incorrect_hits:
        return True
    if incorrect_hits > correct_hits:
        return False

    # Fallback: check if "correct" appears more than "incorrect"
    # (careful: "incorrect" contains "correct")
    incorrect_count = result_lower.count("incorrect")
    correct_count = result_lower.count("correct") - incorrect_count
    return correct_count > incorrect_count


def run():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return

    # Test LLM connection first
    print("Testing llama.cpp connection...")
    try:
        test = llm_chat("Say hello in one word.", max_tokens=50)
        print(f"  LLM responded: {test}")
    except Exception as e:
        print(f"  ERROR: Cannot connect to llama.cpp at {LLAMA_ENDPOINT}: {e}")
        print("  Make sure llama.cpp server is running")
        return

    print("Loading LongMemEval oracle split...")
    ds = list(load_dataset(
        "xiaowu0162/longmemeval-cleaned",
        split="longmemeval_oracle",
        streaming=True,
    ))
    print(f"Loaded {len(ds)} questions\n")

    adapter = ShibaAdapter()
    results = {
        "total": 0,
        "correct": 0,
        "retrieval_hits": 0,
        "by_type": {},
        "latencies": [],
        "judge_latencies": [],
    }

    # Group questions by sample_id
    samples = {}
    for row in ds:
        sid = row.get("sample_id", row.get("question_id", ""))
        if sid not in samples:
            samples[sid] = {"sessions": [], "questions": []}
        if not samples[sid]["sessions"] and row.get("haystack_sessions"):
            samples[sid]["sessions"] = row["haystack_sessions"]
        samples[sid]["questions"].append(row)

    processed = 0
    total_samples = len(samples)

    for sid, data in samples.items():
        namespace = f"lme-{sid}"
        adapter.cleanup(namespace=namespace)

        # Ingest conversation sessions with temporal ordering + session awareness
        sessions = data["sessions"]
        total_sessions = len(sessions)
        for sess_idx, session in enumerate(sessions):
            if not session:
                continue

            # Phase 2B: Set created_at so earlier sessions have older timestamps
            # This creates a temporal gradient for recency-based scoring
            from datetime import datetime, timedelta, timezone
            base_time = datetime.now(timezone.utc) - timedelta(days=(total_sessions - sess_idx))
            created_at_str = base_time.isoformat()

            session_texts = []
            for turn in session:
                if isinstance(turn, dict) and turn.get("content"):
                    role = turn.get("role", "unknown")
                    content = f"[{role}] {turn['content']}"
                    session_texts.append(content)
                    adapter.ingest(
                        [IngestItem(
                            content=content,
                            metadata={
                                "title": f"Session {sess_idx} - {role}",
                                "type": "episode",
                                "role": role,  # Phase 1A: pass role for confidence scoring
                                "tags": [f"session-{sess_idx}"],  # Phase 3B: session tags
                            },
                            created_at=created_at_str,  # Phase 2B: temporal ordering
                        )],
                        namespace=namespace,
                    )

            # Phase 3A: Store session summary for multi-session retrieval
            if session_texts:
                summary = " ".join(session_texts)[:500]
                adapter.ingest(
                    [IngestItem(
                        content=f"[Session {sess_idx} summary] {summary}",
                        metadata={
                            "title": f"Session {sess_idx} summary",
                            "type": "episode",
                            "importance": 0.7,
                            "role": "summary",
                            "tags": [f"session-{sess_idx}", "session-summary"],
                        },
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )

        # Answer questions with LLM
        for q in data["questions"]:
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            # Step 1: Recall from Shiba (Phase 1C: top_k=10)
            start = time.time()
            recalled = adapter.recall(
                RecallQuery(query=question, top_k=10),
                namespace=namespace,
            )
            recall_time = time.time() - start
            results["latencies"].append(recall_time)

            # Check raw retrieval hit
            recalled_text = " ".join(r.content for r in recalled).lower()
            answer_lower = answer.lower().strip()
            if len(answer_lower) < 50:
                retrieval_hit = answer_lower in recalled_text
            else:
                answer_words = set(answer_lower.split())
                found = sum(1 for w in answer_words if w in recalled_text)
                retrieval_hit = found / max(len(answer_words), 1) >= 0.6

            if retrieval_hit:
                results["retrieval_hits"] += 1

            # Step 2: Generate answer using LLM
            chunks = [r.content for r in recalled]
            try:
                generated = generate_answer(question, chunks)
            except Exception as e:
                generated = ""

            # Step 3: Judge correctness
            judge_start = time.time()
            try:
                is_correct = judge_answer(question, answer, generated)
            except Exception:
                is_correct = False
            judge_time = time.time() - judge_start
            results["judge_latencies"].append(judge_time)

            results["total"] += 1
            if is_correct:
                results["correct"] += 1

            if q_type not in results["by_type"]:
                results["by_type"][q_type] = {"total": 0, "correct": 0, "retrieval_hits": 0}
            results["by_type"][q_type]["total"] += 1
            if is_correct:
                results["by_type"][q_type]["correct"] += 1
            if retrieval_hit:
                results["by_type"][q_type]["retrieval_hits"] += 1

        adapter.cleanup(namespace=namespace)
        processed += 1
        if processed % 5 == 0 or processed == total_samples:
            total = max(results["total"], 1)
            acc = results["correct"] / total * 100
            ret = results["retrieval_hits"] / total * 100
            print(f"  [{processed}/{total_samples}] LLM-Judge: {acc:.1f}% | Raw Retrieval: {ret:.1f}%")

    adapter.close()

    # Print results
    total = max(results["total"], 1)
    overall_acc = results["correct"] / total * 100
    retrieval_acc = results["retrieval_hits"] / total * 100
    avg_latency = sum(results["latencies"]) / max(len(results["latencies"]), 1)
    avg_judge = sum(results["judge_latencies"]) / max(len(results["judge_latencies"]), 1)

    print("\n" + "=" * 70)
    print("  Shiba — LongMemEval Benchmark Results (LLM-as-Judge)")
    print("=" * 70)
    print(f"  LLM-Judge Accuracy:       {overall_acc:.1f}% ({results['correct']}/{results['total']})")
    print(f"  Raw Retrieval Accuracy:   {retrieval_acc:.1f}% ({results['retrieval_hits']}/{results['total']})")
    print(f"  Retrieval Latency:        {avg_latency*1000:.0f}ms avg")
    print(f"  Judge Latency:            {avg_judge*1000:.0f}ms avg")
    print()
    print("  By Question Type:")
    print(f"  {'Type':<30} {'LLM-Judge':>10} {'Retrieval':>10}")
    print(f"  {'-'*30} {'-'*10} {'-'*10}")
    for q_type, data in sorted(results["by_type"].items()):
        judge_acc = data["correct"] / max(data["total"], 1) * 100
        ret_acc = data["retrieval_hits"] / max(data["total"], 1) * 100
        print(f"  {q_type:<30} {judge_acc:>8.1f}% {ret_acc:>8.1f}%")

    print()
    print("  Comparison (LLM-as-Judge):")
    print(f"  {'System':<20} {'Score':>10}")
    print(f"  {'-'*20} {'-'*10}")
    print(f"  {'Shiba':<20} {overall_acc:>8.1f}%")
    print(f"  {'Mem0':<20} {'49.0':>8}%")
    print(f"  {'Zep':<20} {'63.8':>8}%")
    print(f"  {'Honcho':<20} {'89.9':>8}%")

    # Save results
    output = {
        "benchmark": "LongMemEval (oracle) — LLM-as-Judge",
        "system": "Shiba",
        "judge_model": "Gemma 4 (local, llama.cpp)",
        "llm_judge_accuracy": round(overall_acc, 1),
        "raw_retrieval_accuracy": round(retrieval_acc, 1),
        "avg_retrieval_latency_ms": round(avg_latency * 1000),
        "avg_judge_latency_ms": round(avg_judge * 1000),
        "by_type": {
            k: {
                "llm_judge_accuracy": round(v["correct"] / max(v["total"], 1) * 100, 1),
                "retrieval_accuracy": round(v["retrieval_hits"] / max(v["total"], 1) * 100, 1),
                **v,
            }
            for k, v in results["by_type"].items()
        },
    }
    with open("results/longmemeval_judge_results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to results/longmemeval_judge_results.json")

    return output


if __name__ == "__main__":
    import os
    os.makedirs("results", exist_ok=True)
    run()
