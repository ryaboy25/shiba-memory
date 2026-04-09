"""
Shiba HaluMem Benchmark
========================

Tests memory hallucination resistance:
  - Memory Extraction: Can Shiba accurately store facts without hallucinating?
  - Memory Update: Can Shiba correctly update facts when new info arrives?
  - Memory QA: Can Shiba answer questions without making up memories?

Shiba's advantage: deterministic storage (no LLM extraction at storage time = no hallucination risk).

Dataset: HuggingFace IAAR-Shanghai/HaluMem (HaluMem-Medium: 20 users, ~160K tokens/user)
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
    """Call llama.cpp for QA and judging."""
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


def run():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return

    # Test LLM
    print("Testing llama.cpp connection...")
    try:
        test = llm_chat("Say OK", max_tokens=20)
        print(f"  LLM: {test[:50]}")
    except Exception as e:
        print(f"  WARNING: LLM not available ({e}). QA scoring will be skipped.")

    print("Loading HaluMem...")
    # Dataset has complex nested JSON that breaks pyarrow casting
    # Download raw JSONL directly via huggingface_hub
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(repo_id="IAAR-Shanghai/HaluMem", filename="HaluMem-Medium.jsonl", repo_type="dataset")
        ds = []
        with open(path, "r") as f:
            for line in f:
                if line.strip():
                    ds.append(json.loads(line))
    except Exception as e:
        print(f"  Failed to load: {e}")
        print("  Try: pip install huggingface_hub")
        return
    print(f"Loaded {len(ds)} users\n")

    adapter = ShibaAdapter()

    results = {
        "users_processed": 0,
        # Extraction metrics
        "extraction_total": 0,
        "extraction_recalled": 0,  # ground truth found in stored memories
        "interference_total": 0,
        "interference_resisted": 0,  # interference NOT stored (good)
        # QA metrics
        "qa_total": 0,
        "qa_correct": 0,
        "qa_hallucinated": 0,
        "qa_omitted": 0,
        # Update metrics
        "update_total": 0,
        "update_correct": 0,
    }

    for user_idx, user in enumerate(ds):
        user_id = user.get("uuid", f"user-{user_idx}")
        namespace = f"halu-{user_id[:8]}"
        adapter.cleanup(namespace=namespace)

        sessions = user.get("sessions", [])
        if not sessions:
            continue

        print(f"  User {user_idx + 1}/{len(ds)} ({len(sessions)} sessions)...")

        # Process sessions chronologically
        for sess_idx, session in enumerate(sessions):
            dialogue = session.get("dialogue", [])
            if not dialogue:
                continue

            # Ingest dialogue turns
            for turn in dialogue:
                if isinstance(turn, dict) and turn.get("content"):
                    role = turn.get("role", "user")
                    timestamp = turn.get("timestamp", "")
                    adapter.ingest(
                        [IngestItem(
                            content=f"[{role}] {turn['content']}",
                            metadata={
                                "title": f"Session {sess_idx} - {role}",
                                "type": "episode",
                                "role": role,
                            },
                        )],
                        namespace=namespace,
                    )

            # Check memory extraction against ground truth
            memory_points = session.get("memory_points", [])
            for mp in memory_points:
                if not isinstance(mp, dict):
                    continue

                mem_content = mp.get("memory_content", "")
                mem_source = mp.get("memory_source", "primary")
                is_interference = mem_source == "interference"

                if is_interference:
                    results["interference_total"] += 1
                    # Check if interference was stored (bad) or resisted (good)
                    recalled = adapter.recall(
                        RecallQuery(query=mem_content, top_k=3),
                        namespace=namespace,
                    )
                    recalled_text = " ".join(r.content.lower() for r in recalled)
                    # If the interference content appears in recalled text, system failed to resist
                    key_words = mem_content.lower().split()[:5]
                    found = sum(1 for w in key_words if w in recalled_text)
                    if found < len(key_words) * 0.6:
                        results["interference_resisted"] += 1  # Good: didn't store it
                else:
                    results["extraction_total"] += 1
                    # Check if ground truth memory was captured
                    recalled = adapter.recall(
                        RecallQuery(query=mem_content, top_k=5),
                        namespace=namespace,
                    )
                    recalled_text = " ".join(r.content.lower() for r in recalled)
                    # Simple check: do key terms from the memory appear in recalled content?
                    key_terms = [w for w in mem_content.lower().split() if len(w) > 3][:8]
                    if key_terms:
                        found = sum(1 for w in key_terms if w in recalled_text)
                        if found >= len(key_terms) * 0.5:
                            results["extraction_recalled"] += 1

                # Check updates
                if mp.get("is_update") == "True" or mp.get("is_update") is True:
                    results["update_total"] += 1
                    recalled = adapter.recall(
                        RecallQuery(query=mem_content, top_k=3),
                        namespace=namespace,
                    )
                    if recalled:
                        # Check if the updated content is in the top result
                        top_content = recalled[0].content.lower()
                        key_terms = [w for w in mem_content.lower().split() if len(w) > 3][:5]
                        found = sum(1 for w in key_terms if w in top_content)
                        if found >= len(key_terms) * 0.4:
                            results["update_correct"] += 1

            # Answer questions
            questions = session.get("questions", [])
            for q in questions:
                if not isinstance(q, dict):
                    continue

                question = q.get("question", "")
                expected = q.get("answer", "")
                q_type = q.get("question_type", "unknown")

                if not question:
                    continue

                results["qa_total"] += 1

                # Recall from Shiba
                recalled = adapter.recall(
                    RecallQuery(query=question, top_k=5),
                    namespace=namespace,
                )
                chunks = [r.content for r in recalled]
                context = "\n".join(chunks[:5])

                # Generate answer
                try:
                    answer = llm_chat(
                        f"Answer concisely (under 10 words) based on the context.\n\nContext:\n{context}\n\nQuestion: {question}\nAnswer:",
                        max_tokens=100,
                    )
                except Exception:
                    answer = ""
                    results["qa_omitted"] += 1
                    continue

                if not answer or "don't know" in answer.lower() or "not available" in answer.lower():
                    results["qa_omitted"] += 1
                    continue

                # Judge: correct, hallucinated, or omitted
                try:
                    judgment = llm_chat(
                        f"Compare the generated answer to the expected answer. Reply with ONLY one word: correct, hallucinated, or omitted.\n\nQuestion: {question}\nExpected: {expected}\nGenerated: {answer}\n\nVerdict:",
                        max_tokens=50,
                    )
                    judgment_lower = judgment.lower()
                    if "correct" in judgment_lower and "incorrect" not in judgment_lower:
                        results["qa_correct"] += 1
                    elif "hallucin" in judgment_lower:
                        results["qa_hallucinated"] += 1
                    else:
                        results["qa_omitted"] += 1
                except Exception:
                    results["qa_omitted"] += 1

        adapter.cleanup(namespace=namespace)
        results["users_processed"] += 1

        # Print progress
        ext_recall = results["extraction_recalled"] / max(results["extraction_total"], 1) * 100
        fmr = results["interference_resisted"] / max(results["interference_total"], 1) * 100
        qa_correct = results["qa_correct"] / max(results["qa_total"], 1) * 100
        qa_halluc = results["qa_hallucinated"] / max(results["qa_total"], 1) * 100
        print(f"    Extraction Recall: {ext_recall:.1f}% | FMR: {fmr:.1f}% | QA Correct: {qa_correct:.1f}% | QA Halluc: {qa_halluc:.1f}%")

    adapter.close()

    # Final results
    ext_total = max(results["extraction_total"], 1)
    int_total = max(results["interference_total"], 1)
    qa_total = max(results["qa_total"], 1)
    upd_total = max(results["update_total"], 1)

    ext_recall = results["extraction_recalled"] / ext_total * 100
    fmr = results["interference_resisted"] / int_total * 100
    qa_correct_pct = results["qa_correct"] / qa_total * 100
    qa_halluc_pct = results["qa_hallucinated"] / qa_total * 100
    qa_omit_pct = results["qa_omitted"] / qa_total * 100
    upd_correct_pct = results["update_correct"] / upd_total * 100

    print("\n" + "=" * 70)
    print("  Shiba — HaluMem Benchmark Results")
    print("=" * 70)
    print(f"  Users processed: {results['users_processed']}/{len(ds)}")
    print()
    print("  Memory Extraction:")
    print(f"    Recall:                {ext_recall:.1f}% ({results['extraction_recalled']}/{results['extraction_total']})")
    print(f"    False Memory Resist:   {fmr:.1f}% ({results['interference_resisted']}/{results['interference_total']})")
    print()
    print("  Memory Update:")
    print(f"    Correct Rate:          {upd_correct_pct:.1f}% ({results['update_correct']}/{results['update_total']})")
    print()
    print("  Memory QA:")
    print(f"    Correct:               {qa_correct_pct:.1f}% ({results['qa_correct']}/{results['qa_total']})")
    print(f"    Hallucinated:          {qa_halluc_pct:.1f}% ({results['qa_hallucinated']}/{results['qa_total']})")
    print(f"    Omitted:               {qa_omit_pct:.1f}% ({results['qa_omitted']}/{results['qa_total']})")

    # Save
    output = {
        "benchmark": "HaluMem-Medium",
        "system": "Shiba",
        "extraction_recall": round(ext_recall, 1),
        "false_memory_resistance": round(fmr, 1),
        "update_correct": round(upd_correct_pct, 1),
        "qa_correct": round(qa_correct_pct, 1),
        "qa_hallucinated": round(qa_halluc_pct, 1),
        "qa_omitted": round(qa_omit_pct, 1),
        "raw": results,
    }
    with open("results/halumem_results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to results/halumem_results.json")

    return output


if __name__ == "__main__":
    import os
    os.makedirs("results", exist_ok=True)
    run()
