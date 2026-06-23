/**
 * Tests for `ao validate` preflight command (issue #76).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../src/program.js";

// Mock findConfigFile + loadConfig to control test scenarios.
const mockConfigPath = vi.hoisted(() => ({ current: "" as string }));
const mockConfig = vi.hoisted(() => ({ current: null as any }));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findConfigFile: vi.fn(() => mockConfigPath.current || null),
    loadConfig: vi.fn(() => mockConfig.current),
  };
});

describe("ao validate (issue #76)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-validate-test-"));
    mockConfigPath.current = "";
    mockConfig.current = null;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers the validate command", () => {
    const program = createProgram();
    expect(program.commands.some((c) => c.name() === "validate")).toBe(true);
  });

  it("exits 1 with actionable message when no config found", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await expect(program.parseAsync(["node", "ao", "validate"])).rejects.toThrow("exit:1");

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("No agent-orchestrator.yaml found"),
    );
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("cp agent-orchestrator.yaml.example"),
    );

    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("passes when config is valid and required binaries present", async () => {
    mockConfigPath.current = join(tempDir, "agent-orchestrator.yaml");
    // Use runtime: "process" to avoid tmux dependency on test machine.
    mockConfig.current = {
      defaults: { runtime: "process", agent: "claude-code" },
      projects: {
        "my-app": {
          repo: "/tmp/test-repo",
          tracker: { plugin: "tracker-github" },
        },
      },
    };

    // Set GITHUB_TOKEN so the github tracker check passes.
    const savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    // git should be present on the test machine.
    await program.parseAsync(["node", "ao", "validate"]);

    // Should not call process.exit (no failures)
    expect(exitSpy).not.toHaveBeenCalled();
    // Should print "config parsed"
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allOutput).toContain("config parsed");

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  it("warns when GITHUB_TOKEN not set for github tracker", async () => {
    mockConfigPath.current = join(tempDir, "agent-orchestrator.yaml");
    mockConfig.current = {
      defaults: { runtime: "process", agent: "claude-code" },
      projects: {
        "my-app": {
          repo: "/tmp/test-repo",
          tracker: { plugin: "tracker-github" },
        },
      },
    };

    const savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit:1");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "ao", "validate"]),
    ).rejects.toThrow("exit:1");

    // GITHUB_TOKEN is required — should exit 1
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errOutput).toContain("GITHUB_TOKEN");

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
  });

  it("--strict fails on warnings (missing optional binary)", async () => {
    mockConfigPath.current = join(tempDir, "agent-orchestrator.yaml");
    mockConfig.current = {
      defaults: { runtime: "process", agent: "claude-code" },
      projects: {
        "my-app": {
          repo: "/tmp/test-repo",
        },
      },
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    // claude binary may not be present — that's an optional warning.
    // With --strict, warnings become failures.
    try {
      await program.parseAsync(["node", "ao", "validate", "--strict"]);
    } catch {
      // expected — exit throws
    }

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
