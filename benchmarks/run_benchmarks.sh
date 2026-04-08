#!/bin/bash
# Shiba Benchmark Runner
# ======================
# Runs standard AI memory benchmarks against Shiba.
#
# Prerequisites:
#   1. PostgreSQL + pgvector running (docker compose up -d)
#   2. Ollama running with nomic-embed-text (or set SHB_EMBEDDING_PROVIDER=openai)
#   3. pip install -e ".[bench]"  (for mem-bench)
#   OR: pip install -e ".[standalone]"  (for standalone runner)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Shiba Memory System Benchmarks"
echo "============================================"
echo ""

# Check database connectivity
echo "Checking database..."
python3 -c "
import psycopg2
from shiba_adapter import DB_CONFIG
conn = psycopg2.connect(**DB_CONFIG)
cur = conn.cursor()
cur.execute('SELECT 1')
print('  ✓ Database connected')
conn.close()
" || { echo "  ✗ Database not reachable. Run: docker compose up -d"; exit 1; }

# Check embedding service
echo "Checking embedding service..."
python3 -c "
from shiba_adapter import embed
vec = embed('test')
assert len(vec) == 512, f'Expected 512 dims, got {len(vec)}'
print(f'  ✓ Embeddings working ({len(vec)} dims)')
" || { echo "  ✗ Embedding service not available"; exit 1; }

echo ""

# Try mem-bench first, fall back to standalone
if python3 -c "import mem_bench" 2>/dev/null; then
    echo "Using mem-bench framework"
    echo ""

    echo "── LoCoMo Benchmark ──"
    mem-bench run --adapter shiba_adapter:ShibaAdapter --benchmark locomo 2>&1 | tee results/locomo.txt
    echo ""

    echo "── LongMemEval Benchmark ──"
    mem-bench run --adapter shiba_adapter:ShibaAdapter --benchmark longmemeval --split oracle --limit 50 2>&1 | tee results/longmemeval.txt
    echo ""

    echo "── HaluMem Benchmark ──"
    mem-bench run --adapter shiba_adapter:ShibaAdapter --benchmark halumem 2>&1 | tee results/halumem.txt
    echo ""

    echo "── Comparison ──"
    mem-bench compare results/ --format markdown 2>&1 | tee results/comparison.md
else
    echo "mem-bench not installed, using standalone runner"
    echo "(Install with: pip install mem-bench)"
    echo ""

    mkdir -p results

    echo "── LoCoMo Benchmark (standalone) ──"
    python3 shiba_adapter.py locomo 2>&1 | tee results/locomo_standalone.txt
fi

echo ""
echo "============================================"
echo "  Benchmarks complete! Results in results/"
echo "============================================"
