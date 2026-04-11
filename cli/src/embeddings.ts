const PROVIDER = process.env.SHB_EMBEDDING_PROVIDER || "ollama";
const DIMENSIONS = parseInt(process.env.SHB_EMBED_DIMENSIONS || "1024");
const EMBED_TIMEOUT = parseInt(process.env.SHB_EMBED_TIMEOUT_MS || "10000");
const EMBED_RETRIES = parseInt(process.env.SHB_EMBED_RETRIES || "2");

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/**
 * Normalize a vector to DIMENSIONS length.
 * - If vec is the right size, return as-is.
 * - If vec is too long, truncate and L2-renormalize (not just slice).
 * - If vec is too short, zero-pad then L2-renormalize to preserve direction.
 * Previous behavior: zero-pad without renormalization, which biased cosine similarity.
 */
function normalizeVec(vec: number[]): number[] {
  if (vec.length === DIMENSIONS) return vec;

  let result: number[];
  if (vec.length > DIMENSIONS) {
    result = vec.slice(0, DIMENSIONS);
  } else {
    result = [...vec, ...new Array(DIMENSIONS - vec.length).fill(0)];
  }

  // L2-renormalize to preserve direction after truncation/padding
  const mag = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < result.length; i++) result[i] /= mag;
  }

  // Warn once if dimensions don't match (likely wrong model configured)
  if (!_dimWarned && vec.length !== DIMENSIONS) {
    console.error(
      `[shiba] WARNING: Embedding model returned ${vec.length} dims, expected ${DIMENSIONS}. ` +
      `Vectors are being resized + renormalized. For best results, use a ${DIMENSIONS}-dim model.`
    );
    _dimWarned = true;
  }

  return result;
}
let _dimWarned = false;

const ollama: EmbeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const url = process.env.SHB_OLLAMA_URL || "http://localhost:11434";
    const model = process.env.SHB_OLLAMA_MODEL || "nomic-embed-text";

    const res = await fetch(`${url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT),
    });

    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return normalizeVec(data.embeddings[0]);
  },
};

const openai: EmbeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const key = process.env.SHB_OPENAI_API_KEY;
    if (!key) throw new Error("SHB_OPENAI_API_KEY is required for openai provider");

    const model = process.env.SHB_OPENAI_MODEL || "text-embedding-3-small";

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, input: text, dimensions: DIMENSIONS }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT),
    });

    if (!res.ok) {
      throw new Error(`OpenAI embed failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  },
};

// Deterministic hash-based embeddings for testing without an external provider.
// NOT suitable for production — no real semantic understanding — but the vectors
// are stable (same input → same output) so similarity search still works on
// exact and near-exact matches.
const hashtest: EmbeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const vec = new Array(DIMENSIONS).fill(0);
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      const idx = (lower.charCodeAt(i) * (i + 1) * 31) % DIMENSIONS;
      vec[idx] += 1;
    }
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    return vec.map((v: number) => v / mag);
  },
};

const providers: Record<string, EmbeddingProvider> = { ollama, openai, hashtest };

/** Embed with retry and exponential backoff. */
export async function embed(text: string): Promise<number[]> {
  const provider = providers[PROVIDER];
  if (!provider) throw new Error(`Unknown embedding provider: ${PROVIDER}`);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= EMBED_RETRIES; attempt++) {
    try {
      return await provider.embed(text);
    } catch (e) {
      lastError = e as Error;
      if (attempt < EMBED_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // If primary provider fails and we have a fallback configured, try it
  const fallback = process.env.SHB_EMBEDDING_FALLBACK;
  if (fallback && fallback !== PROVIDER && providers[fallback]) {
    try {
      return await providers[fallback].embed(text);
    } catch {
      // Fallback also failed — throw original error
    }
  }

  throw new Error(`Embedding failed after ${EMBED_RETRIES + 1} attempts: ${lastError?.message}`);
}

export function pgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
