"use client";

import { useState } from "react";
import BrainGraph from "@/components/BrainGraph";
import StatsPanel from "@/components/StatsPanel";
import ActivityFeed from "@/components/ActivityFeed";
import NodeDetail from "@/components/NodeDetail";
import type { MemoryNode } from "@/lib/api";

export default function Dashboard() {
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [showFeed, setShowFeed] = useState(true);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* 3D Brain — fills the entire screen behind everything */}
      <div className="absolute inset-0 z-0">
        <BrainGraph
          onNodeClick={(node) => setSelectedNode(node)}
        />
      </div>

      {/* Floating title */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-10">
        <h1 className="text-xl font-bold text-white/20 text-center">Shiba Memory</h1>
        <p className="text-xs text-white/10 text-center">Situation Room</p>
      </div>

      {/* Left: Stats Panel (collapsible) */}
      <div className={`absolute top-0 left-0 h-full z-20 transition-transform duration-300 ${showStats ? "translate-x-0" : "-translate-x-full"}`}>
        <StatsPanel />
      </div>
      <button
        onClick={() => setShowStats(!showStats)}
        className="absolute top-4 z-30 bg-zinc-800/80 hover:bg-zinc-700 text-white rounded-r-lg px-2 py-3 text-xs transition-all"
        style={{ left: showStats ? "288px" : "0px" }}
      >
        {showStats ? "<" : ">"}
      </button>

      {/* Right: Activity Feed (collapsible) */}
      <div className={`absolute top-0 right-0 h-full z-20 transition-transform duration-300 ${showFeed ? "translate-x-0" : "translate-x-full"}`}>
        <ActivityFeed onMemoryClick={(node) => setSelectedNode(node)} />
      </div>
      <button
        onClick={() => setShowFeed(!showFeed)}
        className="absolute top-4 z-30 bg-zinc-800/80 hover:bg-zinc-700 text-white rounded-l-lg px-2 py-3 text-xs transition-all"
        style={{ right: showFeed ? "320px" : "0px" }}
      >
        {showFeed ? ">" : "<"}
      </button>

      {/* Node detail overlay */}
      <div className="z-30">
        <NodeDetail
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>
    </div>
  );
}
