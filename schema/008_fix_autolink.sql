-- ==========================================================
-- Shiba — Fix auto_link_memory to use HNSW index
-- Previous version did a full table scan with WHERE similarity > threshold.
-- This version uses ORDER BY <=> LIMIT K which hits the HNSW index.
-- ==========================================================

CREATE OR REPLACE FUNCTION auto_link_memory(
    mid UUID,
    similarity_threshold FLOAT DEFAULT 0.8,
    max_links INT DEFAULT 5
)
RETURNS INT AS $$
DECLARE
    mem_embedding vector(512);
    link_count INT := 0;
BEGIN
    SELECT embedding INTO mem_embedding FROM memories WHERE id = mid;
    IF mem_embedding IS NULL THEN RETURN 0; END IF;

    -- Use ORDER BY <=> LIMIT to leverage HNSW index (O(log n) not O(n))
    -- Then filter by threshold in the WHERE clause
    INSERT INTO memory_links (source_id, target_id, relation, strength)
    SELECT mid, sub.id, 'related'::relation_type, sub.similarity
    FROM (
        SELECT m.id,
               1 - (m.embedding::halfvec(512) <=> mem_embedding::halfvec(512)) AS similarity
        FROM memories m
        WHERE m.id != mid
          AND m.embedding IS NOT NULL
        ORDER BY m.embedding::halfvec(512) <=> mem_embedding::halfvec(512)
        LIMIT max_links * 2  -- fetch extra candidates, filter by threshold below
    ) sub
    WHERE sub.similarity > similarity_threshold
    LIMIT max_links
    ON CONFLICT (source_id, target_id, relation) DO UPDATE
        SET strength = EXCLUDED.strength;

    GET DIAGNOSTICS link_count = ROW_COUNT;
    RETURN link_count;
END;
$$ LANGUAGE plpgsql;
