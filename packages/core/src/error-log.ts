/**
 * Tiny structured fatal-error logger.
 *
 * Appends a single JSON line per fatal event to `~/.agent-orchestrator/error.log`
 * so daemon crashes (uncaughtException / unhandledRejection) leave a durable,
 * greppable trail without any external dependency. Best-effort: this logger
 * never throws — if it cannot write, it stays silent rather than masking the
 * original fatal error.
 *
 * Secret redaction (issue #97): fatal errors can carry secret values —
 * YAML parse errors interpolate the offending source line (which may contain
 * a webhook secret or API key), and thrown errors from plugin code may
 * include config values in `.message` / `.stack`. Both `message` and `stack`
 * are run through `redactSecrets` before being persisted so token-shaped
 * substrings and URL credentials never land on disk.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getEnvDefaults } from "./platform.js";
import { redactSecrets } from "./redact.js";

function errorLogPath(): string {
  return join(getEnvDefaults().HOME, ".agent-orchestrator", "error.log");
}

/** Append a structured fatal-error record. Swallows its own I/O errors. */
export function logFatal(scope: string, err: unknown): void {
  try {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const entry = {
      ts: new Date().toISOString(),
      scope,
      message: redactSecrets(rawMessage),
      stack: err instanceof Error ? redactSecrets(err.stack ?? "") : undefined,
    };
    const path = errorLogPath();
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Best-effort — never let logging mask the original failure.
  }
}
