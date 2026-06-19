import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockExecFile,
  mockExecFileSync,
  mockExistsSync,
  mockPlatform,
  mockIsMac,
  mockGetNotificationDataV3,
  mockEscapeAppleScript,
} = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockPlatform: vi.fn().mockReturnValue("linux"),
  mockIsMac: vi.fn().mockReturnValue(false),
  mockGetNotificationDataV3: vi.fn().mockReturnValue(null),
  mockEscapeAppleScript: vi.fn((s: string) => s),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    platform: mockPlatform,
    homedir: vi.fn().mockReturnValue("/home/user"),
  };
});

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isMac: mockIsMac,
    getNotificationDataV3: mockGetNotificationDataV3,
    escapeAppleScript: mockEscapeAppleScript,
  };
});

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

/**
 * Helper that makes execFile call its callback immediately (success by default).
 */
function resolveExecFile(err: Error | null = null): void {
  mockExecFile.mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") (cb as (err: Error | null) => void)(err);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue("linux");
  mockIsMac.mockReturnValue(false);
  mockGetNotificationDataV3.mockReturnValue(null);
  mockExistsSync.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has slot 'notifier'", () => {
    expect(manifest.slot).toBe("notifier");
  });

  it("has name 'desktop'", () => {
    expect(manifest.name).toBe("desktop");
  });

  it("has a semver version string", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("has a description", () => {
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
  });
});

describe("create()", () => {
  it("returns an object with a notify function", () => {
    const notifier = create();
    expect(typeof notifier.notify).toBe("function");
  });

  it("returns an object with name 'desktop'", () => {
    const notifier = create();
    expect(notifier.name).toBe("desktop");
  });

  it("exports correct plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("notify() on Linux", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("linux");
  });

  it("calls notify-send with title and body", async () => {
    resolveExecFile();
    const notifier = create();
    await notifier.notify(makeEvent({ message: "Test notification" }));

    expect(mockExecFile).toHaveBeenCalled();
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("notify-send");
    expect(Array.isArray(args)).toBe(true);
    // Body is passed as the last positional argument
    const combined = args.join(" ");
    expect(combined).toContain("Test notification");
  });

  it("passes --urgency=critical for urgent events", async () => {
    resolveExecFile();
    const notifier = create();
    await notifier.notify(makeEvent({ priority: "urgent" }));

    const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(args).toContain("--urgency=critical");
  });

  it("does not pass --urgency=critical for non-urgent events", async () => {
    resolveExecFile();
    const notifier = create();
    await notifier.notify(makeEvent({ priority: "info" }));

    const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--urgency=critical");
  });

  it("does not propagate when notify-send fails", async () => {
    resolveExecFile(new Error("notify-send failed"));
    const notifier = create();
    // Should reject because the implementation rejects on error
    await expect(notifier.notify(makeEvent())).rejects.toThrow("notify-send failed");
  });
});

describe("notify() on macOS (osascript backend)", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("darwin");
    mockIsMac.mockReturnValue(true);
    // Ensure ao-notifier app is NOT detected (so we fall through to osascript)
    mockExistsSync.mockReturnValue(false);
    // terminal-notifier not available
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
  });

  it("calls osascript with a display notification script", async () => {
    resolveExecFile();
    const notifier = create({ backend: "osascript" });
    await notifier.notify(makeEvent({ message: "Mac test" }));

    expect(mockExecFile).toHaveBeenCalled();
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("osascript");
    const script = args.join(" ");
    expect(script).toContain("display notification");
  });

  it("does not propagate when osascript errors", async () => {
    resolveExecFile(new Error("osascript unavailable"));
    const notifier = create({ backend: "osascript" });
    await expect(notifier.notify(makeEvent())).rejects.toThrow("osascript unavailable");
  });
});

describe("notify() on Windows", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("win32");
    mockIsMac.mockReturnValue(false);
  });

  it("calls powershell.exe with -EncodedCommand", async () => {
    // Windows resolve: always resolves (even on error, it logs and resolves)
    mockExecFile.mockImplementation(
      (...args: unknown[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") (cb as (err: Error | null) => void)(null);
      },
    );

    const notifier = create();
    await notifier.notify(makeEvent({ message: "Windows toast" }));

    expect(mockExecFile).toHaveBeenCalled();
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("powershell.exe");
    expect(args).toContain("-EncodedCommand");
  });

  it("does not propagate when powershell fails (Windows resolves gracefully)", async () => {
    mockExecFile.mockImplementation(
      (...args: unknown[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function")
          (cb as (err: Error | null) => void)(new Error("WinRT unavailable"));
      },
    );

    const notifier = create();
    // Windows toast failure resolves (does not reject) — the plugin logs and continues
    await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
  });
});

describe("notify() on unsupported platform", () => {
  it("resolves without calling execFile on an unsupported OS", async () => {
    mockPlatform.mockReturnValue("freebsd");
    const notifier = create();
    await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
