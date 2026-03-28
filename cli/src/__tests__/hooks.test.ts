import { describe, it, expect } from "vitest";
import { hooksStatus } from "../commands/hooks.js";

describe("hooks", () => {
  it("reports status for all hook events", () => {
    const status = hooksStatus();
    expect(status).toHaveProperty("installed");
    expect(status).toHaveProperty("settingsPath");
    expect(status.installed).toHaveProperty("SessionStart");
    expect(status.installed).toHaveProperty("PostToolUse");
    expect(status.installed).toHaveProperty("Stop");
    expect(status.installed).toHaveProperty("PreCompact");
    expect(status.installed).toHaveProperty("PostCompact");
  });
});
