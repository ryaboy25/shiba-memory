"use client";

import { useGraphNodes, TYPE_COLORS, type MemoryNode } from "@/lib/api";

interface ActivityFeedProps {
  onMemoryClick?: (node: MemoryNode) => void;
}

export default function ActivityFeed({ onMemoryClick }: ActivityFeedProps) {
  const { data } = useGraphNodes();
  const recent = data?.nodes?.slice(0, 15) || [];

  return (
    <div className="w-80 bg-zinc-900/90 backdrop-blur border-l border-zinc-800 p-4 overflow-y-auto">
      <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-4">Recent Activity</h3>

      <div className="space-y-2">
        {recent.map((m) => (
          <button
            key={m.id}
            onClick={() => onMemoryClick?.(m)}
            className="w-full text-left bg-zinc-800/50 hover:bg-zinc-800 rounded-lg p-3 transition-colors"
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: TYPE_COLORS[m.type] || "#6b7280" }}
              />
              <span className="text-xs text-zinc-500 uppercase">{m.type}</span>
              <span className="text-xs text-zinc-600 ml-auto">
                {formatTimeAgo(m.created_at)}
              </span>
            </div>
            <div className="text-sm text-zinc-300 line-clamp-2">{m.title}</div>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-600">
              <span>{(m.confidence * 100).toFixed(0)}% conf</span>
              <span>{m.access_count}x accessed</span>
            </div>
          </button>
        ))}

        {recent.length === 0 && (
          <div className="text-sm text-zinc-600 text-center py-8">
            No memories yet
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
