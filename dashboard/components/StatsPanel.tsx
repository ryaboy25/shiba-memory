"use client";

import { useStatus, useHealth, TYPE_COLORS } from "@/lib/api";

export default function StatsPanel() {
  const { data: status } = useStatus();
  const { data: health } = useHealth();

  const brain = status?.brain;

  return (
    <div className="w-72 bg-zinc-900/90 backdrop-blur border-r border-zinc-800 p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-6">
        <span className="text-2xl">🧠</span>
        <h1 className="text-lg font-bold text-white">Shiba Memory</h1>
      </div>

      {/* Connection status */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm">
          <div className={`w-2 h-2 rounded-full ${health?.status === "ok" ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
          <span className="text-zinc-400">
            {health?.status === "ok" ? "Connected" : "Disconnected"}
          </span>
          {health?.db_latency_ms !== undefined && (
            <span className="text-zinc-600 text-xs">{health.db_latency_ms}ms</span>
          )}
        </div>
      </div>

      {/* Total memories */}
      <div className="mb-6">
        <div className="text-3xl font-bold text-white">{brain?.total_memories ?? "—"}</div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide">Total Memories</div>
      </div>

      {/* By type */}
      <div className="mb-6">
        <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-3">By Type</h3>
        <div className="space-y-2">
          {brain?.by_type && Object.entries(brain.by_type)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .map(([type, count]) => (
              <div key={type} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: TYPE_COLORS[type] || "#6b7280" }}
                  />
                  <span className="text-sm text-zinc-300">{type}</span>
                </div>
                <span className="text-sm font-mono text-zinc-400">{count as number}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <div className="text-lg font-bold text-white">{brain?.total_links ?? "—"}</div>
          <div className="text-xs text-zinc-500">Links</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <div className="text-lg font-bold text-white">
            {brain?.avg_confidence ? `${(brain.avg_confidence * 100).toFixed(0)}%` : "—"}
          </div>
          <div className="text-xs text-zinc-500">Avg Confidence</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <div className="text-lg font-bold text-white">{brain?.with_embeddings ?? "—"}</div>
          <div className="text-xs text-zinc-500">Embedded</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <div className="text-lg font-bold text-white">{status?.pending_events ?? "—"}</div>
          <div className="text-xs text-zinc-500">Pending Events</div>
        </div>
      </div>

      {/* Uptime */}
      <div className="text-xs text-zinc-600">
        Uptime: {health?.uptime_seconds ? formatUptime(health.uptime_seconds) : "—"}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
