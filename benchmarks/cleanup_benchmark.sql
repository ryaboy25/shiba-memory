-- Clean all benchmark data from previous runs
-- Run with: docker exec -i shiba-postgres psql -U shb -d shb < benchmarks/cleanup_benchmark.sql

BEGIN;

-- Delete benchmark memories and their links (CASCADE handles memory_links)
DELETE FROM memories WHERE source = 'benchmark';

-- Delete extraction artifacts from benchmark runs
DELETE FROM memories WHERE source = 'extraction' AND tags && ARRAY['benchmark'];

-- Delete any namespace-tagged benchmark data that slipped through
DELETE FROM memories WHERE tags && ARRAY(
    SELECT DISTINCT unnest(tags) FROM memories
    WHERE tags::text LIKE '%lme-%' OR tags::text LIKE '%locomo-%' OR tags::text LIKE '%halu-%' OR tags::text LIKE '%diag-%'
);

-- Clean up orphaned hash entries
DELETE FROM recent_memory_hashes WHERE memory_id NOT IN (SELECT id FROM memories);

-- Clean up orphaned entity links
DELETE FROM memory_entities WHERE memory_id NOT IN (SELECT id FROM memories);

-- Vacuum to reclaim space
VACUUM ANALYZE memories;
VACUUM ANALYZE memory_links;

COMMIT;

-- Report
SELECT 'Cleanup complete' AS status, COUNT(*) AS remaining_memories FROM memories;
