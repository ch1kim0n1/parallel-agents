import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockReadLastActivityEntry,
  mockRecordTerminalActivity,
  mockCheckActivityLogState,
  mockGetActivityFallbackState,
  mockHasRecentCommits,
  mockIsWindows,
  mockExecFileAsync,
  mockLstat,
  mockStat,
  mockAccess,
  mockReadFile,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockCheckActivityLogState: vi.fn().mockReturnValue(null),
  mockGetActivityFallbackState: vi.fn().mockReturnValue(null),
  mockHasRecentCommits: vi.fn().mockResolvedValue(false),
  mockIsWindows: vi.fn().mockReturnValue(false),
  mockExecFileAsync: vi.fn(),
  mockLstat: vi.fn(),
  mockStat: vi.fn(),
  mockAccess: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    checkActivityLogState: mockCheckActivityLogState,
    getActivityFallbackState: mockGetActivityFallbackState,
    hasRecentCommits: mockHasRecentCommits,
    isWindows: mockIsWindows,
  };
});

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1];
    const result = mockExecFileAsync(...args.slice(0, -1));
    if (typeof callback === "function" && result && typeof result.then === "function") {
      result.then(
        (value: { stdout: string; stderr: string }) => (callback as Function)(null, value),
        (err: Error) => (callback as Function)(err),
      );
    }
  },
  execFileSync: vi.fn().mockReturnValue("Cursor Agent --help output"),
}));

vi.mock("node:fs/promises", () => ({
  stat: mockStat,
  access: mockAccess,
  readFile: mockReadFile,
  lstat: mockLstat,
}));

vi.mock("node:fs", () => ({
  lstatSync: vi.fn().mockImplementation(() => ({
    isSymbolicLink: () => false,
  })),
  constants: { R_OK: 4 },
}));

import { manifest, create, detect, default as defaultExport } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      timestamp: new Date(),
      source: "runtime",
    },
    lifecycle: {} as Session["lifecycle"],
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number | string): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: {},
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadLastActivityEntry.mockResolvedValue(null);
  mockRecordTerminalActivity.mockResolvedValue(undefined);
  mockCheckActivityLogState.mockReturnValue(null);
  mockGetActivityFallbackState.mockReturnValue(null);
  mockHasRecentCommits.mockResolvedValue(false);
  mockIsWindows.mockReturnValue(false);
  mockLstat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has slot 'agent'", () => {
    expect(manifest.slot).toBe("agent");
  });

  it("has name 'cursor'", () => {
    expect(manifest.name).toBe("cursor");
  });

  it("has displayName 'Cursor'", () => {
    expect(manifest.displayName).toBe("Cursor");
  });

  it("has a semver version string", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("create()", () => {
  it("returns object with all required Agent interface methods", () => {
    const agent = create();
    expect(typeof agent.getLaunchCommand).toBe("function");
    expect(typeof agent.getEnvironment).toBe("function");
    expect(typeof agent.detectActivity).toBe("function");
    expect(typeof agent.getActivityState).toBe("function");
    expect(typeof agent.isProcessRunning).toBe("function");
    expect(typeof agent.recordActivity).toBe("function");
    expect(typeof agent.getSessionInfo).toBe("function");
    expect(typeof agent.getRestoreCommand).toBe("function");
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("exports correct plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect()", () => {
  it("returns a boolean", () => {
    const result = detect();
    expect(typeof result).toBe("boolean");
  });
});

describe("getLaunchCommand()", () => {
  const agent = create();

  it("returns a non-empty string command", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
  });

  it("starts with 'agent'", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd.startsWith("agent")).toBe(true);
  });

  it("includes --force and --sandbox flags when permissions is permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--force");
    expect(cmd).toContain("--sandbox");
    expect(cmd).toContain("disabled");
  });

  it("includes --force and --sandbox flags when permissions is auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--force");
    expect(cmd).toContain("--sandbox");
  });

  it("includes model flag when model is specified", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-3-5-sonnet" }));
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-3-5-sonnet");
  });

  it("includes prompt in command when provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("Fix the bug");
  });
});

describe("getEnvironment()", () => {
  const agent = create();

  it("includes AO_SESSION_ID in environment keys", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect("AO_SESSION_ID" in env).toBe(true);
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("includes AO_ISSUE_ID when issueId is present", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "ISSUE-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("ISSUE-42");
  });

  it("does not include AO_ISSUE_ID when issueId is absent", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("returns a plain object", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
  });
});

describe("detectActivity()", () => {
  const agent = create();

  it("returns 'idle' for empty input", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns 'idle' when last line is a shell prompt", () => {
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\nagent> ")).toBe("idle");
  });

  it("returns 'waiting_input' for (Y)es/(N)o prompts", () => {
    expect(agent.detectActivity("Approve changes?\n(Y)es (N)o")).toBe("waiting_input");
  });

  it("returns 'waiting_input' for Approve changes prompt", () => {
    expect(agent.detectActivity("Approve changes?")).toBe("waiting_input");
  });

  it("returns 'waiting_input' for Continue? prompt", () => {
    expect(agent.detectActivity("Continue?")).toBe("waiting_input");
  });

  it("returns 'waiting_input' for Press Enter to continue", () => {
    expect(agent.detectActivity("Press Enter to continue")).toBe("waiting_input");
  });

  it("returns 'active' for general tool output", () => {
    expect(agent.detectActivity("Running tests...")).toBe("active");
    expect(agent.detectActivity("Analyzing the codebase")).toBe("active");
  });

  it("returns 'active' when output has no specific pattern", () => {
    const result = agent.detectActivity("Some random output without prompts or idle markers");
    expect(["active", "idle", "waiting_input"]).toContain(result);
  });
});

describe("getActivityState()", () => {
  const agent = create();

  it("returns exited when runtimeHandle is null", async () => {
    const state = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(state).toMatchObject({ state: "exited" });
  });

  it("returns exited when isProcessRunning returns false (process handle)", async () => {
    const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(999) }),
    );
    expect(state).toMatchObject({ state: "exited" });
    killSpy.mockRestore();
  });

  it("returns waiting_input from JSONL when process is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const activityAt = new Date();
    mockCheckActivityLogState.mockReturnValue({ state: "waiting_input", timestamp: activityAt });

    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("waiting_input");
    killSpy.mockRestore();
  });

  it("returns blocked from JSONL when process is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const activityAt = new Date();
    mockCheckActivityLogState.mockReturnValue({ state: "blocked", timestamp: activityAt });

    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("blocked");
    killSpy.mockRestore();
  });

  it("returns active from hasRecentCommits when JSONL has no actionable state", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockCheckActivityLogState.mockReturnValue(null);
    mockHasRecentCommits.mockResolvedValue(true);

    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("active");
    killSpy.mockRestore();
  });

  it("uses JSONL entry fallback when no other signal is available", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockCheckActivityLogState.mockReturnValue(null);
    mockHasRecentCommits.mockResolvedValue(false);
    mockGetActivityFallbackState.mockReturnValue({ state: "idle", timestamp: new Date() });

    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("idle");
    killSpy.mockRestore();
  });

  it("returns null when no data is available at all", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockCheckActivityLogState.mockReturnValue(null);
    mockHasRecentCommits.mockResolvedValue(false);
    mockGetActivityFallbackState.mockReturnValue(null);

    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});

describe("isProcessRunning()", () => {
  const agent = create();

  it("returns true when process.kill(pid, 0) succeeds", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await agent.isProcessRunning(makeProcessHandle(123));
    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns true (EPERM = still running) for EPERM", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    const result = await agent.isProcessRunning(makeProcessHandle(123));
    expect(result).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process.kill throws ESRCH (no such process)", async () => {
    const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    const result = await agent.isProcessRunning(makeProcessHandle(123));
    expect(result).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false when process handle has no pid", async () => {
    const result = await agent.isProcessRunning(makeProcessHandle());
    expect(result).toBe(false);
  });

  it("returns true when agent process is found on a tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux")
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  /usr/local/bin/agent\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.isProcessRunning(makeTmuxHandle("ao-test"));
    expect(result).toBe(true);
  });

  it("returns false when no matching agent process on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux")
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  /usr/bin/bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.isProcessRunning(makeTmuxHandle("ao-test"));
    expect(result).toBe(false);
  });

  it("returns false when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux: no server running"));

    const result = await agent.isProcessRunning(makeTmuxHandle("ao-test"));
    expect(result).toBe(false);
  });
});

describe("recordActivity()", () => {
  const agent = create();

  it("calls recordTerminalActivity with the terminal output", async () => {
    await agent.recordActivity?.(makeSession(), "some terminal output");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "some terminal output",
      expect.any(Function),
    );
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getRestoreCommand()", () => {
  const agent = create();

  it("returns null (Cursor does not support session resume)", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), makeLaunchConfig().projectConfig);
    expect(cmd).toBeNull();
  });
});
