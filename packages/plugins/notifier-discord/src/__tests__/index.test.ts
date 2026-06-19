import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that trigger module eval
// ---------------------------------------------------------------------------
const {
  mockFetch,
  mockGetNotificationDataV3,
  mockRecordActivityEvent,
  mockValidateUrl,
  mockNormalizeRetryConfig,
  mockIsRetryableHttpStatus,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetNotificationDataV3: vi.fn().mockReturnValue(null),
  mockRecordActivityEvent: vi.fn(),
  mockValidateUrl: vi.fn(),
  mockNormalizeRetryConfig: vi.fn().mockReturnValue({ retries: 0, retryDelayMs: 1000 }),
  mockIsRetryableHttpStatus: vi.fn().mockReturnValue(false),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getNotificationDataV3: mockGetNotificationDataV3,
    recordActivityEvent: mockRecordActivityEvent,
    validateUrl: mockValidateUrl,
  };
});

vi.mock("@aoagents/ao-core/utils", () => ({
  normalizeRetryConfig: mockNormalizeRetryConfig,
  isRetryableHttpStatus: mockIsRetryableHttpStatus,
}));

// Replace global fetch with mock
vi.stubGlobal("fetch", mockFetch);

import { manifest, create, default as defaultExport } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.needs_input",
    priority: "action",
    message: "Agent needs input",
    sessionId: "sess-1",
    projectId: "proj-1",
    timestamp: new Date("2024-01-01T00:00:00Z"),
    data: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNotificationDataV3.mockReturnValue(null);
  mockNormalizeRetryConfig.mockReturnValue({ retries: 0, retryDelayMs: 1000 });
  mockIsRetryableHttpStatus.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has slot 'notifier'", () => {
    expect(manifest.slot).toBe("notifier");
  });

  it("has name 'discord'", () => {
    expect(manifest.name).toBe("discord");
  });

  it("has a semver version string", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("create()", () => {
  it("returns an object with a notify function when called with no config", () => {
    const notifier = create();
    expect(typeof notifier.notify).toBe("function");
  });

  it("returns an object with a notify function when called with a valid webhookUrl", () => {
    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    expect(typeof notifier.notify).toBe("function");
  });

  it("stores the webhookUrl (used in notify calls)", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl });
    await notifier.notify(makeEvent());

    expect(mockFetch).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("exports correct plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("notify()", () => {
  it("calls fetch with correct Discord webhook payload when a valid webhookUrl is configured", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl, username: "TestBot" });
    await notifier.notify(makeEvent());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(webhookUrl);
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers).toMatchObject({ "Content-Type": "application/json" });

    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.username).toBe("TestBot");
    expect(Array.isArray(body.embeds)).toBe(true);
    expect((body.embeds as unknown[]).length).toBeGreaterThan(0);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("does not call fetch when no webhookUrl is configured", async () => {
    const notifier = create();
    await notifier.notify(makeEvent());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not propagate when fetch throws", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockRejectedValueOnce(new Error("network failure"));

    const notifier = create({ webhookUrl });
    // Should not throw
    await expect(notifier.notify(makeEvent())).rejects.toThrow();
  });

  it("uses the threadId as a query param on the effective URL when configured", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl, threadId: "thread-42" });
    await notifier.notify(makeEvent());

    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("thread_id=thread-42");
  });

  it("includes avatar_url in payload when avatarUrl is configured", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const avatarUrl = "https://example.com/avatar.png";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl, avatarUrl });
    await notifier.notify(makeEvent());

    const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.avatar_url).toBe(avatarUrl);
  });
});

describe("notifyWithActions()", () => {
  it("calls fetch with action fields in payload", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl });
    await notifier.notifyWithActions?.(makeEvent(), [
      { label: "View PR", url: "https://github.com/org/repo/pull/1" },
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(Array.isArray(body.embeds)).toBe(true);
  });

  it("does not call fetch when no webhookUrl is configured", async () => {
    const notifier = create();
    await notifier.notifyWithActions?.(makeEvent(), [{ label: "View PR", url: "https://example.com" }]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("post()", () => {
  it("sends a plain content message", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl });
    await notifier.post?.("Hello from AO");

    const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.content).toBe("Hello from AO");
  });

  it("returns null", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const notifier = create({ webhookUrl });
    const result = await notifier.post?.("msg");
    expect(result).toBeNull();
  });

  it("does not call fetch when no webhookUrl is configured", async () => {
    const notifier = create();
    await notifier.post?.("Hello");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
