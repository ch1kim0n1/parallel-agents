/**
 * Secret redaction for strings that may end up in durable logs.
 *
 * Used by `logFatal` (the uncaughtException / unhandledRejection sink that
 * writes `~/.agent-orchestrator/error.log`) and by `ConfigReadError` message
 * construction. Fatal errors and config-parse errors can carry secret values
 * in two ways:
 *
 *   1. YAML parse errors include the offending source line — if a syntax
 *      error lands on a line containing a webhook secret or API key, that
 *      line is interpolated into the error message verbatim.
 *   2. Thrown errors from plugin code may include config values in their
 *      `.message` or `.stack`.
 *
 * Without redaction at the durable sink, those secrets land in `error.log`
 * on disk and persist across restarts. This helper applies the same token-
 * shape patterns used by `activity-events.ts` and `notification-observability.ts`
 * so the three log paths share a consistent redaction surface.
 *
 * Issue #97.
 */

// Token-shape patterns matched against ANY string. Order: more-specific first.
// Replacement strings preserve informative prefixes ("Bearer [redacted]" so
// RCA can still see this was a bearer-auth failure).
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer auth headers (also catches JWTs prefixed with Bearer)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]"],
  // GitHub Personal Access Tokens — classic (ghp_/gho_/ghu_/ghs_/ghr_)
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  // GitHub fine-grained PATs
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  // OpenAI / Anthropic sk- keys (incl. sk-proj-, sk-svcacct-, sk-ant-)
  [/\bsk-(?:ant-)?(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  // AWS access key IDs (16 trailing chars exactly per AWS spec)
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  // JWTs — three base64url segments, eyJ prefix on header
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]"],
  // ENV-style assignments: MY_API_TOKEN=value, GITHUB_SECRET=..., etc.
  // Scoped to ALL_CAPS keys containing a sensitive word so prose like
  // "the message=hello" is not redacted.
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s"'`]{6,})/g,
    "$1=[redacted]",
  ],
];

// URL credentials: https://token@host or http://user:pass@host.
// Linear scan — find :// then scan forward for the next @ before a path
// separator or whitespace. O(n) worst case, no regex backtracking.
function redactCredentialUrls(input: string): string {
  let result = input;
  let offset = 0;
  while (offset < result.length) {
    const proto = result.indexOf("://", offset);
    if (proto === -1) break;
    if (proto < 4) {
      offset = proto + 3;
      continue;
    }
    const schemeEnd = result.slice(Math.max(0, proto - 5), proto).toLowerCase();
    if (!schemeEnd.endsWith("http") && !schemeEnd.endsWith("https")) {
      offset = proto + 3;
      continue;
    }

    let cursor = proto + 3;
    while (cursor < result.length) {
      const ch = result.charCodeAt(cursor);
      if (ch <= 0x20 || ch === 0x2f) break;
      if (ch === 0x40) {
        const before = result.slice(0, proto + 3).toLowerCase();
        const suffix = result.slice(cursor);
        result = before + "[redacted]" + suffix;
        offset = proto + 3 + "[redacted]".length + 1;
        break;
      }
      cursor++;
    }
    if (
      cursor >= result.length ||
      result.charCodeAt(cursor) <= 0x20 ||
      result.charCodeAt(cursor) === 0x2f
    ) {
      offset = proto + 3;
    }
  }
  return result;
}

/**
 * Redact token-shaped substrings and URL credentials from a string that is
 * about to be persisted to a durable log. Does NOT redact by object key —
 * callers here only have string messages and stacks, not structured objects.
 * Returns the redacted string.
 */
export function redactSecrets(input: string): string {
  let cleaned = redactCredentialUrls(input);
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned;
}
