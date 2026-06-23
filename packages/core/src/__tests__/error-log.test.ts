/**
 * Tests for error-log.ts — secret redaction (issue #97) and rotation (issue #73).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getEnvDefaults to point HOME at a per-test temp dir.
const tempHome = vi.hoisted(() => ({ current: "" as string }));

vi.mock("../platform.js", () => ({
  getEnvDefaults: () => ({ HOME: tempHome.current, TMPDIR: "/tmp" }),
}));

import { logFatal } from "../error-log.js";

describe("error-log", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-error-log-"));
    tempHome.current = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function logPath(): string {
    return join(tempDir, ".agent-orchestrator", "error.log");
  }

  describe("secret redaction (issue #97)", () => {
    it("writes a JSON entry with ts, scope, message", () => {
      logFatal("test-scope", new Error("test error"));
      expect(existsSync(logPath())).toBe(true);
      const entry = JSON.parse(readFileSync(logPath(), "utf-8").trim());
      expect(entry.scope).toBe("test-scope");
      expect(entry.message).toBe("test error");
      expect(entry.ts).toBeDefined();
    });

    it("redacts API key-shaped tokens in message", () => {
      logFatal("auth", new Error("invalid token sk-ant-1234567890abcdef"));
      const log = readFileSync(logPath(), "utf-8");
      expect(log).not.toContain("sk-ant-1234567890abcdef");
      expect(log).toContain("[redacted]");
    });

    it("redacts URL credentials in stack trace", () => {
      const err = new Error("fetch failed");
      err.stack = "Error: fetch failed\n  at https://user:secret@api.example.com/v1";
      logFatal("fetch", err);
      const log = readFileSync(logPath(), "utf-8");
      expect(log).not.toContain("secret");
    });

    it("does not corrupt non-secret error messages", () => {
      logFatal("fs", new Error("ENOENT: no such file or directory, open '/tmp/missing.yaml'"));
      const entry = JSON.parse(readFileSync(logPath(), "utf-8").trim());
      expect(entry.message).toBe("ENOENT: no such file or directory, open '/tmp/missing.yaml'");
    });

    it("never throws when HOME points to a non-writable path", () => {
      tempHome.current = "/nonexistent/path/that/cannot/be/created";
      expect(() => logFatal("nohome", new Error("still works"))).not.toThrow();
    });
  });

  describe("rotation (issue #73)", () => {
    it("does not rotate when log is under 10MB", () => {
      logFatal("scope", "small error");
      expect(existsSync(`${logPath()}.1`)).toBe(false);
    });

    it("rotates when log exceeds 10MB", () => {
      const logDir = join(tempDir, ".agent-orchestrator");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(logPath(), "x".repeat(11 * 1024 * 1024), "utf-8");

      logFatal("scope", "trigger rotation");

      expect(existsSync(`${logPath()}.1`)).toBe(true);
      expect(existsSync(logPath())).toBe(true);
      expect(readFileSync(logPath(), "utf-8")).toContain("trigger rotation");
    });

    it("keeps max 3 rotations, deletes oldest", () => {
      const logDir = join(tempDir, ".agent-orchestrator");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(`${logPath()}.1`, "rot1");
      writeFileSync(`${logPath()}.2`, "rot2");
      writeFileSync(`${logPath()}.3`, "rot3");
      writeFileSync(logPath(), "x".repeat(11 * 1024 * 1024), "utf-8");

      logFatal("scope", "trigger");

      expect(existsSync(`${logPath()}.3`)).toBe(true);
      expect(readFileSync(`${logPath()}.3`, "utf-8")).toBe("rot2");
      expect(existsSync(`${logPath()}.4`)).toBe(false);
    });

    it("swallows I/O errors silently (best-effort)", () => {
      writeFileSync(join(tempDir, "a-file"), "not a dir");
      tempHome.current = join(tempDir, "a-file");
      expect(() => logFatal("scope", "test")).not.toThrow();
    });

    it("handles non-Error objects", () => {
      logFatal("scope", "string error");
      logFatal("scope", { custom: "object" });
      const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).message).toBe("string error");
    });
  });
});
