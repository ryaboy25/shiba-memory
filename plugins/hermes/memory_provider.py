"""
Shiba Memory Provider for Hermes Agent
=======================================

Integrates Shiba's persistent memory system with Hermes via the
MemoryProvider plugin interface. Connects to Shiba's HTTP gateway API.

Config via $HERMES_HOME/plugins/shiba/config.json:
  endpoint  — Shiba gateway URL (default: http://localhost:18789)
  api_key   — Optional API key for auth
  project   — Optional project scope
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

try:
    import httpx
except ImportError:
    httpx = None


# ---------------------------------------------------------------------------
# Tool schemas (Hermes format: name/description/parameters dicts)
# ---------------------------------------------------------------------------

RECALL_SCHEMA = {
    "name": "shiba_recall",
    "description": (
        "Search Shiba's persistent memory using hybrid semantic + full-text search. "
        "Returns memories ranked by meaning, access frequency, and confidence."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural language search query"},
            "type": {
                "type": "string",
                "enum": ["user", "feedback", "project", "reference", "episode", "skill"],
                "description": "Filter by memory type (optional)",
            },
            "limit": {"type": "integer", "description": "Max results (default 10)", "default": 10},
        },
        "required": ["query"],
    },
}

REMEMBER_SCHEMA = {
    "name": "shiba_remember",
    "description": (
        "Store a new memory in Shiba. Memories are automatically embedded, "
        "indexed, and linked to related memories."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "enum": ["user", "feedback", "project", "reference", "skill"],
                "description": "Memory type: user (identity/prefs), feedback (corrections), project (goals), reference (pointers), skill (procedures)",
            },
            "title": {"type": "string", "description": "Short title"},
            "content": {"type": "string", "description": "Full memory content"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Tags (optional)"},
            "importance": {"type": "number", "description": "Importance 0.0-1.0 (default 0.5)"},
        },
        "required": ["type", "title", "content"],
    },
}

FORGET_SCHEMA = {
    "name": "shiba_forget",
    "description": "Delete a specific memory by ID.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Memory UUID to delete"},
        },
        "required": ["id"],
    },
}


class ShibaMemoryProvider(MemoryProvider):
    """Shiba memory provider — persistent memory via HTTP gateway."""

    @property
    def name(self) -> str:
        return "shiba"

    def is_available(self) -> bool:
        if httpx is None:
            return False
        config = self._load_config()
        return bool(config.get("endpoint"))

    def initialize(self, session_id: str, **kwargs) -> None:
        self.session_id = session_id
        self.hermes_home = kwargs.get("hermes_home", os.path.expanduser("~/.hermes"))
        self._agent_context = kwargs.get("agent_context", "primary")
        config = self._load_config()
        self.endpoint = config.get("endpoint", "http://localhost:18789")
        self.api_key = config.get("api_key", "")
        self.project = config.get("project", "")
        self.user_id = kwargs.get("user_id", "default")
        self._client = httpx.Client(timeout=10)
        logger.info("Shiba memory initialized: endpoint=%s session=%s", self.endpoint, session_id)

    def system_prompt_block(self) -> str:
        return (
            "You have access to Shiba, a persistent memory system with hybrid semantic search "
            "and knowledge graphs. Use shiba_recall to search past context, "
            "shiba_remember to store important information (preferences, decisions, patterns), "
            "and shiba_forget to remove outdated memories. Memories persist across all sessions."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        try:
            body: Dict[str, Any] = {"query": query, "limit": 3}
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
        except Exception as e:
            logger.debug("Shiba prefetch failed: %s", e)
            return ""

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if self._agent_context != "primary":
            return  # Skip writes for subagents/cron

        def _sync():
            try:
                # Store as episode
                self._post("/remember", {
                    "type": "episode",
                    "title": "Conversation turn",
                    "content": f"User: {user_content[:300]}\nAssistant: {assistant_content[:300]}",
                    "tags": ["hermes-session", f"session-{self.session_id}"],
                    "importance": 0.3,
                    "source": "hermes-hook",
                })

                # Tier 1: Pattern extraction
                if user_content and len(user_content) > 10:
                    try:
                        self._post("/extract/patterns", {
                            "message": user_content[:2000],
                            "role": "user",
                        })
                    except Exception:
                        pass

                # Tier 2: Fact extraction
                try:
                    self._post("/extract/facts", {
                        "user_message": user_content[:2000],
                        "assistant_message": assistant_content[:2000],
                        "user_id": self.user_id,
                    })
                except Exception:
                    pass

                # Tier 2: Correction detection
                correction_signals = ["no,", "no ", "wrong", "actually", "not right", "instead", "fix ", "change "]
                if any(user_content.lower().strip().startswith(s) for s in correction_signals):
                    try:
                        self._post("/extract/correction", {
                            "user_message": user_content[:2000],
                            "assistant_message": assistant_content[:2000],
                        })
                    except Exception:
                        pass

            except Exception as e:
                logger.debug("Shiba sync_turn failed: %s", e)

        thread = threading.Thread(target=_sync, daemon=True)
        thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RECALL_SCHEMA, REMEMBER_SCHEMA, FORGET_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
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
            logger.error("Shiba tool call failed: %s %s", tool_name, e)
            return json.dumps({"success": False, "error": str(e)})

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        try:
            user_msgs = [m for m in messages if m.get("role") == "user"]
            if len(user_msgs) < 2:
                return

            try:
                recent = messages[-30:]
                self._post("/extract/summarize", {
                    "messages": [{"role": m.get("role", "user"), "content": str(m.get("content", ""))[:300]} for m in recent],
                    "project": self.project or None,
                })
            except Exception:
                self._post("/remember", {
                    "type": "episode",
                    "title": "Hermes session summary",
                    "content": f"Session {self.session_id}: {len(messages)} messages, {len(user_msgs)} user turns.",
                    "tags": ["hermes-session", "session-summary"],
                    "importance": 0.4,
                    "source": "hermes-hook",
                })
        except Exception as e:
            logger.debug("Shiba on_session_end failed: %s", e)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        try:
            user_msgs = [m["content"] for m in messages if m.get("role") == "user" and isinstance(m.get("content"), str)]
            if not user_msgs:
                return ""

            recent = user_msgs[-3:]
            self._post("/remember", {
                "type": "episode",
                "title": "Pre-compression context snapshot",
                "content": "Recent user messages:\n" + "\n".join(recent),
                "tags": ["hermes-session", "pre-compress"],
                "importance": 0.5,
                "source": "hermes-hook",
            })
        except Exception:
            pass
        return ""

    def on_memory_write(self, action: str, target: str, content: str) -> None:
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
        except Exception as e:
            logger.debug("Shiba on_memory_write failed: %s", e)

    def shutdown(self) -> None:
        if hasattr(self, "_client") and self._client:
            self._client.close()

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "endpoint", "description": "Shiba gateway URL", "default": "http://localhost:18789"},
            {"key": "api_key", "description": "Shiba API key (leave empty if no auth)", "secret": True, "env_var": "SHIBA_API_KEY", "default": ""},
            {"key": "project", "description": "Project name for scoped memories (optional)", "default": ""},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        config_path = Path(hermes_home) / "plugins" / "shiba" / "config.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(values, indent=2))

    # ── Private helpers ──────────────────────────────────────

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-Shiba-Key"] = self.api_key
        return h

    def _post(self, path, body):
        resp = self._client.post(f"{self.endpoint}{path}", headers=self._headers(), json=body)
        resp.raise_for_status()
        return resp.json()

    def _delete(self, path):
        resp = self._client.delete(f"{self.endpoint}{path}", headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    def _recall(self, args):
        body: Dict[str, Any] = {"query": args["query"], "limit": args.get("limit", 10)}
        if args.get("type"):
            body["type"] = args["type"]
        if self.project:
            body["project"] = self.project
        result = self._post("/recall", body)
        memories = result.get("memories", [])
        formatted = [{
            "id": m["id"], "type": m["type"], "title": m["title"],
            "content": m["content"], "relevance": m.get("relevance", 0),
            "tags": m.get("tags", []),
        } for m in memories]
        return json.dumps({"success": True, "count": len(formatted), "memories": formatted})

    def _remember(self, args):
        body: Dict[str, Any] = {
            "type": args["type"], "title": args["title"],
            "content": args["content"], "source": "hermes",
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
            try:
                return json.loads(config_path.read_text())
            except Exception:
                pass
        return {"endpoint": os.getenv("SHIBA_ENDPOINT", "http://localhost:18789")}
