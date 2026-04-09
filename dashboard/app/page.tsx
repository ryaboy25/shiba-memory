"use client";

import { useState } from "react";
import BrainGraph from "@/components/BrainGraph";
import StatsPanel from "@/components/StatsPanel";
import ActivityFeed from "@/components/ActivityFeed";
import NodeDetail from "@/components/NodeDetail";
import type { MemoryNode } from "@/lib/api";

export default function Dashboard() {
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);

  return (
    <div className="flex h-screen">
      {/* Left: Stats */}
      <StatsPanel />

      {/* Center: 3D Brain */}
      <div className="flex-1 relative">
        <BrainGraph
          onNodeClick={(node) => setSelectedNode(node)}
        />

        {/* Floating title */}
        <div className="absolute top-4 left-4 pointer-events-none">
          <h1 className="text-xl font-bold text-white/20">Shiba Memory</h1>
          <p className="text-xs text-white/10">Situation Room</p>
        </div>

        {/* Node detail overlay */}
        <NodeDetail
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>

      {/* Right: Activity Feed */}
      <ActivityFeed onMemoryClick={(node) => setSelectedNode(node)} />
    </div>
  );
}
