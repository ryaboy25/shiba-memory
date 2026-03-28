import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { query, disconnect } from "../db.js";
import { embed, pgVector } from "../embeddings.js";
import { remember } from "./remember.js";
import { recall } from "./recall.js";
import { getStats } from "./reflect.js";

const PORT = parseInt(process.env.CCB_GATEWAY_PORT || "18789");
const PID_FILE = "/tmp/ccb-gateway.pid";

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startGateway(): void {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0);
      console.log(JSON.stringify({ status: "error", message: `Gateway already running (PID ${pid})` }));
      return;
    } catch { /* stale pid */ }
  }

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url || "/";

    try {
      // GET /status
      if (url === "/status" && req.method === "GET") {
        const stats = await getStats();
        const events = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT as count FROM events_queue WHERE NOT processed`
        );
        respond(res, 200, {
          status: "ok",
          brain: stats,
          pending_events: parseInt(events.rows[0].count),
          uptime_seconds: Math.floor(process.uptime()),
        });
        return;
      }

      // POST /remember
      if (url === "/remember" && req.method === "POST") {
        const body = await parseBody(req);
        const id = await remember({
          type: (body.type as string) || "reference",
          title: (body.title as string) || "Gateway memory",
          content: (body.content as string) || "",
          tags: (body.tags as string[]) || ["gateway"],
          importance: (body.importance as number) || 0.5,
          source: "gateway",
        });
        respond(res, 200, { status: "ok", id });
        return;
      }

      // POST /recall
      if (url === "/recall" && req.method === "POST") {
        const body = await parseBody(req);
        const results = await recall({
          query: (body.query as string) || "",
          type: body.type as string | undefined,
          limit: (body.limit as number) || 5,
        });
        respond(res, 200, { status: "ok", count: results.length, memories: results });
        return;
      }

      // POST /event
      if (url === "/event" && req.method === "POST") {
        const body = await parseBody(req);
        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [
            (body.source as string) || "gateway",
            (body.event_type as string) || "message",
            JSON.stringify(body.payload || body),
          ]
        );
        respond(res, 200, { status: "ok", queued: true });
        return;
      }

      // GET /events
      if (url === "/events" && req.method === "GET") {
        const events = await query<{
          id: number;
          source: string;
          event_type: string;
          payload: unknown;
          created_at: string;
        }>(
          `SELECT id, source, event_type, payload, created_at
           FROM events_queue WHERE NOT processed
           ORDER BY created_at ASC LIMIT 50`
        );
        respond(res, 200, { status: "ok", events: events.rows });
        return;
      }

      // POST /events/process
      if (url === "/events/process" && req.method === "POST") {
        const body = await parseBody(req);
        const ids = body.ids as number[];
        if (ids && ids.length > 0) {
          await query(
            `UPDATE events_queue SET processed = true, processed_at = now()
             WHERE id = ANY($1::bigint[])`,
            [ids]
          );
        }
        respond(res, 200, { status: "ok", processed: ids?.length || 0 });
        return;
      }

      // POST /webhook -- Generic webhook receiver for external integrations
      // Accepts any JSON payload and queues it as an event
      if (url === "/webhook" && req.method === "POST") {
        const body = await parseBody(req);
        const source = (body.source as string)
          || req.headers["x-webhook-source"] as string
          || "webhook";
        const eventType = (body.event_type as string)
          || (body.type as string)
          || "webhook";

        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [source, eventType, JSON.stringify(body)]
        );

        // Also store as a memory if it looks important
        const message = (body.message as string)
          || (body.text as string)
          || (body.content as string);

        if (message && message.length > 20) {
          await remember({
            type: "episode",
            title: `Webhook: ${source} ${eventType}`,
            content: message.slice(0, 2000),
            tags: ["webhook", source, eventType],
            importance: 0.5,
            source: "gateway",
            expiresIn: "7d",
          });
        }

        respond(res, 200, { status: "ok", queued: true, source, event_type: eventType });
        return;
      }

      // POST /channel -- Claude Code Channels integration endpoint
      // Receives messages from Telegram, Discord, etc via Claude Code Channels
      if (url === "/channel" && req.method === "POST") {
        const body = await parseBody(req);
        const channel = (body.channel as string) || "unknown";
        const sender = (body.sender as string) || "unknown";
        const message = (body.message as string) || JSON.stringify(body);

        // Queue as event
        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, 'channel_message', $2::jsonb)`,
          [`channel:${channel}`, JSON.stringify({ channel, sender, message })]
        );

        // Store as episode memory
        await remember({
          type: "episode",
          title: `Channel message from ${sender} via ${channel}`,
          content: message.slice(0, 2000),
          tags: ["channel", channel, sender],
          importance: 0.6,
          source: "gateway",
          expiresIn: "30d",
        });

        respond(res, 200, { status: "ok", channel, sender, queued: true });
        return;
      }

      respond(res, 404, { status: "error", message: "Not found" });
    } catch (e) {
      respond(res, 500, { status: "error", message: (e as Error).message });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    writeFileSync(PID_FILE, String(process.pid));
    console.log(JSON.stringify({
      status: "ok",
      message: "CCB Gateway started",
      pid: process.pid,
      port: PORT,
      endpoints: [
        "GET  /status",
        "POST /remember",
        "POST /recall",
        "POST /event",
        "GET  /events",
        "POST /events/process",
        "POST /webhook",
        "POST /channel",
      ],
    }));
  });

  const shutdown = () => {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    server.close();
    disconnect().then(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function stopGateway(): { stopped: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) return { stopped: false };

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(PID_FILE);
    return { stopped: true, pid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return { stopped: false };
    }
    throw e;
  }
}

export function gatewayStatus(): { running: boolean; pid?: number; port: number } {
  if (!existsSync(PID_FILE)) return { running: false, port: PORT };

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return { running: true, pid, port: PORT };
  } catch {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { running: false, port: PORT };
  }
}
