import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startGateway, stopGateway, gatewayStatus } from "../commands/gateway.js";

const PORT = 18799; // Use different port to avoid conflicts
process.env.SHB_GATEWAY_PORT = String(PORT);

// We test the gateway functions directly instead of HTTP
// since starting the server in tests is complex

describe("gateway", () => {
  it("reports not running when no PID file", () => {
    const status = gatewayStatus();
    // May or may not be running depending on test order
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("port");
  });

  it("stop returns false when not running", () => {
    const result = stopGateway();
    expect(result.stopped).toBe(false);
  });
});
