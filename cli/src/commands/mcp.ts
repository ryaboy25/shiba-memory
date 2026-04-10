/**
 * Shiba MCP Server
 * ================
 * Exposes Shiba memory as an MCP (Model Context Protocol) tool server.
 * Any MCP-compatible client (Claude Desktop, Cursor, etc.) can connect
 * and use these tools to remember, recall, and manage memories.
 *
 * Usage:
 *   shiba mcp start              # Start MCP server on stdio
 *   shiba mcp start --sse 3001   # Start MCP server with SSE transport
 *
 * MCP config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "shiba-memory": {
 *         "command": "shiba",
 *         "args": ["mcp", "start"]
 *       }
 *     }
 *   }
 */

import { remember } from "./remember.js";
import { recall } from "./recall.js";
import { forget } from "./forget.js";
import { linkMemories, getRelated } from "./link.js";
import { getStats, consolidate } from "./reflect.js";
import { query, disconnect } from "../db.js";

// ── MCP Protocol Types ─────────────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── Tool Definitions ───────────────────────────────────────

const TOOLS = [
  {
    name: "shiba_remember",
    description: "Store a memory in Shiba's persistent memory system. Use this to save facts, preferences, decisions, feedback, project context, or learned patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference", "episode", "skill", "instinct"],
          description: "Memory type: user (preferences/identity), feedback (corrections), project (context/decisions), reference (external resources), episode (events), skill (patterns), instinct (hunches)",
        },
        title: { type: "string", description: "Short title summarizing the memory (max 500 chars)" },
        content: { type: "string", description: "Full content of the memory (max 50000 chars)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        importance: { type: "number", minimum: 0, maximum: 1, description: "Importance score (0-1, default 0.5)" },
        project_path: { type: "string", description: "Project path for scoping (optional)" },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "shiba_recall",
    description: "Search Shiba's memory using hybrid semantic + full-text search. Returns the most relevant memories. Use this to retrieve context, check what's been learned, or find related information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
        type: { type: "string", description: "Filter by memory type (optional)" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags (optional)" },
        limit: { type: "number", minimum: 1, maximum: 50, description: "Max results (default 5)" },
        project: { type: "string", description: "Filter by project path (optional)" },
        after: { type: "string", description: "ISO 8601 date — only memories after this date (optional)" },
        before: { type: "string", description: "ISO 8601 date — only memories before this date (optional)" },
        rerank: { type: "boolean", description: "Use LLM cross-encoder reranking for better accuracy (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "shiba_forget",
    description: "Delete memories from Shiba by ID, type, age, or confidence threshold.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Delete a specific memory by UUID" },
        type: { type: "string", description: "Delete all memories of this type" },
        older_than: { type: "string", description: "Delete memories older than this (e.g., '90d', '30d')" },
        low_confidence: { type: "number", description: "Delete memories below this confidence" },
      },
    },
  },
  {
    name: "shiba_link",
    description: "Create a relationship between two memories in the knowledge graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_id: { type: "string", description: "Source memory UUID" },
        target_id: { type: "string", description: "Target memory UUID" },
        relation: {
          type: "string",
          enum: ["related", "supports", "contradicts", "supersedes", "caused_by", "derived_from"],
          description: "Relationship type",
        },
        strength: { type: "number", minimum: 0, maximum: 1, description: "Relationship strength (0-1, default 0.5)" },
      },
      required: ["source_id", "target_id", "relation"],
    },
  },
  {
    name: "shiba_get_related",
    description: "Get all memories related to a specific memory in the knowledge graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_id: { type: "string", description: "Memory UUID to find relations for" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "shiba_stats",
    description: "Get statistics about Shiba's memory: total memories, types, links, confidence, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "shiba_consolidate",
    description: "Run brain maintenance: merge duplicates, detect contradictions, decay old memories, auto-link, and discover cross-project insights.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ── Tool Execution ─────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "shiba_remember": {
      const id = await remember({
        type: args.type as string,
        title: args.title as string,
        content: args.content as string,
        tags: args.tags as string[] | undefined,
        importance: args.importance as number | undefined,
        projectPath: args.project_path as string | undefined,
        source: "mcp",
      });
      return { id, message: "Memory stored successfully" };
    }

    case "shiba_recall": {
      const memories = await recall({
        query: args.query as string,
        type: args.type as string | undefined,
        tags: args.tags as string[] | undefined,
        limit: (args.limit as number) || 5,
        project: args.project as string | undefined,
        after: args.after as string | undefined,
        before: args.before as string | undefined,
        rerank: args.rerank as boolean | undefined,
      });
      return {
        count: memories.length,
        memories: memories.map((m) => ({
          id: m.id,
          type: m.type,
          title: m.title,
          content: m.content,
          tags: m.tags,
          relevance: m.relevance,
          created_at: m.created_at,
        })),
      };
    }

    case "shiba_forget": {
      const deleted = await forget({
        id: args.id as string | undefined,
        type: args.type as string | undefined,
        olderThan: args.older_than as string | undefined,
        lowConfidence: args.low_confidence as number | undefined,
      });
      return { deleted, message: `Deleted ${deleted} memories` };
    }

    case "shiba_link": {
      await linkMemories(
        args.source_id as string,
        args.target_id as string,
        args.relation as string,
        (args.strength as number) || 0.5,
      );
      return { message: "Link created" };
    }

    case "shiba_get_related": {
      const links = await getRelated(args.memory_id as string);
      return { count: links.length, links };
    }

    case "shiba_stats": {
      const stats = await getStats();
      return stats;
    }

    case "shiba_consolidate": {
      const result = await consolidate();
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server (stdio transport) ───────────────────────────

function sendResponse(response: MCPResponse | MCPNotification): void {
  const json = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function handleRequest(request: MCPRequest): MCPResponse {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "shiba-memory",
            version: "0.3.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    // tools/call is handled async — see below
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
  }
}

async function handleToolCall(request: MCPRequest): Promise<MCPResponse> {
  const { id, params } = request;
  const toolName = (params as { name?: string })?.name;
  const toolArgs = ((params as { arguments?: Record<string, unknown> })?.arguments) || {};

  if (!toolName) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Missing tool name" },
    };
  }

  try {
    const result = await executeTool(toolName, toolArgs);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          { type: "text", text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      },
    };
  }
}

export function startMCPServer(): void {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;

    // Parse Content-Length delimited messages
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Try parsing as raw JSON (some clients don't send Content-Length)
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const request = JSON.parse(line) as MCPRequest;
          await processRequest(request);
        } catch { /* skip malformed */ }
        continue;
      }

      const contentLength = parseInt(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      if (buffer.length < messageStart + contentLength) break;

      const json = buffer.slice(messageStart, messageStart + contentLength);
      buffer = buffer.slice(messageStart + contentLength);

      try {
        const request = JSON.parse(json) as MCPRequest;
        await processRequest(request);
      } catch { /* skip malformed */ }
    }
  });

  async function processRequest(request: MCPRequest) {
    if (request.method === "notifications/initialized") {
      // Client acknowledged initialization — no response needed
      return;
    }

    if (request.method === "tools/call") {
      const response = await handleToolCall(request);
      sendResponse(response);
    } else {
      const response = handleRequest(request);
      sendResponse(response);
    }
  }

  process.stdin.on("end", () => {
    disconnect().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    disconnect().then(() => process.exit(0));
  });

  // Write nothing on startup — wait for client to send initialize
  process.stderr.write("[shiba-mcp] Server started on stdio\n");
}
