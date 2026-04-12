"""
Diagnostic: See exactly what retrieval returns for the first 10 LongMemEval questions.
Shows the question, expected answer, and what Shiba actually recalled.
This tells us WHERE the retrieval pipeline is failing.
"""

import sys
import json
sys.path.insert(0, ".")

from shiba_adapter import ShibaAdapter, IngestItem, RecallQuery, embed, pg_vector

def run():
    from datasets import load_dataset

    print("Loading LongMemEval oracle split...")
    ds = list(load_dataset(
        "xiaowu0162/longmemeval-cleaned",
        split="longmemeval_oracle",
        streaming=True,
    ))

    adapter = ShibaAdapter()

    # Group by sample
    samples = {}
    for row in ds:
        sid = row.get("sample_id", row.get("question_id", ""))
        if sid not in samples:
            samples[sid] = {"sessions": [], "questions": []}
        if not samples[sid]["sessions"] and row.get("haystack_sessions"):
            samples[sid]["sessions"] = row["haystack_sessions"]
        samples[sid]["questions"].append(row)

    # Process first 3 samples only
    for sample_idx, (sid, data) in enumerate(list(samples.items())[:3]):
        namespace = f"diag-{sid}"
        adapter.cleanup(namespace=namespace)

        sessions = data["sessions"]
        total_turns = 0

        # Ingest (same as benchmark)
        from datetime import datetime, timedelta, timezone
        for sess_idx, session in enumerate(sessions):
            if not session:
                continue
            base_time = datetime.now(timezone.utc) - timedelta(days=(len(sessions) - sess_idx))
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
                        metadata={"title": f"S{sess_idx}T{i}", "type": "episode"},
                        created_at=created_at_str,
                    )],
                    namespace=namespace,
                )
                total_turns += 1

        print(f"\n{'='*80}")
        print(f"SAMPLE {sample_idx+1}: {sid} — {len(sessions)} sessions, {total_turns} turns ingested")
        print(f"{'='*80}")

        # Count memories in this namespace
        cur = adapter.conn.cursor()
        cur.execute("SELECT COUNT(*) FROM memories WHERE tags @> %s", [[namespace]])
        mem_count = cur.fetchone()[0]
        print(f"Memories in DB for this namespace: {mem_count}")
        cur.close()

        # Test each question
        for q in data["questions"][:5]:  # First 5 questions per sample
            question = q.get("question", "")
            answer = q.get("answer", "")
            q_type = q.get("question_type", "unknown")

            if not question or not answer:
                continue

            print(f"\n  --- Question ({q_type}) ---")
            print(f"  Q: {question}")
            print(f"  Expected: {answer}")

            # What does semantic search find?
            vec = embed(question)
            cur = adapter.conn.cursor()

            # Raw semantic search (bypass scoped_recall)
            cur.execute(
                """SELECT content,
                          1 - (embedding::halfvec(1024) <=> %s::vector::halfvec(1024)) as similarity
                   FROM memories
                   WHERE tags @> %s AND embedding IS NOT NULL
                   ORDER BY embedding::halfvec(1024) <=> %s::vector::halfvec(1024)
                   LIMIT 3""",
                [pg_vector(vec), [namespace], pg_vector(vec)]
            )
            sem_results = cur.fetchall()
            print(f"\n  Top 3 SEMANTIC results:")
            for i, (content, sim) in enumerate(sem_results):
                has_answer = answer.lower() in content.lower()
                marker = " <<<< HAS ANSWER" if has_answer else ""
                print(f"    [{i+1}] sim={sim:.4f} | {content[:120]}...{marker}")

            # Raw FTS search
            cur.execute(
                """SELECT content,
                          ts_rank_cd(fts, websearch_to_tsquery('english', %s)) as rank
                   FROM memories
                   WHERE tags @> %s AND fts @@ websearch_to_tsquery('english', %s)
                   ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', %s)) DESC
                   LIMIT 3""",
                [question, [namespace], question, question]
            )
            fts_results = cur.fetchall()
            print(f"\n  Top 3 FULL-TEXT results:")
            if not fts_results:
                print(f"    (none — FTS found nothing)")
            for i, (content, rank) in enumerate(fts_results):
                has_answer = answer.lower() in content.lower()
                marker = " <<<< HAS ANSWER" if has_answer else ""
                print(f"    [{i+1}] rank={rank:.4f} | {content[:120]}...{marker}")

            # Check: does the answer even EXIST in any memory?
            cur.execute(
                "SELECT COUNT(*) FROM memories WHERE tags @> %s AND content ILIKE %s",
                [[namespace], f"%{answer}%"]
            )
            answer_exists = cur.fetchone()[0]
            print(f"\n  Answer '{answer}' exists in {answer_exists} memories in this namespace")

            if answer_exists > 0 and not any(answer.lower() in r[0].lower() for r in sem_results):
                # The answer exists but semantic search didn't find it — show what DID contain it
                cur.execute(
                    "SELECT content FROM memories WHERE tags @> %s AND content ILIKE %s LIMIT 2",
                    [[namespace], f"%{answer}%"]
                )
                containing = cur.fetchall()
                print(f"  Memory containing the answer:")
                for (content,) in containing:
                    print(f"    → {content[:150]}")

            cur.close()

        adapter.cleanup(namespace=namespace)

    adapter.close()
    print("\n\nDiagnostic complete.")


if __name__ == "__main__":
    run()
