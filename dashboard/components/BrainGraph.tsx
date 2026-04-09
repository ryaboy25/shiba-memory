"use client";

import { useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { useGraphNodes, useGraphEdges, TYPE_COLORS, RELATION_COLORS, type MemoryNode } from "@/lib/api";

// Dynamic import to avoid SSR issues with three.js
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

interface BrainGraphProps {
  filters?: { type?: string; minConfidence?: number; since?: string };
  onNodeClick?: (node: MemoryNode) => void;
}

export default function BrainGraph({ filters, onNodeClick }: BrainGraphProps) {
  const graphRef = useRef<unknown>(null);
  const { data: nodesData } = useGraphNodes(filters);
  const { data: edgesData } = useGraphEdges();

  const graphData = useMemo(() => {
    if (!nodesData?.nodes) return { nodes: [], links: [] };

    const nodeIds = new Set(nodesData.nodes.map((n) => n.id));

    // Only include edges where both nodes exist in current filtered set
    const links = (edgesData?.edges || [])
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        relation: e.relation,
        strength: e.strength,
        color: RELATION_COLORS[e.relation] || "#6b7280",
      }));

    const nodes = nodesData.nodes.map((n) => ({
      ...n,
      color: TYPE_COLORS[n.type] || "#6b7280",
      val: 4 + (n.access_count || 0) * 2, // Node size
    }));

    return { nodes, links };
  }, [nodesData, edgesData]);

  const handleNodeClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      if (onNodeClick) onNodeClick(node as MemoryNode);
      // Fly camera to clicked node
      if (graphRef.current) {
        const distance = 80;
        const pos = node;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (graphRef.current as any).cameraPosition(
          { x: pos.x + distance, y: pos.y + distance, z: pos.z + distance },
          { x: pos.x, y: pos.y, z: pos.z },
          1500
        );
      }
    },
    [onNodeClick]
  );

  if (!nodesData?.nodes?.length) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <div className="text-center">
          <div className="text-4xl mb-4">🧠</div>
          <p>No memories yet. Start a conversation with Hermes or Claude Code.</p>
        </div>
      </div>
    );
  }

  return (
    <ForceGraph3D
      ref={graphRef}
      graphData={graphData}
      backgroundColor="#0a0a0f"
      nodeLabel={(node: unknown) => {
        const n = node as MemoryNode & { color: string };
        return `<div style="background:#1a1a2e;padding:8px 12px;border-radius:8px;border:1px solid ${n.color};max-width:300px">
          <div style="color:${n.color};font-weight:bold;font-size:12px;text-transform:uppercase;margin-bottom:4px">${n.type}</div>
          <div style="color:#e2e8f0;font-size:13px">${n.title}</div>
          <div style="color:#94a3b8;font-size:11px;margin-top:4px">confidence: ${(n.confidence * 100).toFixed(0)}% | accessed: ${n.access_count}x</div>
        </div>`;
      }}
      nodeColor={(node: unknown) => (node as { color: string }).color}
      nodeVal={(node: unknown) => (node as { val: number }).val}
      nodeOpacity={0.9}
      linkColor={(link: unknown) => (link as { color: string }).color}
      linkWidth={(link: unknown) => 0.5 + (link as { strength: number }).strength * 2.5}
      linkOpacity={0.4}
      linkDirectionalParticles={2}
      linkDirectionalParticleWidth={1.5}
      linkDirectionalParticleSpeed={0.005}
      onNodeClick={handleNodeClick}
      enableNodeDrag={true}
      warmupTicks={50}
      cooldownTime={3000}
    />
  );
}
