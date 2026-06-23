/**
 * Tiny structured fatal-error logger with rotation (issue #73).
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
 *
 * Rotation: when the log exceeds 10MB, it's rotated to error.log.1, .2, .3
 * (max 3 rotations). The oldest is deleted. This prevents unbounded growth
 * (issue #73) while preserving recent crash history.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getEnvDefaults } from "./platform.js";
import { redactSecrets } from "./redact.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 3;

function errorLogPath(): string {
  return join(getEnvDefaults().HOME, ".agent-orchestrator", "error.log");
}

/** Rotate the log if it exceeds MAX_LOG_BYTES. Best-effort — swallows errors. */
function rotateIfNeeded(path: string): void {
  try {
    const stats = statSync(path);
    if (stats.size < MAX_LOG_BYTES) return;

    // Delete oldest rotation, shift others up.
    const oldest = `${path}.${MAX_ROTATIONS}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }
    // Current log -> .1
    renameSync(path, `${path}.1`);
  } catch {
    // Best-effort — if rotation fails, continue appending to the current log.
  }
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
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Best-effort — never let logging mask the original failure.
  }
}
