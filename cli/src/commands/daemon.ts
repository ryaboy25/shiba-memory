import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { consolidate } from "./reflect.js";

const PID_FILE = "/tmp/shiba-daemon.pid";
const CONSOLIDATE_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startDaemon(): void {
  // Check if already running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0); // Check if process exists
      throw new Error(`Daemon already running (PID ${pid})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      // Process doesn't exist, clean up stale PID file
    }
  }

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  console.log(JSON.stringify({
    status: "ok",
    message: "Shiba daemon started",
    pid: process.pid,
    consolidate_interval_minutes: CONSOLIDATE_INTERVAL / 60000,
  }));

  // Run consolidation immediately
  runConsolidation();

  // Schedule periodic consolidation
  const consolidationTimer = setInterval(runConsolidation, CONSOLIDATE_INTERVAL);

  // Handle shutdown — clear timer and clean up
  const shutdown = () => {
    clearInterval(consolidationTimer);
    try {
      unlinkSync(PID_FILE);
    } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function runConsolidation(): Promise<void> {
  try {
    // Sleep-time consolidation (LightMem pattern): do expensive reorg between sessions
    const result = await consolidate();
    process.stderr.write(
      `[shiba] Consolidation: merged=${result.merged} contradictions=${result.contradictions} decayed=${result.decayed} expired=${result.expired} linked=${result.linked} insights=${result.insights}\n`
    );

    // Evolve instincts → skills (with LLM verification if available)
    try {
      const { evolve } = await import("./evolve.js");
      const evolveResult = await evolve();
      if (evolveResult.promoted > 0) {
        process.stderr.write(
          `[shiba] Evolution: promoted=${evolveResult.promoted} verified=${evolveResult.llm_verified} clustered=${evolveResult.clustered}\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[shiba] Evolution error: ${(err as Error).message}\n`);
    }

    // Knowledge compilation: synthesize episodes into skill articles
    try {
      const { compile } = await import("./compile.js");
      const compileResult = await compile();
      if (compileResult.articles_created > 0) {
        process.stderr.write(
          `[shiba] Compilation: articles=${compileResult.articles_created} episodes=${compileResult.episodes_processed}\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[shiba] Compilation error: ${(err as Error).message}\n`);
    }

    // Clean up expired scratchpad entries
    try {
      const { query } = await import("../db.js");
      await query(`DELETE FROM scratchpad WHERE expires_at < now()`);
    } catch { /* scratchpad table may not exist yet */ }

  } catch (err) {
    process.stderr.write(`[shiba] Consolidation error: ${(err as Error).message}\n`);
  }
}

export function stopDaemon(): { stopped: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) {
    return { stopped: false };
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());

  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(PID_FILE);
    return { stopped: true, pid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      unlinkSync(PID_FILE);
      return { stopped: false };
    }
    throw e;
  }
}

export function daemonStatus(): {
  running: boolean;
  pid?: number;
} {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { running: false };
  }
}
