import useSWR from "swr";

const GATEWAY_URL = process.env.NEXT_PUBLIC_SHIBA_GATEWAY || "http://localhost:18789";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface MemoryNode {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  access_count: number;
  importance: number;
  tags: string[];
  profile: string;
  project_path: string | null;
  created_at: string;
  temporal_ref: string | null;
}

export interface MemoryEdge {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface BrainStats {
  total_memories: number;
  by_type: Record<string, number>;
  with_embeddings: number;
  total_links: number;
  avg_confidence: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

export function useGraphNodes(filters?: { type?: string; minConfidence?: number; since?: string }) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.minConfidence) params.set("min_confidence", String(filters.minConfidence));
  if (filters?.since) params.set("since", filters.since);
  const qs = params.toString();

  return useSWR<{ nodes: MemoryNode[]; count: number }>(
    `${GATEWAY_URL}/graph/nodes${qs ? `?${qs}` : ""}`,
    fetcher,
    { refreshInterval: 10000 }
  );
}

export function useGraphEdges() {
  return useSWR<{ edges: MemoryEdge[]; count: number }>(
    `${GATEWAY_URL}/graph/edges`,
    fetcher,
    { refreshInterval: 10000 }
  );
}

export function useStatus() {
  return useSWR<{ brain: BrainStats; pending_events: number; uptime_seconds: number }>(
    `${GATEWAY_URL}/status`,
    fetcher,
    { refreshInterval: 5000 }
  );
}

export function useHealth() {
  return useSWR<{ status: string; uptime_seconds: number; db_latency_ms: number }>(
    `${GATEWAY_URL}/health`,
    fetcher,
    { refreshInterval: 5000 }
  );
}

export const TYPE_COLORS: Record<string, string> = {
  user: "#06b6d4",
  feedback: "#f59e0b",
  project: "#8b5cf6",
  skill: "#10b981",
  instinct: "#eab308",
  episode: "#64748b",
  reference: "#3b82f6",
};

export const RELATION_COLORS: Record<string, string> = {
  related: "#3b82f6",
  supports: "#22c55e",
  contradicts: "#ef4444",
  supersedes: "#f97316",
  caused_by: "#a855f7",
  derived_from: "#9ca3af",
};
