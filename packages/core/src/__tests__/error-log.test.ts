import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFatal } from "../error-log.js";

// Drive `errorLogPath()` into a per-test temp dir by overriding HOME.
let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ao-errorlog-"));
  origHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function readLog(): string {
  const path = join(tmpHome, ".agent-orchestrator", "error.log");
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

describe("logFatal — secret redaction (issue #97)", () => {
  it("writes a JSON entry with ts, scope, message", () => {
    logFatal("test-scope", new Error("boom"));
    const line = readLog().trim();
    const entry = JSON.parse(line);
    expect(entry.scope).toBe("test-scope");
    expect(entry.message).toBe("boom");
    expect(typeof entry.ts).toBe("string");
  });

  it("redacts Anthropic API keys from the error message", () => {
    const secret = "sk-ant-proj-1234567890abcdef";
    logFatal("auth", new Error(`Auth failed for key ${secret}`));
    const log = readLog();
    expect(log).not.toContain(secret);
    expect(log).toContain("[redacted]");
  });

  it("redacts GitHub PATs from the error message", () => {
    const token = `ghp_${"a".repeat(36)}`;
    logFatal("github", new Error(`token rejected: ${token}`));
    expect(readLog()).not.toContain(token);
  });

  it("redacts Bearer tokens (preserves prefix)", () => {
    logFatal("http", new Error("Authorization: Bearer abcdefghijklmnop1234"));
    const log = readLog();
    expect(log).toContain("Bearer [redacted]");
    expect(log).not.toContain("abcdefghijklmnop1234");
  });

  it("redacts secrets embedded in the stack trace", () => {
    const secret = "sk-ant-proj-1234567890abcdef";
    const err = new Error("config load failed");
    err.stack = `Error: config load failed\n    at loadConfig (/repo/config.ts:1:1)\n    at Object.<anonymous> (/repo/index.ts:2:2) // key=${secret}`;
    logFatal("config", err);
    const log = readLog();
    expect(log).not.toContain(secret);
    expect(log).toContain("[redacted]");
  });

  it("redacts ENV-style assignments (GITHUB_WEBHOOK_SECRET=...)", () => {
    logFatal("webhook", new Error("GITHUB_WEBHOOK_SECRET=whsecret123456 rejected"));
    const log = readLog();
    expect(log).toContain("GITHUB_WEBHOOK_SECRET=[redacted]");
    expect(log).not.toContain("whsecret123456");
  });

  it("redacts URL credentials in error messages", () => {
    logFatal(
      "clone",
      new Error("https://ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/org/repo failed"),
    );
    const log = readLog();
    expect(log).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(log).toContain("[redacted]");
    expect(log).toContain("github.com/org/repo");
  });

  it("handles non-Error values (string)", () => {
    logFatal("string-throw", "a plain string with sk-ant-1234567890abcdef");
    const log = readLog();
    expect(log).not.toContain("sk-ant-1234567890abcdef");
    expect(log).toContain("[redacted]");
  });

  it("does not corrupt non-secret error messages", () => {
    logFatal("fs", new Error("ENOENT: no such file or directory, open '/tmp/missing.yaml'"));
    const entry = JSON.parse(readLog().trim());
    expect(entry.message).toBe("ENOENT: no such file or directory, open '/tmp/missing.yaml'");
  });

  it("never throws when HOME points to a non-writable path", () => {
    process.env["HOME"] = "/nonexistent/path/that/cannot/be/created";
    expect(() => logFatal("nohome", new Error("still works"))).not.toThrow();
  });
});
