"""
Shiba Memory Provider for Hermes Agent
=======================================

Integrates Shiba's persistent memory system with Hermes via the
MemoryProvider plugin interface. Connects to Shiba's HTTP gateway API.

Features exposed to Hermes:
  - Hybrid semantic + full-text search (recall)
  - Memory storage with auto-linking (remember)
  - Instinct capture (low-confidence observations that evolve into skills)
  - Knowledge graph traversal (related memories)
  - Session context injection (prefetch)
  - Automatic conversation persistence (sync_turn)
"""

import json
import os
import threading
from pathlib import Path

try:
    import httpx
except ImportError:
    httpx = None


class ShibaMemoryProvider:
    """Shiba memory provider for Hermes agent."""

    TOOL_SCHEMAS = [
        {
            "type": "function",
            "function": {
                "name": "shiba_recall",
                "description": "Search Shiba's persistent memory using hybrid semantic + full-text search. Returns the most relevant memories ranked by meaning, access frequency, confidence, and knowledge graph connections.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural language search query",
                        },
                        "type": {
                            "type": "string",
                            "enum": ["user", "feedback", "project", "reference", "episode", "skill", "instinct"],
                            "description": "Filter by memory type (optional)",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max results to return (default 5)",
                            "default": 5,
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "shiba_remember",
                "description": "Store a new memory in Shiba. Memories are automatically embedded, indexed, and linked to related memories via the knowledge graph.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["user", "feedback", "project", "reference", "skill", "instinct"],
                            "description": "Memory type. Use 'user' for identity/preferences, 'feedback' for corrections, 'project' for goals/decisions, 'reference' for external pointers, 'skill' for learned procedures, 'instinct' for low-confidence observations.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Short title for the memory",
                        },
                        "content": {
                            "type": "string",
                            "description": "Full memory content",
                        },
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Tags for categorization (optional)",
                        },
                        "importance": {
                            "type": "number",
                            "description": "Importance 0.0-1.0 (default 0.5)",
                            "default": 0.5,
                        },
                    },
                    "required": ["type", "title", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "shiba_forget",
                "description": "Delete a specific memory by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Memory UUID to delete",
                        },
                    },
                    "required": ["id"],
                },
            },
        },
    ]

    @property
    def name(self):
        return "shiba"

    def is_available(self):
        """Check if Shiba is configured (no network calls)."""
        if httpx is None:
            return False
        config = self._load_config()
        return bool(config.get("endpoint"))

    def initialize(self, session_id, **kwargs):
        """Called at Hermes agent startup."""
        self.session_id = session_id
        self.hermes_home = kwargs.get("hermes_home", os.path.expanduser("~/.hermes"))
        config = self._load_config()
        self.endpoint = config.get("endpoint", "http://localhost:18789")
        self.api_key = config.get("api_key", "")
        self.project = config.get("project", "")
        self._client = httpx.Client(timeout=10)

    def get_tool_schemas(self):
        """Return tool schemas for Hermes to expose to the LLM."""
        return self.TOOL_SCHEMAS

    def handle_tool_call(self, tool_name, args):
        """Route tool calls to Shiba gateway API."""
        try:
            if tool_name == "shiba_recall":
                return self._recall(args)
            elif tool_name == "shiba_remember":
                return self._remember(args)
            elif tool_name == "shiba_forget":
                return self._forget(args)
            else:
                return json.dumps({"success": False, "error": f"Unknown tool: {tool_name}"})
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})

    def get_config_schema(self):
        """Define setup fields for `hermes memory setup`."""
        return [
            {"key": "endpoint", "description": "Shiba gateway URL", "default": "http://localhost:18789"},
            {"key": "api_key", "description": "Shiba API key (leave empty if no auth)", "secret": True, "default": ""},
            {"key": "project", "description": "Project name for scoped memories (optional)", "default": ""},
        ]

    def save_config(self, values, hermes_home):
        """Persist Shiba config to disk."""
        config_path = Path(hermes_home) / "plugins" / "shiba" / "config.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(values, indent=2))

    def system_prompt_block(self):
        """Inject Shiba context into the system prompt."""
        return (
            "You have access to Shiba, a persistent memory system with hybrid semantic search, "
            "knowledge graphs, and self-improving memory. Use shiba_recall to search past context, "
            "shiba_remember to store important information (user preferences, decisions, learned patterns), "
            "and shiba_forget to remove outdated memories. Memories persist across all sessions and "
            "automatically link to related knowledge."
        )

    def prefetch(self, query, **kwargs):
        """Recall relevant context before each turn."""
        try:
            body = {"query": query, "limit": 3}
            if self.project:
                body["project"] = self.project
            resp = self._post("/recall", body)
            memories = resp.get("memories", [])
            if not memories:
                return ""

            lines = []
            for m in memories:
                lines.append(f"[{m['type']}] {m['title']}: {m['content'][:200]}")
            return "<shiba-context>\n" + "\n".join(lines) + "\n</shiba-context>"
        except Exception:
            return ""

    def queue_prefetch(self, query, **kwargs):
        """Pre-warm cache after turns (non-blocking)."""
        # Prefetch is fast enough via gateway, no need for background thread
        pass

    def sync_turn(self, user_content, assistant_content, **kwargs):
        """Persist conversation turn + run extraction (non-blocking)."""
        def _sync():
            try:
                # Store as short-lived episode
                self._post("/remember", {
                    "type": "episode",
                    "title": "Conversation turn",
                    "content": f"User: {user_content[:300]}\nAssistant: {assistant_content[:300]}",
                    "tags": ["hermes-session", f"session-{self.session_id}"],
                    "importance": 0.3,
                    "source": "hermes-hook",
                    "expires_in": "7d",
                })

                # Tier 1: Pattern extraction on user message (auto-stores via endpoint)
                if user_content and len(user_content) > 10:
                    try:
                        self._post("/extract/patterns", {
                            "message": user_content[:2000],
                            "role": "user",
                        })
                    except Exception:
                        pass  # Extraction is best-effort

                # Tier 2: Correction detection + extraction
                correction_signals = ["no,", "no ", "wrong", "actually", "not right", "instead", "fix ", "change "]
                if any(user_content.lower().strip().startswith(s) for s in correction_signals):
                    try:
                        self._post("/extract/correction", {
                            "user_message": user_content[:2000],
                            "assistant_message": assistant_content[:2000],
                        })
                    except Exception:
                        pass  # LLM may not be configured

            except Exception:
                pass  # Non-blocking, don't crash

        thread = threading.Thread(target=_sync, daemon=True)
        thread.start()

    def on_session_end(self, messages, **kwargs):
        """Extract key insights when session closes — Tier 2 summarization."""
        try:
            user_msgs = [m for m in messages if m.get("role") == "user"]
            if len(user_msgs) < 2:
                return  # Too short to summarize

            # Tier 2: Call extraction summarize endpoint (auto-stores via endpoint)
            try:
                recent = messages[-30:]  # Last 30 messages
                self._post("/extract/summarize", {
                    "messages": [{"role": m.get("role", "user"), "content": str(m.get("content", ""))[:300]} for m in recent],
                    "project": self.project or None,
                })
            except Exception:
                # Fallback: store basic summary if LLM extraction fails
                self._post("/remember", {
                    "type": "episode",
                    "title": "Hermes session summary",
                    "content": f"Session {self.session_id}: {len(messages)} messages, {len(user_msgs)} user turns.",
                    "tags": ["hermes-session", "session-summary"],
                    "importance": 0.4,
                    "source": "hermes-hook",
                    "expires_in": "30d",
                })
        except Exception:
            pass

    def on_pre_compress(self, messages, **kwargs):
        """Save context before Hermes compresses conversation."""
        try:
            # Extract last few user messages as context snapshot
            user_msgs = [m["content"] for m in messages if m.get("role") == "user" and isinstance(m.get("content"), str)]
            if not user_msgs:
                return

            recent = user_msgs[-3:]
            self._post("/remember", {
                "type": "episode",
                "title": "Pre-compression context snapshot",
                "content": "Recent user messages:\n" + "\n".join(recent),
                "tags": ["hermes-session", "pre-compress"],
                "importance": 0.5,
                "source": "hermes-hook",
                "expires_in": "14d",
            })
        except Exception:
            pass

    def on_memory_write(self, action, target, content):
        """Mirror built-in MEMORY.md writes to Shiba."""
        try:
            if action == "add":
                self._post("/remember", {
                    "type": "user" if target == "USER.md" else "project",
                    "title": f"Hermes {target} entry",
                    "content": content[:1000],
                    "tags": ["hermes-builtin-mirror", target.lower().replace(".md", "")],
                    "importance": 0.7,
                    "source": "hermes-hook",
                })
        except Exception:
            pass

    def shutdown(self):
        """Cleanup on process exit."""
        if hasattr(self, "_client") and self._client:
            self._client.close()

    # ── Private helpers ──────────────────────────────────────

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-Shiba-Key"] = self.api_key
        return h

    def _post(self, path, body):
        resp = self._client.post(
            f"{self.endpoint}{path}",
            headers=self._headers(),
            json=body,
        )
        resp.raise_for_status()
        return resp.json()

    def _delete(self, path):
        resp = self._client.delete(
            f"{self.endpoint}{path}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    def _recall(self, args):
        body = {"query": args["query"], "limit": args.get("limit", 5)}
        if args.get("type"):
            body["type"] = args["type"]
        if self.project:
            body["project"] = self.project
        result = self._post("/recall", body)
        memories = result.get("memories", [])
        formatted = []
        for m in memories:
            formatted.append({
                "id": m["id"],
                "type": m["type"],
                "title": m["title"],
                "content": m["content"],
                "relevance": m.get("relevance", 0),
                "tags": m.get("tags", []),
            })
        return json.dumps({"success": True, "count": len(formatted), "memories": formatted})

    def _remember(self, args):
        body = {
            "type": args["type"],
            "title": args["title"],
            "content": args["content"],
            "source": "hermes",
        }
        if args.get("tags"):
            body["tags"] = args["tags"]
        if args.get("importance"):
            body["importance"] = args["importance"]
        if self.project:
            body["project"] = self.project
        result = self._post("/remember", body)
        return json.dumps({"success": True, "id": result.get("id", "stored")})

    def _forget(self, args):
        result = self._delete(f"/memory/{args['id']}")
        return json.dumps({"success": True, **result})

    def _load_config(self):
        config_path = Path(
            getattr(self, "hermes_home", os.path.expanduser("~/.hermes"))
        ) / "plugins" / "shiba" / "config.json"
        if config_path.exists():
            return json.loads(config_path.read_text())
        return {"endpoint": os.getenv("SHIBA_ENDPOINT", "http://localhost:18789")}
