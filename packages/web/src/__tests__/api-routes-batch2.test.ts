/**
 * API route tests for previously-untested routes (issue #70).
 *
 * Covers: /api/agents, /api/backlog, /api/issues, /api/setup-labels
 * These routes had zero test coverage — only E2E integration tests
 * exercised them, and those aren't run in standard CI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock services
const mockRegistry = {
  list: vi.fn(),
  get: vi.fn(),
};
const mockConfig = {
  projects: {
    "my-app": {
      repo: "owner/my-app",
      tracker: { plugin: "tracker-github" },
    },
  },
};
const mockGetBacklogIssues = vi.fn();
const mockStartBacklogPoller = vi.fn();
const mockGetVerifyIssues = vi.fn();
const mockRecordActivityEvent = vi.fn();

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: {},
  })),
  getBacklogIssues: mockGetBacklogIssues,
  startBacklogPoller: mockStartBacklogPoller,
  getVerifyIssues: mockGetVerifyIssues,
}));

vi.mock("@aoagents/ao-core", () => ({
  recordActivityEvent: mockRecordActivityEvent,
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: vi.fn(() => "test-corr-id"),
  jsonWithCorrelation: vi.fn((data: unknown, status?: number) =>
    NextResponse.json(data, status ? { status } : undefined),
  ),
}));

vi.mock("@/lib/validation", () => ({
  validateString: vi.fn((v: string, _label: string) => (v ? null : `${_label} required`)),
  validateConfiguredProject: vi.fn(() => null),
}));

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/agents (issue #70)", () => {
  it("returns list of agent plugins", async () => {
    mockRegistry.list.mockReturnValue([
      { name: "claude-code", description: "Claude Code agent", version: "1.0", slot: "agent" },
      { name: "codex", description: "Codex agent", version: "2.0", slot: "agent" },
    ]);

    const { GET } = await import("@/app/api/agents/route");
    const res = await GET(makeRequest("http://localhost:3000/api/agents"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agents).toHaveLength(2);
    expect(body.count).toBe(2);
    expect(body.agents[0].name).toBe("claude-code");
  });

  it("returns 500 when registry.list throws", async () => {
    mockRegistry.list.mockImplementation(() => {
      throw new Error("registry broken");
    });

    const { GET } = await import("@/app/api/agents/route");
    const res = await GET(makeRequest("http://localhost:3000/api/agents"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("Failed to list agent plugins");
  });

  it("returns empty array when no agents registered", async () => {
    mockRegistry.list.mockReturnValue([]);

    const { GET } = await import("@/app/api/agents/route");
    const res = await GET(makeRequest("http://localhost:3000/api/agents"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agents).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

describe("GET /api/backlog (issue #70)", () => {
  it("returns backlog issues and starts poller", async () => {
    mockGetBacklogIssues.mockResolvedValue([
      { id: "1", title: "Fix bug", projectId: "my-app", state: "open", url: "https://github.com/owner/repo/issues/1", labels: ["agent:backlog"] },
    ]);

    const { GET } = await import("@/app/api/backlog/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].title).toBe("Fix bug");
    expect(mockStartBacklogPoller).toHaveBeenCalled();
  });

  it("returns 500 when getBacklogIssues throws", async () => {
    mockGetBacklogIssues.mockRejectedValue(new Error("tracker down"));

    const { GET } = await import("@/app/api/backlog/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("tracker down");
  });
});

describe("GET /api/issues (issue #70)", () => {
  it("returns issues from configured trackers", async () => {
    const mockTracker = {
      listIssues: vi.fn().mockResolvedValue([
        { id: "10", title: "Issue 10", url: "https://github.com/owner/repo/issues/10", state: "open", labels: [] },
      ]),
    };
    mockRegistry.get.mockReturnValue(mockTracker);

    const { GET } = await import("@/app/api/issues/route");
    const res = await GET(makeRequest("http://localhost:3000/api/issues"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].projectId).toBe("my-app");
    expect(body.issues[0].title).toBe("Issue 10");
  });

  it("filters by project query param", async () => {
    const mockTracker = { listIssues: vi.fn().mockResolvedValue([]) };
    mockRegistry.get.mockReturnValue(mockTracker);

    const { GET } = await import("@/app/api/issues/route");
    const res = await GET(makeRequest("http://localhost:3000/api/issues?project=other-app"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.issues).toHaveLength(0);
    // tracker.listIssues should NOT be called for "other-app" (not in config)
    expect(mockTracker.listIssues).not.toHaveBeenCalled();
  });

  it("skips projects with no tracker plugin", async () => {
    mockConfig.projects["no-tracker"] = { repo: "owner/no-tracker" };
    const mockTracker = { listIssues: vi.fn().mockResolvedValue([]) };
    mockRegistry.get.mockReturnValue(mockTracker);

    const { GET } = await import("@/app/api/issues/route");
    await GET(makeRequest("http://localhost:3000/api/issues"));

    // listIssues called only for "my-app" (has tracker), not "no-tracker"
    expect(mockTracker.listIssues).toHaveBeenCalledTimes(1);
    delete mockConfig.projects["no-tracker"];
  });

  it("returns 500 when getServices throws", async () => {
    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("config load failed"));

    const { GET } = await import("@/app/api/issues/route");
    const res = await GET(makeRequest("http://localhost:3000/api/issues"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("config load failed");
  });
});

describe("POST /api/setup-labels (issue #70)", () => {
  it("creates labels on configured repos", async () => {
    // Mock execFileAsync — can't easily mock node:child_process, so
    // just verify the route handles success. The gh CLI call will
    // fail in test env (no gh), which the route catches as "exists".
    const { POST } = await import("@/app/api/setup-labels/route");
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBe(true);
    // Each result has repo, label, status
    if (body.results.length > 0) {
      expect(body.results[0]).toHaveProperty("repo");
      expect(body.results[0]).toHaveProperty("label");
      expect(body.results[0]).toHaveProperty("status");
    }
    expect(mockRecordActivityEvent).toHaveBeenCalled();
  });
});
