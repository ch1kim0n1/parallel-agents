import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";

// Mock getServices — the singleton lazy-inits config + plugins which we
// don't want to run in a unit test.
vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
}));

// Mock getGlobalConfigPath so the storage check uses a temp dir we control.
vi.mock("@aoagents/ao-core", () => ({
  getGlobalConfigPath: vi.fn(() => "/tmp/ao-health-test/config.yaml"),
}));

import { getServices } from "@/lib/services";
import { getGlobalConfigPath } from "@aoagents/ao-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("GET /api/health — dependency checks (issue #67)", () => {
  let storageDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    storageDir = join(tmpdir(), `ao-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "config.yaml"), "test");
    vi.mocked(getGlobalConfigPath).mockReturnValue(join(storageDir, "config.yaml"));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("returns 200 + status ok when all dependencies healthy", async () => {
    vi.mocked(getServices).mockResolvedValue({} as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
    expect(body.checks.config.status).toBe("ok");
    expect(body.checks.storage.status).toBe("ok");
  });

  it("returns 503 + status degraded when config load fails", async () => {
    vi.mocked(getServices).mockRejectedValue(new Error("ConfigNotFoundError: no agent-orchestrator.yaml"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.config.status).toBe("fail");
    expect(body.checks.config.detail).toContain("ConfigNotFoundError");
    // Storage check still runs independently
    expect(body.checks.storage.status).toBe("ok");
  });

  it("returns 503 + status degraded when storage dir not writable", async () => {
    vi.mocked(getServices).mockResolvedValue({} as never);
    // Point at a non-existent dir
    vi.mocked(getGlobalConfigPath).mockReturnValue("/nonexistent/path/that/does/not/exist/config.yaml");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.storage.status).toBe("fail");
    expect(body.checks.storage.detail).toBeDefined();
    // Config check still passes
    expect(body.checks.config.status).toBe("ok");
  });

  it("returns 503 when BOTH config and storage fail", async () => {
    vi.mocked(getServices).mockRejectedValue(new Error("boom"));
    vi.mocked(getGlobalConfigPath).mockReturnValue("/nonexistent/config.yaml");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.config.status).toBe("fail");
    expect(body.checks.storage.status).toBe("fail");
  });

  it("always includes version in response body", async () => {
    vi.mocked(getServices).mockResolvedValue({} as never);
    const res = await GET();
    const body = await res.json();
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("checks are independent — config failure doesn't skip storage check", async () => {
    vi.mocked(getServices).mockRejectedValue(new Error("config fail"));
    const res = await GET();
    const body = await res.json();
    // Both checks must be present even though config failed first
    expect(body.checks).toHaveProperty("config");
    expect(body.checks).toHaveProperty("storage");
  });
});
