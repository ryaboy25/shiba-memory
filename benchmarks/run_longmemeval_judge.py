"""
Shiba LongMemEval Benchmark — LLM-as-Judge Scoring
====================================================

Uses the FULL Shiba gateway pipeline — same path as Claude Code hooks
and Hermes plugin. Gets extraction, dedup, auto-linking, confidence
scoring, and the full hybrid search pipeline.

Pipeline:
  1. Ingest via /remember (with extract=True for Tier 1 pattern extraction)
  2. Recall via /recall (full RRF + query classification + graph traversal)
  3. Feed chunks + question to Gemma 4 → generate answer
  4. Feed question + expected answer + generated answer to Gemma 4 → judge correctness
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


def extract_answer_from_reasoning(reasoning):
    """Extract the actual answer from a Gemma reasoning chain.

    Gemma's reasoning_content often looks like:
      *  Question: "..."
      *  Constraint: ...
      *  ...analysis...
      *  "Final answer here"
    or ends with a concluding sentence after the bullet analysis.
    """
    text = reasoning.strip()
    if not text:
        return text

    # Look for quoted conclusion (Gemma often wraps final answer in quotes)
    # Find the last quoted string that looks like an answer
    quotes = re.findall(r'"([^"]{3,})"', text)
    # Filter out quotes that are just echoing the question
    answer_quotes = [q for q in quotes if not q.endswith("?")]
    if answer_quotes:
        return answer_quotes[-1]

    # Look for "Answer:" or "answer:" marker
    answer_match = re.search(r'(?:^|\n)\s*\*?\s*(?:Answer|Result|Conclusion|So|Therefore)[:\s]+(.+)', text, re.IGNORECASE)
    if answer_match:
        return answer_match.group(1).strip().rstrip("*").strip()

    # Take the last non-empty line (most likely the conclusion)
    lines = [l.strip().lstrip("*").strip() for l in text.split("\n") if l.strip()]
    # Skip lines that are just restating the question or constraint
    for line in reversed(lines):
        if any(line.lower().startswith(p) for p in ["question:", "constraint:", "context:", "input:"]):
            continue
        if len(line) > 5:
            return line

    return text


def llm_chat(prompt, max_tokens=200):
    """Call llama.cpp OpenAI-compatible chat endpoint.
    Returns only the content field (actual answer), ignoring reasoning_content."""
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
    content = msg.get("content", "")
    reasoning = msg.get("reasoning_content", "")
    # Strip Gemma channel/turn artifacts
    if "<channel|>" in content:
        content = content.split("<channel|>")[-1].strip()
    content = content.replace("<end_of_turn>", "").replace("<|channel>thought\n", "").strip()
    # Fallback chain when content is empty:
    if not content.strip():
        if "<channel|>" in reasoning:
            content = reasoning.split("<channel|>")[-1].strip()
        elif reasoning.strip():
            content = reasoning.strip()
        content = content.replace("<end_of_turn>", "").strip()
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


def generate_answer(question, context_chunks, q_type=""):
    """Use LLM to answer a question given recalled context."""
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
    """Extract a canonical number from text. Returns string digit or None."""
    text = text.strip().lower()
    # Direct digit
    if text.isdigit():
        return text
    # Number word
    if text in NUM_WORDS:
        return NUM_WORDS[text]
    # Find first number in text
    for word in text.split():
        word = word.strip(".,;:!?\"'")
        if word.isdigit():
            return word
        if word in NUM_WORDS:
            return NUM_WORDS[word]
    return None


def extract_key_tokens(text):
    """Extract meaningful tokens from text, removing stop words and punctuation."""
    text = text.lower().strip().strip("\"'").strip()
    tokens = re.findall(r'[a-z0-9]+(?:\'[a-z]+)?', text)
    return {t for t in tokens if t not in STOP_WORDS and len(t) > 1}


def fuzzy_judge(expected, generated):
    """Fast token-overlap judge for factual answers. Returns (matched, reason) or (None, None) to defer to LLM."""
    expected_clean = expected.strip().strip("\"'").strip()
    gen_clean = generated.strip()

    # --- Numeric check: if expected is or starts with a number ---
    exp_num = normalize_number(expected_clean)
    if exp_num is not None:
        gen_num = normalize_number(gen_clean)
        if gen_num is not None:
            match = exp_num == gen_num
            return match, f"numeric:{'match' if match else 'mismatch'}({exp_num}vs{gen_num})"
        # Check if the number appears anywhere in generated
        num_word = NUM_DIGITS.get(exp_num, "")
        if exp_num in gen_clean or num_word in gen_clean.lower():
            return True, f"numeric:found_in_text({exp_num})"
        return None, None  # Can't find a number, defer to LLM

    # --- Short factual answer: token overlap ---
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

    # --- Defer to LLM for complex/long/ambiguous answers ---
    return None, None


def judge_answer(question, expected, generated):
    """Hybrid judge: fast fuzzy matching for factual answers, LLM for complex ones.

    Order: refusal check → exact substring → fuzzy/numeric → LLM judge
    """
    # If generated answer is empty or refusal, it's incorrect
    if not generated or len(generated.strip()) < 3:
        return False
    gen_lower = generated.lower()
    if any(p in gen_lower for p in ["i don't have", "not enough information", "no information", "cannot determine"]):
        # Exception: if expected answer also says "not enough information", it's correct
        exp_lower = expected.lower()
        if any(p in exp_lower for p in ["not enough", "information provided is not enough"]):
            return True
        return False

    # Quick string-match check: if the expected answer literally appears in the generated answer, it's correct
    expected_clean = expected.strip().strip("\"'").strip().lower()
    gen_clean = generated.strip().lower()
    if expected_clean and expected_clean in gen_clean:
        return True

    # Fuzzy judge for factual answers (numbers, short answers, entity lists)
    fuzzy_result, _reason = fuzzy_judge(expected, generated)
    if fuzzy_result is not None:
        return fuzzy_result

    # LLM judge for complex/subjective answers only
    prompt = f"""Does the Generated Answer express the same meaning as the Expected Answer for this question? Minor wording differences are OK — focus on whether the core answer matches, not exact phrasing.

Reply with exactly one word: correct or incorrect

Question: {question}
Expected: {expected}
Generated: {generated}

Verdict:"""
    result = llm_chat(prompt, max_tokens=200)
    result_lower = result.lower().strip()

    # Parse the clean content response
    if result_lower.startswith("correct"):
        return True
    if result_lower.startswith("incorrect"):
        return False

    # Fallback: count occurrences
    incorrect_count = result_lower.count("incorrect")
    correct_count = result_lower.count("correct") - incorrect_count
    return correct_count > incorrect_count


def expand_query(question):
    """Generate query reformulations for broader retrieval coverage.
    Uses simple heuristics — no LLM needed."""
    expansions = [question]  # Always include original

    q_lower = question.lower().strip()

    # Strip question framing to get core query
    # "What is my dog's name?" → "dog's name" / "my dog name"
    core = re.sub(r'^(what|who|where|when|how|which|do|did|does|is|are|was|were|have|has|had|can|could|would|should)\s+(is|are|was|were|do|does|did|has|have|had)?\s*', '', q_lower, flags=re.IGNORECASE).strip()
    core = re.sub(r'\?$', '', core).strip()
    if core and core != q_lower.rstrip('?') and len(core) > 5:
        expansions.append(core)

    # Convert questions to statements
    # "What restaurant did I recommend?" → "I recommended a restaurant"
    # "Where do I work?" → "I work at"
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

    return expansions[:3]  # Max 3 variants


def multi_query_recall(adapter, question, namespace, top_k=10):
    """Query expansion recall: run original + reformulations, merge top results."""

    seen_ids = set()
    all_results = []

    # Run original query + expansions
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

    # Sort by score, return top_k
    all_results.sort(key=lambda r: r.score, reverse=True)
    return all_results[:top_k]


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

        # ── Ingest with overlapping windows ──────────────────
        sessions = data["sessions"]
        total_sessions = len(sessions)
        for sess_idx, session in enumerate(sessions):
            if not session:
                continue

            # Temporal ordering: earlier sessions get older timestamps
            from datetime import datetime, timedelta, timezone
            base_time = datetime.now(timezone.utc) - timedelta(days=(total_sessions - sess_idx))
            created_at_str = base_time.isoformat()

            # Collect all turns for this session
            turns = []
            for turn in session:
                if isinstance(turn, dict) and turn.get("content"):
                    role = turn.get("role", "unknown")
                    turns.append(f"[{role}] {turn['content']}")

            # Strategy 1: Individual turns (for exact match retrieval)
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

            # Strategy 2: Overlapping 3-turn windows (for context-aware retrieval)
            # This captures conversational flow that single turns miss.
            # "What did you recommend?" needs the Q+A pair, not just the A.
            window_size = 3
            stride = 2  # overlap of 1 turn
            for i in range(0, len(turns), stride):
                window = turns[i:i + window_size]
                if len(window) >= 2:  # Need at least 2 turns for a meaningful window
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

            # Strategy 3: Full session summary (for high-level questions)
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

        # ── Answer questions with iterative retrieval ────────
        for q in data["questions"]:
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            # Iterative multi-hop retrieval with query expansion
            start = time.time()
            recalled = multi_query_recall(adapter, question, namespace, top_k=10)
            recall_time = time.time() - start
            results["latencies"].append(recall_time)

            # Check raw retrieval hit
            # Strip quotes from answer — LongMemEval wraps answers in literal quotes
            recalled_text = " ".join(r.content for r in recalled).lower()
            answer_clean = answer.strip().strip("\"'").strip().lower()
            if len(answer_clean) < 50:
                retrieval_hit = answer_clean in recalled_text
            else:
                answer_words = set(answer_clean.split())
                found = sum(1 for w in answer_words if w in recalled_text)
                retrieval_hit = found / max(len(answer_words), 1) >= 0.6

            if retrieval_hit:
                results["retrieval_hits"] += 1

            # Generate answer using LLM with retrieved context
            chunks = [r.content for r in recalled]
            try:
                generated = generate_answer(question, chunks, q_type=q_type)
            except Exception as e:
                generated = ""

            # Judge correctness
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
            print(f"    [{processed}/{total_samples}] LLM-Judge: {acc:.1f}% | Raw Retrieval: {ret:.1f}%")

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
