const PROVIDER = process.env.CCB_EMBEDDING_PROVIDER || "ollama";
const DIMENSIONS = 512;

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

const ollama: EmbeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const url = process.env.CCB_OLLAMA_URL || "http://localhost:11434";
    const model = process.env.CCB_OLLAMA_MODEL || "nomic-embed-text";

    const res = await fetch(`${url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    const vec = data.embeddings[0];

    // Truncate or pad to target dimensions
    if (vec.length >= DIMENSIONS) return vec.slice(0, DIMENSIONS);
    return [...vec, ...new Array(DIMENSIONS - vec.length).fill(0)];
  },
};

const openai: EmbeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const key = process.env.CCB_OPENAI_API_KEY;
    if (!key) throw new Error("CCB_OPENAI_API_KEY is required for openai provider");

    const model = process.env.CCB_OPENAI_MODEL || "text-embedding-3-small";

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, input: text, dimensions: DIMENSIONS }),
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
    // Normalize to unit vector
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    return vec.map((v: number) => v / mag);
  },
};

const providers: Record<string, EmbeddingProvider> = { ollama, openai, hashtest };

export async function embed(text: string): Promise<number[]> {
  const provider = providers[PROVIDER];
  if (!provider) throw new Error(`Unknown embedding provider: ${PROVIDER}`);
  return provider.embed(text);
}

export function pgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
