import { NextResponse } from "next/server";
import { getGlobalConfigPath } from "@aoagents/ao-core";
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

interface HealthCheck {
  status: "ok" | "fail";
  detail?: string;
}

/**
 * Liveness + readiness probe (issue #67).
 *
 * `/api/health` returns 200 when all critical dependencies are ready:
 *   - config loaded (getServices succeeds → config + plugins initialized)
 *   - storage directory is writable (global config dir)
 *
 * Returns 503 with a per-check breakdown when any dependency is not ready,
 * so Kubernetes/systemd/load-balancers stop routing traffic to a broken
 * instance instead of getting a false-positive 200.
 *
 * The response body always includes `version` and a `checks` map so
 * operators can see which dependency is degraded without scraping logs.
 */
export async function GET(): Promise<Response> {
  const { version } = (await import("../../../../package.json", { with: { type: "json" } }))
    .default as { version: string };

  const checks: Record<string, HealthCheck> = {};
  let allOk = true;

  // 1. Config + plugins loaded (getServices is the singleton that lazy-inits
  //    config loading + plugin registry creation). If this throws, the
  //    dashboard can't serve any route meaningfully.
  try {
    await getServices();
    checks.config = { status: "ok" };
  } catch (err) {
    allOk = false;
    checks.config = {
      status: "fail",
      detail: err instanceof Error ? err.message : "config load failed",
    };
  }

  // 2. Storage directory writable. The global config dir holds session
  //    metadata, worktrees, and archives — if it's not writable, spawns
  //    and metadata updates silently fail.
  try {
    const globalConfigPath = getGlobalConfigPath();
    const storageDir = dirname(globalConfigPath);
    accessSync(storageDir, constants.W_OK | constants.R_OK);
    checks.storage = { status: "ok" };
  } catch (err) {
    allOk = false;
    checks.storage = {
      status: "fail",
      detail: err instanceof Error ? err.message : "storage dir not accessible",
    };
  }

  const status = allOk ? "ok" : "degraded";
  return NextResponse.json(
    { status, version, checks },
    { status: allOk ? 200 : 503 },
  );
}
