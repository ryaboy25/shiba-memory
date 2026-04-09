"use client";

import { TYPE_COLORS, type MemoryNode } from "@/lib/api";

interface NodeDetailProps {
  node: MemoryNode | null;
  onClose: () => void;
}

export default function NodeDetail({ node, onClose }: NodeDetailProps) {
  if (!node) return null;

  const color = TYPE_COLORS[node.type] || "#6b7280";

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[600px] max-w-[90vw] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700 rounded-2xl shadow-2xl p-6 z-50">
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
      >
        &times;
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs uppercase tracking-wide font-medium" style={{ color }}>
          {node.type}
        </span>
        <span className="text-xs text-zinc-600">
          {new Date(node.created_at).toLocaleString()}
        </span>
      </div>

      <h2 className="text-lg font-semibold text-white mb-2">{node.title}</h2>
      <p className="text-sm text-zinc-400 leading-relaxed mb-4">{node.content}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {node.tags?.map((tag) => (
          <span key={tag} className="px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-400">
            {tag}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-zinc-800/50 rounded-lg p-2 text-center">
          <div className="text-sm font-bold text-white">{(node.confidence * 100).toFixed(0)}%</div>
          <div className="text-xs text-zinc-500">Confidence</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-2 text-center">
          <div className="text-sm font-bold text-white">{node.access_count}</div>
          <div className="text-xs text-zinc-500">Accesses</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-2 text-center">
          <div className="text-sm font-bold text-white">{(node.importance * 100).toFixed(0)}%</div>
          <div className="text-xs text-zinc-500">Importance</div>
        </div>
      </div>
    </div>
  );
}
