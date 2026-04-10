"""
Re-extract facts from existing episode memories.
Runs Tier 2 extractFacts() on all episodes in the DB via the gateway API.

Usage:
    python3 tools/reextract_facts.py --gateway http://localhost:18789 --user-id ilya
"""

import argparse
import time
import httpx


def run(gateway_url: str, user_id: str, limit: int = 0, batch_size: int = 50):
    client = httpx.Client(timeout=30)
    headers = {"Content-Type": "application/json"}

    # Get all episodes
    print("Fetching episodes from DB...")
    import psycopg2
    import os
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

    conn = psycopg2.connect(
        host=os.getenv("SHB_DB_HOST", "localhost"),
        port=int(os.getenv("SHB_DB_PORT", "5432")),
        dbname=os.getenv("SHB_DB_NAME", "shb"),
        user=os.getenv("SHB_DB_USER", "shb"),
        password=os.getenv("SHB_DB_PASSWORD", ""),
    )
    cur = conn.cursor()

    sql = "SELECT id, content FROM memories WHERE type='episode' AND source='import' ORDER BY created_at DESC"
    if limit > 0:
        sql += f" LIMIT {limit}"
    cur.execute(sql)
    episodes = cur.fetchall()
    cur.close()
    conn.close()

    print(f"Found {len(episodes)} episodes to process")
    total_facts = 0
    errors = 0

    for i, (mem_id, content) in enumerate(episodes):
        # Split content into user/assistant parts
        parts = content.split("\nAssistant:", 1)
        user_msg = parts[0].replace("User: ", "", 1).strip() if parts else content
        asst_msg = parts[1].strip() if len(parts) > 1 else ""

        if len(user_msg) < 30:
            continue

        try:
            resp = client.post(f"{gateway_url}/extract/facts", headers=headers, json={
                "user_message": user_msg[:2000],
                "assistant_message": asst_msg[:2000],
                "user_id": user_id,
            })
            if resp.status_code == 200:
                data = resp.json()
                count = data.get("count", 0)
                total_facts += count
                if count > 0 and i % 10 == 0:
                    facts_preview = [f["title"][:50] for f in data.get("facts", [])[:2]]
                    print(f"  [{i+1}/{len(episodes)}] +{count} facts: {facts_preview}")
            else:
                errors += 1
        except Exception as e:
            errors += 1
            if i < 3:
                print(f"  Error: {e}")

        if i % 50 == 49:
            print(f"  [{i+1}/{len(episodes)}] {total_facts} facts extracted so far ({errors} errors)")

        # Small delay to not overwhelm the LLM
        time.sleep(0.5)

    client.close()
    print(f"\nDone! Extracted {total_facts} facts from {len(episodes)} episodes ({errors} errors)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--gateway", default="http://localhost:18789")
    parser.add_argument("--user-id", default="default")
    parser.add_argument("--limit", type=int, default=0, help="Limit episodes to process (0=all)")
    args = parser.parse_args()
    run(args.gateway, args.user_id, args.limit)
