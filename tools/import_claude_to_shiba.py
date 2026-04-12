"""
Import Claude Conversations into Shiba Memory
===============================================

Takes the JSON export from the browser script and loads it into Shiba
via the gateway API. Extracts memories, stores episodes, and runs
pattern extraction on user messages.

Usage:
    python3 tools/import_claude_to_shiba.py claude_conversations_2026-04-09.json

Options:
    --gateway URL    Gateway URL (default: http://localhost:18789)
    --user-id ID     User ID for memory isolation (default: "default")
    --extract        Run Tier 1 pattern extraction on user messages
    --dry-run        Show what would be imported without storing
"""

import json
import sys
import argparse
import time
from pathlib import Path

try:
    import httpx
except ImportError:
    print("Install httpx: pip install httpx")
    sys.exit(1)


def import_conversations(
    filepath: str,
    gateway_url: str = "http://localhost:18789",
    user_id: str = "default",
    extract: bool = True,
    dry_run: bool = False,
    api_key: str = "",
):
    with open(filepath) as f:
        data = json.load(f)

    conversations = data.get("conversations", [])
    print(f"Loaded {len(conversations)} conversations ({data.get('total_messages', '?')} messages)")
    print(f"Gateway: {gateway_url}")
    print(f"User ID: {user_id}")
    print(f"Extract: {extract}")
    print(f"Dry run: {dry_run}")
    print()

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-Shiba-Key"] = api_key

    client = httpx.Client(timeout=15)
    stats = {
        "conversations": 0,
        "episodes": 0,
        "extracted": 0,
        "skipped": 0,
        "errors": 0,
    }

    for i, conv in enumerate(conversations):
        name = conv.get("name", "Untitled")
        messages = conv.get("messages", [])
        created = conv.get("created_at", "")

        if not messages:
            stats["skipped"] += 1
            continue

        print(f"  [{i+1}/{len(conversations)}] {name[:60]} ({len(messages)} msgs)")

        # Create a session
        session_id = f"claude-import-{conv.get('id', i)}"
        if not dry_run:
            try:
                client.post(f"{gateway_url}/sessions", headers=headers, json={
                    "session_id": session_id,
                    "user_id": user_id,
                    "metadata": {"source": "claude.ai", "original_name": name, "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                })
            except Exception:
                pass

        # Store conversation as episodes (batch user+assistant pairs)
        for j in range(0, len(messages), 2):
            user_msg = messages[j] if j < len(messages) else None
            asst_msg = messages[j + 1] if j + 1 < len(messages) else None

            if not user_msg:
                continue

            # Store the exchange as an episode
            content_parts = []
            if user_msg:
                content_parts.append(f"User: {user_msg['content'][:500]}")
            if asst_msg:
                content_parts.append(f"Assistant: {asst_msg['content'][:500]}")
            content = "\n".join(content_parts)

            title = f"{name[:50]} - Turn {j//2 + 1}"

            if not dry_run:
                try:
                    remember_body = {
                        "type": "episode",
                        "title": title,
                        "content": content,
                        "tags": ["claude-import", f"session-{session_id[:20]}"],
                        "user_id": user_id,
                        "source": "import",
                    }
                    # Preserve original conversation timestamp
                    if created:
                        remember_body["created_at"] = created
                    resp = client.post(f"{gateway_url}/remember", headers=headers, json=remember_body)
                    if resp.status_code == 200:
                        stats["episodes"] += 1
                except Exception as e:
                    stats["errors"] += 1

            # Extract patterns from user messages
            if extract and user_msg and user_msg.get("content"):
                user_text = user_msg["content"]
                if len(user_text) > 20:
                    if not dry_run:
                        try:
                            resp = client.post(f"{gateway_url}/extract/patterns", headers=headers, json={
                                "message": user_text[:3000],
                                "role": "user",
                            })
                            if resp.status_code == 200:
                                result = resp.json()
                                stats["extracted"] += result.get("count", 0)
                        except Exception:
                            pass

        # Store conversation summary as a project memory
        user_messages = [m for m in messages if m.get("role") == "user"]
        if len(user_messages) >= 3:
            summary_content = f"Claude conversation: {name}. {len(messages)} messages. "
            summary_content += f"Topics: {user_messages[0]['content'][:100]}..."

            if not dry_run:
                try:
                    summary_body = {
                        "type": "episode",
                        "title": f"Session: {name[:80]}",
                        "content": summary_content[:500],
                        "tags": ["claude-import", "session-summary"],
                        "user_id": user_id,
                        "source": "import",
                        "importance": 0.4,
                    }
                    if created:
                        summary_body["created_at"] = created
                    client.post(f"{gateway_url}/remember", headers=headers, json=summary_body)
                except Exception:
                    pass

        # End session
        if not dry_run:
            try:
                client.post(f"{gateway_url}/sessions/{session_id}/end", headers=headers, json={})
            except Exception:
                pass

        stats["conversations"] += 1

        # Progress throttle
        if not dry_run and i % 10 == 9:
            time.sleep(0.5)

    client.close()

    print(f"\n{'DRY RUN — ' if dry_run else ''}Import complete!")
    print(f"  Conversations: {stats['conversations']}")
    print(f"  Episodes stored: {stats['episodes']}")
    print(f"  Facts extracted: {stats['extracted']}")
    print(f"  Skipped (empty): {stats['skipped']}")
    print(f"  Errors: {stats['errors']}")

    if dry_run:
        print("\nRun without --dry-run to actually import.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import Claude conversations into Shiba Memory")
    parser.add_argument("file", help="Path to exported conversations JSON")
    parser.add_argument("--gateway", default="http://localhost:18789", help="Gateway URL")
    parser.add_argument("--user-id", default="default", help="User ID for isolation")
    parser.add_argument("--api-key", default="", help="Shiba API key")
    parser.add_argument("--extract", action="store_true", default=True, help="Run pattern extraction")
    parser.add_argument("--no-extract", action="store_false", dest="extract", help="Skip extraction")
    parser.add_argument("--dry-run", action="store_true", help="Preview without importing")

    args = parser.parse_args()

    if not Path(args.file).exists():
        print(f"File not found: {args.file}")
        sys.exit(1)

    import_conversations(
        filepath=args.file,
        gateway_url=args.gateway,
        user_id=args.user_id,
        extract=args.extract,
        dry_run=args.dry_run,
        api_key=args.api_key,
    )
