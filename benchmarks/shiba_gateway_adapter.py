"""
Shiba Gateway Adapter
=====================

Benchmark adapter that uses the full Shiba gateway API — same path as
Hermes and Claude Code. Gets extraction, dedup, auto-linking, confidence
scoring, and the full hybrid search pipeline.

This is how Mem0, Honcho, and Supermemory benchmark: through their
production API, not raw database access.
"""

import os
import json
import hashlib
from typing import Any, Sequence
from dataclasses import dataclass, field

import httpx
from dotenv import load_dotenv

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_root, ".env"))

GATEWAY_URL = os.getenv("SHIBA_GATEWAY_URL", "http://localhost:18789")
API_KEY = os.getenv("SHB_API_KEY", "")


@dataclass
class IngestItem:
    content: str
    document_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str | None = None
    created_at: str | None = None


@dataclass
class RecallQuery:
    query: str
    top_k: int = 10
    metadata_filter: dict[str, Any] | None = None


@dataclass
class RecallResult:
    document_id: str
    content: str
    score: float
    metadata: dict[str, Any] = field(default_factory=dict)


class ShibaGatewayAdapter:
    """
    Benchmark adapter using the full Shiba gateway API.
    Same path as Hermes plugin and Claude Code hooks.
    """

    def __init__(self) -> None:
        self._client = httpx.Client(timeout=30)

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if API_KEY:
            h["X-Shiba-Key"] = API_KEY
        return h

    def _post(self, path: str, body: dict) -> dict:
        resp = self._client.post(f"{GATEWAY_URL}{path}", headers=self._headers(), json=body)
        resp.raise_for_status()
        return resp.json()

    def ingest(
        self,
        items: Sequence[IngestItem] | Sequence[dict[str, Any]],
        *,
        namespace: str = "default",
    ) -> None:
        """Store items via gateway /remember — gets dedup, auto-linking, extraction."""
        for item in items:
            if isinstance(item, dict):
                item = IngestItem(**item)

            title = item.metadata.get("title", "benchmark")
            mem_type = item.metadata.get("type", "episode")
            importance = item.metadata.get("importance", 0.5)
            tags = item.metadata.get("tags", [namespace])
            if namespace not in tags:
                tags.append(namespace)

            body: dict[str, Any] = {
                "type": mem_type,
                "title": title[:200],
                "content": item.content,
                "tags": tags,
                "importance": importance,
                "confidence": 0.95,  # High confidence for all benchmark data
                "source": "benchmark",
                "extract": True,  # Enable Tier 1 pattern extraction
                "auto_importance": False,  # Skip LLM importance to save time
            }

            # Pass through created_at for temporal ordering
            if item.created_at:
                body["created_at"] = item.created_at

            try:
                self._post("/remember", body)
            except Exception:
                pass  # Skip failures silently

    def recall(
        self,
        query: RecallQuery | dict[str, Any],
        *,
        namespace: str = "default",
    ) -> list[RecallResult]:
        """Search via gateway /recall — gets full hybrid search + scoring."""
        if isinstance(query, dict):
            query = RecallQuery(**query)

        body: dict[str, Any] = {
            "query": query.query,
            "limit": query.top_k,
        }

        # Add tag filter for namespace isolation
        if namespace != "default":
            body["tags"] = [namespace]

        try:
            result = self._post("/recall", body)
        except Exception:
            return []

        results = []
        for m in result.get("memories", []):
            results.append(RecallResult(
                document_id=m.get("id", ""),
                content=m.get("content", ""),
                score=float(m.get("relevance", 0)),
                metadata={"type": m.get("type", ""), "title": m.get("title", "")},
            ))

        return results

    def cleanup(self, *, namespace: str = "default") -> None:
        """Delete all memories with the given namespace tag."""
        try:
            import psycopg2
            DB_CONFIG = {
                "host": os.getenv("SHB_DB_HOST", "localhost"),
                "port": int(os.getenv("SHB_DB_PORT", "5432")),
                "dbname": os.getenv("SHB_DB_NAME", "shb"),
                "user": os.getenv("SHB_DB_USER", "shb"),
                "password": os.getenv("SHB_DB_PASSWORD", ""),
            }
            conn = psycopg2.connect(**DB_CONFIG)
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute("DELETE FROM memories WHERE tags @> %s", [[namespace]])
            cur.close()
            conn.close()
        except Exception:
            pass

    def close(self) -> None:
        self._client.close()
