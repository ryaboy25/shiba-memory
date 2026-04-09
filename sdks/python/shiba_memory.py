"""
Shiba Memory — Python SDK
==========================

Thin client for the Shiba Memory gateway API.

Usage:
    from shiba_memory import Shiba

    shiba = Shiba("http://localhost:18789", api_key="optional")

    # Store a memory
    shiba.remember("user", "My Role", "Senior engineer at ACME")

    # Search
    results = shiba.recall("what does the user do")

    # Forget
    shiba.forget(id="uuid-here")
"""

from __future__ import annotations
import json
from typing import Any, Optional
from dataclasses import dataclass, field

try:
    import httpx
    _CLIENT_CLASS = httpx.Client
except ImportError:
    import urllib.request
    _CLIENT_CLASS = None


@dataclass
class Memory:
    id: str
    type: str
    title: str
    content: str
    confidence: float = 0.5
    access_count: int = 0
    importance: float = 0.5
    tags: list[str] = field(default_factory=list)
    relevance: float = 0.0
    created_at: str = ""


class Shiba:
    """Client for the Shiba Memory gateway API."""

    def __init__(
        self,
        url: str = "http://localhost:18789",
        api_key: str = "",
        user_id: str = "default",
        agent_id: str = "default",
        timeout: int = 10,
    ):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.user_id = user_id
        self.agent_id = agent_id
        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout) if _CLIENT_CLASS else None

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-Shiba-Key"] = self.api_key
        return h

    def _post(self, path: str, body: dict) -> dict:
        if self._client:
            resp = self._client.post(f"{self.url}{path}", headers=self._headers(), json=body)
            resp.raise_for_status()
            return resp.json()
        # Fallback: urllib
        data = json.dumps(body).encode()
        req = urllib.request.Request(f"{self.url}{path}", data=data, headers=self._headers(), method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def _get(self, path: str) -> dict:
        if self._client:
            resp = self._client.get(f"{self.url}{path}", headers=self._headers())
            resp.raise_for_status()
            return resp.json()
        req = urllib.request.Request(f"{self.url}{path}", headers=self._headers())
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def _delete(self, path: str) -> dict:
        if self._client:
            resp = self._client.delete(f"{self.url}{path}", headers=self._headers())
            resp.raise_for_status()
            return resp.json()
        req = urllib.request.Request(f"{self.url}{path}", headers=self._headers(), method="DELETE")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    # ── Core Operations ──────────────────────────────────────

    def remember(
        self,
        type: str,
        title: str,
        content: str,
        tags: list[str] | None = None,
        importance: float = 0.5,
        extract: bool = False,
        auto_importance: bool = False,
        expires_in: str | None = None,
        project_path: str | None = None,
    ) -> str:
        """Store a memory. Returns memory ID."""
        body: dict[str, Any] = {
            "type": type,
            "title": title,
            "content": content,
            "importance": importance,
            "user_id": self.user_id,
            "agent_id": self.agent_id,
            "extract": extract,
            "auto_importance": auto_importance,
        }
        if tags:
            body["tags"] = tags
        if expires_in:
            body["expires_in"] = expires_in
        if project_path:
            body["project_path"] = project_path
        result = self._post("/remember", body)
        return result.get("id", "")

    def recall(
        self,
        query: str,
        type: str | None = None,
        limit: int = 5,
        tags: list[str] | None = None,
        project: str | None = None,
    ) -> list[Memory]:
        """Search memories. Returns list of Memory objects."""
        body: dict[str, Any] = {
            "query": query,
            "limit": limit,
            "user_id": self.user_id,
            "agent_id": self.agent_id,
        }
        if type:
            body["type"] = type
        if tags:
            body["tags"] = tags
        if project:
            body["project"] = project
        result = self._post("/recall", body)
        return [Memory(**{k: v for k, v in m.items() if k in Memory.__dataclass_fields__}) for m in result.get("memories", [])]

    def forget(
        self,
        id: str | None = None,
        type: str | None = None,
        older_than: str | None = None,
        low_confidence: float | None = None,
        expired: bool = False,
    ) -> int:
        """Delete memories. Returns count deleted."""
        body: dict[str, Any] = {}
        if id:
            body["id"] = id
        if type:
            body["type"] = type
        if older_than:
            body["older_than"] = older_than
        if low_confidence is not None:
            body["low_confidence"] = low_confidence
        if expired:
            body["expired"] = True
        result = self._post("/forget", body)
        return result.get("deleted", 0)

    def get(self, id: str) -> Memory | None:
        """Get a specific memory by ID."""
        try:
            result = self._get(f"/memory/{id}")
            m = result.get("memory", {})
            return Memory(**{k: v for k, v in m.items() if k in Memory.__dataclass_fields__})
        except Exception:
            return None

    # ── Graph ────────────────────────────────────────────────

    def link(self, source_id: str, target_id: str, relation: str, strength: float = 0.5) -> None:
        """Create a relationship between two memories."""
        self._post("/link", {"source_id": source_id, "target_id": target_id, "relation": relation, "strength": strength})

    def links(self, id: str) -> list[dict]:
        """Get relationships for a memory."""
        return self._get(f"/links/{id}").get("links", [])

    # ── Sessions ─────────────────────────────────────────────

    def create_session(self, session_id: str, project_path: str | None = None) -> str:
        """Create a new session."""
        body: dict[str, Any] = {"session_id": session_id, "user_id": self.user_id, "agent_id": self.agent_id}
        if project_path:
            body["project_path"] = project_path
        return self._post("/sessions", body).get("id", "")

    def end_session(self, session_id: str) -> None:
        """End a session."""
        self._post(f"/sessions/{session_id}/end", {})

    def sessions(self, limit: int = 20) -> list[dict]:
        """List recent sessions."""
        return self._get(f"/sessions?user_id={self.user_id}&limit={limit}").get("sessions", [])

    # ── Extraction ───────────────────────────────────────────

    def extract_patterns(self, message: str, role: str = "user") -> list[dict]:
        """Run Tier 1 pattern extraction on a message."""
        return self._post("/extract/patterns", {"message": message, "role": role}).get("facts", [])

    def extract_preferences(self, messages: list[dict]) -> list[dict]:
        """Run preference inference on conversation messages."""
        return self._post("/extract/preferences", {"messages": messages}).get("facts", [])

    # ── System ───────────────────────────────────────────────

    def health(self) -> dict:
        """Check gateway health."""
        return self._get("/health")

    def status(self) -> dict:
        """Get brain statistics."""
        return self._get("/status")

    def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            self._client.close()
