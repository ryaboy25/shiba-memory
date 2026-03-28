import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to compiled hook scripts
const HOOKS_DIR = resolve(__dirname, "..", "hooks");

// Marker to identify CCB hooks in settings.json
const CCB_MARKER = "ccb-hook";

interface HookEntry {
  type: string;
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function getSettingsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return resolve(home, ".claude", "settings.json");
}

function readSettings(): Settings {
  const path = getSettingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings): void {
  const path = getSettingsPath();
  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    const { mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function isCcbHook(group: HookGroup): boolean {
  return group.hooks.some((h) => h.command.includes(CCB_MARKER) || h.command.includes("/hooks/"));
}

function buildHookConfig(): Record<string, HookGroup[]> {
  // Use dist path relative to where the CLI is installed
  const distHooksDir = resolve(__dirname, "../hooks");

  return {
    SessionStart: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${resolve(distHooksDir, "session-start.js")}" # ${CCB_MARKER}`,
            timeout: 5,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write|Bash",
        hooks: [
          {
            type: "command",
            command: `node "${resolve(distHooksDir, "post-tool.js")}" # ${CCB_MARKER}`,
            timeout: 5,
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${resolve(distHooksDir, "stop.js")}" # ${CCB_MARKER}`,
            timeout: 5,
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${resolve(distHooksDir, "pre-compact.js")}" # ${CCB_MARKER}`,
            timeout: 5,
          },
        ],
      },
    ],
    PostCompact: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${resolve(distHooksDir, "post-compact.js")}" # ${CCB_MARKER}`,
            timeout: 5,
          },
        ],
      },
    ],
  };
}

export function installHooks(): { installed: string[] } {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  const ccbHooks = buildHookConfig();
  const installed: string[] = [];

  for (const [event, groups] of Object.entries(ccbHooks)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove existing CCB hooks for this event
    settings.hooks[event] = settings.hooks[event].filter(
      (g: HookGroup) => !isCcbHook(g)
    );

    // Add new CCB hooks
    settings.hooks[event].push(...groups);
    installed.push(event);
  }

  writeSettings(settings);
  return { installed };
}

export function uninstallHooks(): { removed: string[] } {
  const settings = readSettings();
  if (!settings.hooks) return { removed: [] };

  const removed: string[] = [];

  for (const [event, groups] of Object.entries(settings.hooks)) {
    const before = groups.length;
    settings.hooks[event] = groups.filter(
      (g: HookGroup) => !isCcbHook(g)
    );
    if (settings.hooks[event].length < before) {
      removed.push(event);
    }
    // Clean up empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  writeSettings(settings);
  return { removed };
}

export function hooksStatus(): {
  installed: Record<string, boolean>;
  settingsPath: string;
} {
  const settings = readSettings();
  const events = ["SessionStart", "PostToolUse", "Stop", "PreCompact", "PostCompact"];

  const installed: Record<string, boolean> = {};
  for (const event of events) {
    installed[event] = (settings.hooks?.[event] || []).some(
      (g: HookGroup) => isCcbHook(g)
    );
  }

  return { installed, settingsPath: getSettingsPath() };
}
