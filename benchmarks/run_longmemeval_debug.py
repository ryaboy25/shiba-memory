"""
Shiba LongMemEval Debug — Log Questions, Answers, and Judge Decisions
=====================================================================

Runs a small sample (or full set) and dumps detailed logs for every question
so we can see exactly where generation and judging go wrong.

Output: results/longmemeval_debug.jsonl  (one JSON object per question)
"""

import sys
import json
import time
import re
sys.path.insert(0, ".")

import httpx
from shiba_gateway_adapter import ShibaGatewayAdapter as ShibaAdapter, IngestItem, RecallQuery

LLAMA_ENDPOINT = "http://localhost:8080"
LLAMA_TIMEOUT = 60

# How many samples to process (set to 0 for all)
MAX_SAMPLES = 0


def extract_answer_from_reasoning(reasoning):
    """Extract the actual answer from a Gemma reasoning chain."""
    text = reasoning.strip()
    if not text:
        return text

    # Look for quoted conclusion
    quotes = re.findall(r'"([^"]{3,})"', text)
    answer_quotes = [q for q in quotes if not q.endswith("?")]
    if answer_quotes:
        return answer_quotes[-1]

    # Look for "Answer:" marker
    answer_match = re.search(r'(?:^|\n)\s*\*?\s*(?:Answer|Result|Conclusion|So|Therefore)[:\s]+(.+)', text, re.IGNORECASE)
    if answer_match:
        return answer_match.group(1).strip().rstrip("*").strip()

    # Take the last non-empty meaningful line
    lines = [l.strip().lstrip("*").strip() for l in text.split("\n") if l.strip()]
    for line in reversed(lines):
        if any(line.lower().startswith(p) for p in ["question:", "constraint:", "context:", "input:"]):
            continue
        if len(line) > 5:
            return line

    return text


def llm_chat(prompt, max_tokens=200):
    """Call llama.cpp — returns (content, reasoning_content, raw_message)."""
    resp = httpx.post(
        f"{LLAMA_ENDPOINT}/v1/chat/completions",
        json={
            "messages": [
                {"role": "system", "content": "Respond directly with the answer. Do not think step by step. Do not use bullet points. Be concise."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.1,
        },
        timeout=LLAMA_TIMEOUT,
    )
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    content = msg.get("content", "").strip()
    reasoning = msg.get("reasoning_content", "").strip()

    # Strip Gemma channel/turn artifacts
    if "<channel|>" in content:
        content = content.split("<channel|>")[-1].strip()
    content = content.replace("<end_of_turn>", "").replace("<|channel>thought\n", "").strip()

    # Same fallback logic as main script
    effective = content
    fallback_used = None
    if not content:
        if "<channel|>" in reasoning:
            effective = reasoning.split("<channel|>")[-1].strip().replace("<end_of_turn>", "").strip()
            fallback_used = "channel_split"
        elif reasoning:
            effective = reasoning.replace("<end_of_turn>", "").strip()
            fallback_used = "reasoning_as_content"

    return {
        "effective": effective,
        "content": content,
        "reasoning": reasoning,
        "fallback_used": fallback_used,
    }


def generate_answer(question, context_chunks, q_type=""):
    context = "\n\n".join(f"[Memory {i+1}] {chunk}" for i, chunk in enumerate(context_chunks[:10]))

    if q_type == "single-session-preference":
        prompt = f"""Based on the context below, infer the user's preference or opinion. Look for clues in what they said, chose, liked, or disliked. State the preference directly and concisely (1-2 sentences).

Context:
{context}

Question: {question}
Answer:"""
    elif q_type == "temporal-reasoning":
        prompt = f"""Answer the question based on the context below. Pay close attention to the order of events, timestamps, and when things happened. Be concise (1-2 sentences).

Context:
{context}

Question: {question}
Answer:"""
    else:
        prompt = f"""Answer the question based on the context below. Always attempt an answer even if uncertain. Be concise (1-2 sentences).

Context:
{context}

Question: {question}
Answer:"""
    return llm_chat(prompt, max_tokens=300)


NUM_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20",
}
NUM_DIGITS = {v: k for k, v in NUM_WORDS.items()}
STOP_WORDS = {"the", "a", "an", "is", "are", "was", "were", "i", "my", "me",
              "we", "you", "your", "and", "or", "of", "in", "on", "at", "to",
              "for", "it", "its", "that", "this", "have", "has", "had", "do",
              "did", "does", "be", "been", "being", "with", "from", "by", "as",
              "but", "not", "so", "if", "no", "yes", "also", "very", "just",
              "about", "up", "out", "into", "over", "after", "before", "than"}


def normalize_number(text):
    text = text.strip().lower()
    if text.isdigit():
        return text
    if text in NUM_WORDS:
        return NUM_WORDS[text]
    for word in text.split():
        word = word.strip(".,;:!?\"'")
        if word.isdigit():
            return word
        if word in NUM_WORDS:
            return NUM_WORDS[word]
    return None


def extract_key_tokens(text):
    text = text.lower().strip().strip("\"'").strip()
    tokens = re.findall(r'[a-z0-9]+(?:\'[a-z]+)?', text)
    return {t for t in tokens if t not in STOP_WORDS and len(t) > 1}


def fuzzy_judge(expected, generated):
    expected_clean = expected.strip().strip("\"'").strip()
    gen_clean = generated.strip()

    exp_num = normalize_number(expected_clean)
    if exp_num is not None:
        gen_num = normalize_number(gen_clean)
        if gen_num is not None:
            match = exp_num == gen_num
            return match, f"numeric:{'match' if match else 'mismatch'}({exp_num}vs{gen_num})"
        num_word = NUM_DIGITS.get(exp_num, "")
        if exp_num in gen_clean or num_word in gen_clean.lower():
            return True, f"numeric:found_in_text({exp_num})"
        return None, None

    if len(expected_clean) < 100:
        exp_tokens = extract_key_tokens(expected_clean)
        gen_tokens = extract_key_tokens(gen_clean)
        if not exp_tokens:
            return None, None
        overlap = exp_tokens & gen_tokens
        ratio = len(overlap) / len(exp_tokens)
        if ratio >= 0.6:
            return True, f"token_overlap:{ratio:.0%}({len(overlap)}/{len(exp_tokens)})"
        if ratio <= 0.15:
            return False, f"token_overlap_low:{ratio:.0%}({len(overlap)}/{len(exp_tokens)})"

    return None, None


def judge_answer(question, expected, generated):
    """Returns (verdict, debug_info)."""
    if not generated or len(generated.strip()) < 3:
        return False, {"reason": "empty_or_too_short", "generated": generated}

    gen_lower = generated.lower()
    if any(p in gen_lower for p in ["i don't have", "not enough information", "no information", "cannot determine"]):
        exp_lower = expected.lower()
        if any(p in exp_lower for p in ["not enough", "information provided is not enough"]):
            return True, {"reason": "both_insufficient_info"}
        return False, {"reason": "refusal_detected", "generated": generated}

    expected_clean = expected.strip().strip("\"'").strip().lower()
    gen_clean = generated.strip().lower()
    if expected_clean and expected_clean in gen_clean:
        return True, {"reason": "string_match", "expected_clean": expected_clean}

    # Fuzzy judge for factual answers
    fuzzy_result, fuzzy_reason = fuzzy_judge(expected, generated)
    if fuzzy_result is not None:
        return fuzzy_result, {"reason": f"fuzzy:{fuzzy_reason}"}

    # LLM judge for complex answers only
    prompt = f"""Does the Generated Answer express the same meaning as the Expected Answer for this question? Minor wording differences are OK — focus on whether the core answer matches, not exact phrasing.

Reply with exactly one word: correct or incorrect

Question: {question}
Expected: {expected}
Generated: {generated}

Verdict:"""
    result = llm_chat(prompt, max_tokens=200)
    result_effective = result["effective"].lower().strip()

    if result_effective.startswith("correct"):
        verdict = True
        reason = "llm_correct"
    elif result_effective.startswith("incorrect"):
        verdict = False
        reason = "llm_incorrect"
    else:
        incorrect_count = result_effective.count("incorrect")
        correct_count = result_effective.count("correct") - incorrect_count
        verdict = correct_count > incorrect_count
        reason = f"llm_fallback_{'correct' if verdict else 'incorrect'}"

    return verdict, {
        "reason": reason,
        "judge_effective": result["effective"],
        "judge_content": result["content"],
        "judge_reasoning": result["reasoning"][:500],
        "judge_fallback": result["fallback_used"],
    }


def expand_query(question):
    expansions = [question]
    q_lower = question.lower().strip()
    core = re.sub(r'^(what|who|where|when|how|which|do|did|does|is|are|was|were|have|has|had|can|could|would|should)\s+(is|are|was|were|do|does|did|has|have|had)?\s*', '', q_lower, flags=re.IGNORECASE).strip()
    core = re.sub(r'\?$', '', core).strip()
    if core and core != q_lower.rstrip('?') and len(core) > 5:
        expansions.append(core)

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


def multi_query_recall(adapter, question, namespace, top_k=10):
    seen_ids = set()
    all_results = []
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
    all_results.sort(key=lambda r: r.score, reverse=True)
    return all_results[:top_k]


def run():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return

    print("Testing llama.cpp connection...")
    try:
        test = llm_chat("Say hello in one word.", max_tokens=50)
        print(f"  LLM responded: {test['effective']}")
    except Exception as e:
        print(f"  ERROR: Cannot connect to llama.cpp at {LLAMA_ENDPOINT}: {e}")
        return

    print("Loading LongMemEval oracle split...")
    ds = list(load_dataset(
        "xiaowu0162/longmemeval-cleaned",
        split="longmemeval_oracle",
        streaming=True,
    ))
    print(f"Loaded {len(ds)} questions\n")

    adapter = ShibaAdapter()

    # Group by sample_id
    samples = {}
    for row in ds:
        sid = row.get("sample_id", row.get("question_id", ""))
        if sid not in samples:
            samples[sid] = {"sessions": [], "questions": []}
        if not samples[sid]["sessions"] and row.get("haystack_sessions"):
            samples[sid]["sessions"] = row["haystack_sessions"]
        samples[sid]["questions"].append(row)

    import os
    os.makedirs("results", exist_ok=True)
    log_path = "results/longmemeval_debug.jsonl"
    log_file = open(log_path, "w")

    processed = 0
    total_q = 0
    correct = 0
    retrieval_hits = 0
    by_type = {}

    total_samples = len(samples) if MAX_SAMPLES == 0 else min(MAX_SAMPLES, len(samples))

    for sid, data in samples.items():
        if MAX_SAMPLES and processed >= MAX_SAMPLES:
            break

        namespace = f"lme-{sid}"
        adapter.cleanup(namespace=namespace)

        # ── Ingest (same as main script) ──
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

            for i, turn_text in enumerate(turns):
                adapter.ingest(
                    [IngestItem(
                        content=turn_text,
                        metadata={"title": f"Session {sess_idx} turn {i}", "type": "episode", "tags": [f"session-{sess_idx}"]},
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )

            window_size = 3
            stride = 2
            for i in range(0, len(turns), stride):
                window = turns[i:i + window_size]
                if len(window) >= 2:
                    window_text = "\n".join(window)
                    adapter.ingest(
                        [IngestItem(
                            content=window_text,
                            metadata={"title": f"Session {sess_idx} window {i//stride}", "type": "episode", "importance": 0.7, "tags": [f"session-{sess_idx}", "window"]},
                            created_at=created_at_str,
                        )],
                        namespace=namespace,
                    )

            if turns:
                summary = "\n".join(turns)[:1000]
                adapter.ingest(
                    [IngestItem(
                        content=f"[Session {sess_idx} full transcript] {summary}",
                        metadata={"title": f"Session {sess_idx} summary", "type": "episode", "importance": 0.8, "tags": [f"session-{sess_idx}", "session-summary"]},
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )

        # ── Answer + log ──
        for q in data["questions"]:
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            # Recall
            start = time.time()
            recalled = multi_query_recall(adapter, question, namespace, top_k=10)
            recall_time = time.time() - start

            # Retrieval hit check
            recalled_text = " ".join(r.content for r in recalled).lower()
            answer_clean = answer.strip().strip("\"'").strip().lower()
            if len(answer_clean) < 50:
                retrieval_hit = answer_clean in recalled_text
            else:
                answer_words = set(answer_clean.split())
                found = sum(1 for w in answer_words if w in recalled_text)
                retrieval_hit = found / max(len(answer_words), 1) >= 0.6

            if retrieval_hit:
                retrieval_hits += 1

            # Generate
            chunks = [r.content for r in recalled]
            try:
                gen_result = generate_answer(question, chunks, q_type=q_type)
                generated = gen_result["effective"]
            except Exception as e:
                generated = ""
                gen_result = {"error": str(e)}

            # Judge
            judge_start = time.time()
            try:
                is_correct, judge_debug = judge_answer(question, answer, generated)
            except Exception as e:
                is_correct = False
                judge_debug = {"error": str(e)}
            judge_time = time.time() - judge_start

            total_q += 1
            if is_correct:
                correct += 1

            if q_type not in by_type:
                by_type[q_type] = {"total": 0, "correct": 0, "retrieval_hits": 0}
            by_type[q_type]["total"] += 1
            if is_correct:
                by_type[q_type]["correct"] += 1
            if retrieval_hit:
                by_type[q_type]["retrieval_hits"] += 1

            # Write debug log
            entry = {
                "sample_id": sid,
                "question": question,
                "expected_answer": answer,
                "question_type": q_type,
                "retrieval_hit": retrieval_hit,
                "generated_answer": generated,
                "gen_content": gen_result.get("content", ""),
                "gen_reasoning": (gen_result.get("reasoning", "") or "")[:500],
                "gen_fallback": gen_result.get("fallback_used"),
                "judge_correct": is_correct,
                "judge_debug": judge_debug,
                "recall_time_ms": round(recall_time * 1000),
                "judge_time_ms": round(judge_time * 1000),
                "top_chunks": [r.content[:200] for r in recalled[:5]],
            }
            log_file.write(json.dumps(entry) + "\n")
            log_file.flush()

        adapter.cleanup(namespace=namespace)
        processed += 1
        if processed % 5 == 0 or processed == total_samples:
            acc = correct / max(total_q, 1) * 100
            ret = retrieval_hits / max(total_q, 1) * 100
            print(f"    [{processed}/{total_samples}] Judge: {acc:.1f}% | Retrieval: {ret:.1f}% | Logged: {total_q} questions")

    log_file.close()
    adapter.close()

    # Summary
    print(f"\n{'='*70}")
    print(f"  Debug run complete — {total_q} questions logged to {log_path}")
    print(f"{'='*70}")
    print(f"  Judge: {correct}/{total_q} ({correct/max(total_q,1)*100:.1f}%)")
    print(f"  Retrieval: {retrieval_hits}/{total_q} ({retrieval_hits/max(total_q,1)*100:.1f}%)")
    print()
    print(f"  {'Type':<30} {'Judge':>8} {'Retr':>8} {'Total':>6}")
    print(f"  {'-'*30} {'-'*8} {'-'*8} {'-'*6}")
    for qt, d in sorted(by_type.items()):
        j = d["correct"] / max(d["total"], 1) * 100
        r = d["retrieval_hits"] / max(d["total"], 1) * 100
        print(f"  {qt:<30} {j:>6.1f}% {r:>6.1f}% {d['total']:>6}")

    # Quick failure analysis
    print(f"\n  Failure breakdown (from log):")
    log_file = open(log_path)
    failures = {"refusal": 0, "empty": 0, "llm_incorrect": 0, "llm_fallback": 0, "string_match_miss": 0}
    retrieval_ok_judge_fail = 0
    for line in log_file:
        e = json.loads(line)
        if not e["judge_correct"]:
            reason = e["judge_debug"].get("reason", "unknown")
            if "refusal" in reason:
                failures["refusal"] += 1
            elif "empty" in reason or "short" in reason:
                failures["empty"] += 1
            elif "llm_incorrect" in reason:
                failures["llm_incorrect"] += 1
            elif "fallback" in reason:
                failures["llm_fallback"] += 1
            if e["retrieval_hit"] and not e["judge_correct"]:
                retrieval_ok_judge_fail += 1
    log_file.close()

    print(f"    Retrieval OK but judge failed: {retrieval_ok_judge_fail}")
    for k, v in sorted(failures.items(), key=lambda x: -x[1]):
        if v:
            print(f"    {k}: {v}")


if __name__ == "__main__":
    run()
