"""
Shiba Benchmark Adapter
=======================

Adapter that connects Shiba's PostgreSQL+pgvector memory system to standard
memory benchmarks (LoCoMo, LongMemEval, HaluMem) via mem-bench or standalone.

Shiba's competitive advantages tested here:
  - Hybrid search (semantic + full-text fusion with ACT-R decay)
  - Halfvec indexing (50% memory savings)
  - Auto-linking (knowledge graph relationships)
  - Confidence scoring
"""

import os
import json
import time
import hashlib
from typing import Any, Sequence
from dataclasses import dataclass, field

import httpx
import psycopg2
from dotenv import load_dotenv

# Load .env from Shiba project root
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_root, ".env"))


# ── Config ──────────────────────────────────────────────────────

DB_CONFIG = {
    "host": os.getenv("SHB_DB_HOST", "localhost"),
    "port": int(os.getenv("SHB_DB_PORT", "5432")),
    "dbname": os.getenv("SHB_DB_NAME", "shb"),
    "user": os.getenv("SHB_DB_USER", "shb"),
    "password": os.getenv("SHB_DB_PASSWORD", "shb_dev_password"),
}

EMBEDDING_PROVIDER = os.getenv("SHB_EMBEDDING_PROVIDER", "ollama")
OLLAMA_URL = os.getenv("SHB_OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("SHB_OLLAMA_MODEL", "nomic-embed-text")
OPENAI_API_KEY = os.getenv("SHB_OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("SHB_OPENAI_MODEL", "text-embedding-3-small")
DIMENSIONS = int(os.getenv("SHB_EMBED_DIMENSIONS", "1024"))


# ── Embedding ───────────────────────────────────────────────────

def _embed_ollama(text: str, retries: int = 2) -> list[float]:
    for attempt in range(retries + 1):
        try:
            resp = httpx.post(
                f"{OLLAMA_URL}/api/embed",
                json={"model": OLLAMA_MODEL, "input": text, "options": {"num_ctx": 8192}},
                timeout=60,
            )
            resp.raise_for_status()
            vec = resp.json()["embeddings"][0]
            return _normalize(vec[:DIMENSIONS] if len(vec) >= DIMENSIONS else vec + [0.0] * (DIMENSIONS - len(vec)))
        except httpx.HTTPStatusError as e:
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            print(f"Ollama 400 response body: {e.response.text}")
            print(f"Input text length: {len(text)}, first 100 chars: {text[:100]!r}")
            raise


def _embed_openai(text: str) -> list[float]:
    resp = httpx.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={"model": OPENAI_MODEL, "input": text, "dimensions": DIMENSIONS},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def _normalize(vec: list[float]) -> list[float]:
    mag = sum(v * v for v in vec) ** 0.5 or 1.0
    return [v / mag for v in vec]


def embed(text: str) -> list[float]:
    if not text or not text.strip():
        return [0.0] * DIMENSIONS
    if EMBEDDING_PROVIDER == "openai":
        return _embed_openai(text)
    return _embed_ollama(text)


def pg_vector(vec: list[float]) -> str:
    return "[" + ",".join(str(v) for v in vec) + "]"


# ── Data classes for mem-bench compatibility ────────────────────

@dataclass
class IngestItem:
    content: str
    document_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str | None = None
    created_at: str | None = None  # Override created_at for temporal ordering


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


# ── Shiba Adapter ───────────────────────────────────────────────

class ShibaAdapter:
    """
    mem-bench compatible adapter for Shiba.

    Maps benchmark operations to Shiba's PostgreSQL+pgvector backend,
    using the full hybrid search pipeline (semantic + FTS + ACT-R decay).
    """

    def __init__(self) -> None:
        self._conn: psycopg2.extensions.connection | None = None

    @property
    def conn(self) -> psycopg2.extensions.connection:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg2.connect(**DB_CONFIG)
            self._conn.autocommit = True
        return self._conn

    def ingest(
        self,
        items: Sequence[IngestItem] | Sequence[dict[str, Any]],
        *,
        namespace: str = "default",
    ) -> None:
        """Store items into Shiba memories table."""
        cur = self.conn.cursor()
        for item in items:
            if isinstance(item, dict):
                item = IngestItem(**item)

            doc_id = item.document_id or hashlib.sha256(item.content.encode()).hexdigest()[:16]
            title = item.metadata.get("title", doc_id)
            mem_type = item.metadata.get("type", "episode")
            tags = item.metadata.get("tags", [namespace])
            if namespace not in tags:
                tags.append(namespace)

            vec = embed(f"{title} {item.content}")

            # Set confidence based on speaker role (Phase 1A)
            role = item.metadata.get("role", "unknown")
            if role == "user":
                confidence = 0.9
            elif role == "assistant":
                confidence = 0.7
            else:
                confidence = 0.5

            # Build INSERT with optional created_at override (Phase 2B)
            if item.created_at:
                cur.execute(
                    """INSERT INTO memories (type, title, content, embedding, tags, importance, confidence, source, profile, metadata, created_at)
                       VALUES (%s, %s, %s, %s::vector, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT DO NOTHING""",
                    [
                        mem_type, title[:200], item.content, pg_vector(vec), tags,
                        item.metadata.get("importance", 0.5), confidence,
                        "benchmark", "global",
                        json.dumps({"document_id": doc_id, "namespace": namespace, "timestamp": item.timestamp}),
                        item.created_at,
                    ],
                )
            else:
                cur.execute(
                    """INSERT INTO memories (type, title, content, embedding, tags, importance, confidence, source, profile, metadata)
                       VALUES (%s, %s, %s, %s::vector, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT DO NOTHING""",
                    [
                        mem_type, title[:200], item.content, pg_vector(vec), tags,
                        item.metadata.get("importance", 0.5), confidence,
                        "benchmark", "global",
                        json.dumps({"document_id": doc_id, "namespace": namespace, "timestamp": item.timestamp}),
                    ],
                )

            # Auto-link newly inserted memory
            cur.execute("SELECT id FROM memories WHERE content = %s ORDER BY created_at DESC LIMIT 1", [item.content])
            row = cur.fetchone()
            if row:
                cur.execute("SELECT auto_link_memory(%s)", [row[0]])

        cur.close()

    def recall(
        self,
        query: RecallQuery | dict[str, Any],
        *,
        namespace: str = "default",
    ) -> list[RecallResult]:
        """Search Shiba using full hybrid search pipeline."""
        if isinstance(query, dict):
            query = RecallQuery(**query)

        vec = embed(query.query)
        cur = self.conn.cursor()

        # Use Shiba's scoped_recall with 5-channel RRF (schema 014)
        filter_tags = [namespace] if namespace != "default" else None
        cur.execute(
            """SELECT id, type, title, content, metadata, tags, profile, project_path, relevance, created_at
               FROM scoped_recall(%s::vector, %s, %s, NULL, NULL, NULL, %s, 0.5, 0.5, 0.3, 'fast', NULL, NULL, NULL, NULL)""",
            [pg_vector(vec), query.query, query.top_k, filter_tags],
        )

        results = []
        for row in cur.fetchall():
            mem_id, mem_type, title, content, metadata, tags, profile, project_path, relevance, created_at = row
            doc_id = ""
            if metadata and isinstance(metadata, dict):
                doc_id = metadata.get("document_id", str(mem_id))
            else:
                doc_id = str(mem_id)

            results.append(RecallResult(
                document_id=doc_id,
                content=content,
                score=float(relevance) if relevance else 0.0,
                metadata={"type": mem_type, "title": title, "tags": tags or []},
            ))

        cur.close()
        return results

    def cleanup(self, *, namespace: str = "default") -> None:
        """Delete all data in a namespace."""
        cur = self.conn.cursor()
        cur.execute("DELETE FROM memories WHERE tags @> %s", [[namespace]])
        cur.close()

    def close(self) -> None:
        if self._conn and not self._conn.closed:
            self._conn.close()


# ── Standalone benchmark runner ─────────────────────────────────

def run_standalone_locomo():
    """Run LoCoMo benchmark without mem-bench dependency."""
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install 'datasets' package: pip install datasets")
        return

    print("Loading LoCoMo dataset...")
    ds = load_dataset("Aman279/Locomo", split="train")

    adapter = ShibaAdapter()
    results = {"total": 0, "correct": 0, "by_category": {}}

    for conv_idx, conv in enumerate(ds):
        namespace = f"locomo-{conv_idx}"
        adapter.cleanup(namespace=namespace)

        conversation = conv.get("conversation", {})
        for session_key, session_data in conversation.items():
            if not isinstance(session_data, list):
                continue
            for turn in session_data:
                if isinstance(turn, dict) and "content" in turn:
                    adapter.ingest(
                        [IngestItem(
                            content=turn["content"],
                            metadata={"title": f"{session_key} turn", "type": "episode"},
                            timestamp=turn.get("timestamp"),
                        )],
                        namespace=namespace,
                    )

        qa_list = conv.get("qa", [])
        for qa in qa_list:
            question = qa.get("question", "")
            expected = qa.get("answer", "")
            category = qa.get("category", "unknown")

            recalled = adapter.recall(
                RecallQuery(query=question, top_k=5),
                namespace=namespace,
            )

            recalled_text = " ".join(r.content for r in recalled)
            is_correct = expected.lower().strip() in recalled_text.lower()

            results["total"] += 1
            if is_correct:
                results["correct"] += 1

            cat_key = str(category)
            if cat_key not in results["by_category"]:
                results["by_category"][cat_key] = {"total": 0, "correct": 0}
            results["by_category"][cat_key]["total"] += 1
            if is_correct:
                results["by_category"][cat_key]["correct"] += 1

        adapter.cleanup(namespace=namespace)
        print(f"  Conversation {conv_idx + 1}/{len(ds)} done")

    adapter.close()

    print("\n" + "=" * 60)
    print("Shiba LoCoMo Benchmark Results")
    print("=" * 60)
    overall = results["correct"] / max(results["total"], 1) * 100
    print(f"Overall: {overall:.1f}% ({results['correct']}/{results['total']})")
    print()
    cat_names = {
        "1": "Single-Hop",
        "2": "Temporal",
        "3": "Multi-Hop",
        "4": "Open-Domain",
        "5": "Adversarial",
    }
    for cat, data in sorted(results["by_category"].items()):
        name = cat_names.get(cat, f"Category {cat}")
        acc = data["correct"] / max(data["total"], 1) * 100
        print(f"  {name}: {acc:.1f}% ({data['correct']}/{data['total']})")

    return results


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "locomo":
        run_standalone_locomo()
    else:
        print("Usage: python shiba_adapter.py locomo")
        print("Or use with mem-bench: mem-bench run --adapter shiba_adapter:ShibaAdapter --benchmark locomo")
