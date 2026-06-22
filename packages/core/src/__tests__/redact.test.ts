import { describe, it, expect } from "vitest";
import { redactSecrets } from "../redact.js";

describe("redactSecrets", () => {
  it("redacts Anthropic API keys (sk-ant-)", () => {
    const input = "Auth failed for key sk-ant-proj-1234567890abcdef";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-ant-proj-1234567890abcdef");
    expect(out).toContain("[redacted]");
  });

  it("redacts OpenAI sk- keys (sk-proj-, sk-svcacct-)", () => {
    expect(redactSecrets("sk-proj-abcdefghijklmnop1234")).toBe("[redacted]");
    expect(redactSecrets("sk-svcacct-abcdefghijklmnop1234")).toBe("[redacted]");
    expect(redactSecrets("sk-abcdefghijklmnop1234")).toBe("[redacted]");
  });

  it("redacts GitHub classic PATs (ghp_/gho_/ghu_/ghs_/ghr_)", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${"a".repeat(36)}`;
      expect(redactSecrets(`token=${token}`)).not.toContain(token);
    }
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    const token = `github_pat_${"a".repeat(40)}`;
    expect(redactSecrets(token)).toBe("[redacted]");
  });

  it("redacts Bearer tokens (preserves the Bearer prefix for RCA)", () => {
    const out = redactSecrets("Authorization: Bearer abcdefghijklmnop1234");
    expect(out).toBe("Authorization: Bearer [redacted]");
    expect(out).not.toContain("abcdefghijklmnop1234");
  });

  it("redacts JWTs (eyJ prefix, three base64url segments)", () => {
    const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.eYtKx_vJmWxQzZ";
    const out = redactSecrets(`jwt: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[redacted]");
  });

  it("redacts AWS access key IDs (AKIA + 16 chars)", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  it("redacts Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-)", () => {
    expect(redactSecrets("xoxb-1234567890-abc")).toBe("[redacted]");
    expect(redactSecrets("xoxp-1234567890-abc")).toBe("[redacted]");
  });

  it("redacts ENV-style assignments for sensitive ALL_CAPS keys", () => {
    const out = redactSecrets("GITHUB_WEBHOOK_SECRET=whsecret123456");
    expect(out).toBe("GITHUB_WEBHOOK_SECRET=[redacted]");
    expect(out).not.toContain("whsecret123456");
  });

  it("redacts ENV-style assignments for *_API_KEY / *_TOKEN / *_PASSWORD", () => {
    expect(redactSecrets("MY_API_TOKEN=abcdef123456")).toBe("MY_API_TOKEN=[redacted]");
    expect(redactSecrets("DB_PASSWORD=hunter2pass")).toBe("DB_PASSWORD=[redacted]");
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-ant-test123")).toBe("ANTHROPIC_API_KEY=[redacted]");
  });

  it("does NOT redact prose that looks like key=value (lowercase, no sensitive word)", () => {
    expect(redactSecrets("the message=hello world")).toBe("the message=hello world");
    expect(redactSecrets("foo=bar baz=qux")).toBe("foo=bar baz=qux");
  });

  it("redacts URL credentials (https://token@host)", () => {
    const out = redactSecrets("https://ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/org/repo");
    expect(out).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("[redacted]");
    expect(out).toContain("github.com/org/repo");
  });

  it("redacts URL credentials with user:pass (https://user:pass@host)", () => {
    const out = redactSecrets("https://admin:hunter2@db.example.com");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted]");
    expect(out).toContain("db.example.com");
  });

  it("leaves non-credential URLs intact", () => {
    const url = "https://github.com/org/repo/pull/42";
    expect(redactSecrets(url)).toBe(url);
  });

  it("handles multiple secrets in one string", () => {
    const input =
      "keys: sk-ant-1234567890abcdef and ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and Bearer xyzabcdefghijklm";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-ant-1234567890abcdef");
    expect(out).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toContain("xyzabcdefghijklm");
    expect(out.match(/\[redacted\]/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves non-secret strings unchanged", () => {
    expect(redactSecrets("a normal error message about file not found")).toBe(
      "a normal error message about file not found",
    );
    expect(redactSecrets("")).toBe("");
  });
});
