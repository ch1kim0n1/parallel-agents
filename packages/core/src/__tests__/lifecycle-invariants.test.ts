/**
 * Regression tests for lifecycle state machine invariants (issue #96).
 *
 * These tests pin the critical invariants documented in CLAUDE.md and the
 * issue body. They are intentionally exhaustive on the pure-function paths
 * (deriveLegacyStatus, resolveProbeDecision) because those are the single
 * authority on terminal decisions — a silent regression there causes
 * sessions to hang, leak, or incorrectly terminate.
 *
 * Invariants covered:
 *   B. deriveLegacyStatus maps ALL canonical lifecycle states to valid
 *      legacy statuses (no state returns undefined/null).
 *   C. resolveProbeDecision is the single authority on terminal decisions —
 *      it returns `terminated` ONLY when both probes are dead AND there is
 *      no recent activity. Every other probe combination returns `detecting`
 *      or `null` (no decision).
 *   E. pr_merged terminal reason maps to `cleanup` legacy status.
 *   F. deriveLegacyStatus handles every terminal reason explicitly (no
 *      falls-to-default for a valid enum value).
 *
 * Invariant A (sm.list() persists `detecting` not `terminated` on dead
 * runtime) and D (shutdown timeout) require integration-level setup with
 * disk I/O and mock session managers; they are tracked as follow-ups.
 */

import { describe, it, expect } from "vitest";
import {
  createInitialCanonicalLifecycle,
  deriveLegacyStatus,
} from "../lifecycle-state.js";
import { resolveProbeDecision, DETECTING_MAX_DURATION_MS } from "../lifecycle-status-decisions.js";
import { createActivitySignal } from "../activity-signal.js";
import type { CanonicalSessionLifecycle, SessionStatus } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeLifecycle(
  state: CanonicalSessionLifecycle["session"]["state"],
  reason?: CanonicalSessionLifecycle["session"]["reason"],
): CanonicalSessionLifecycle {
  const lc = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
  lc.session.state = state;
  if (reason) lc.session.reason = reason;
  lc.session.startedAt = lc.session.lastTransitionAt;
  lc.runtime.state = "alive";
  lc.runtime.reason = "process_running";
  return lc;
}

// All valid canonical session states (from lifecycle-state.ts schema).
const ALL_CANONICAL_STATES = [
  "not_started",
  "working",
  "idle",
  "needs_input",
  "stuck",
  "detecting",
  "done",
  "terminated",
] as const;

// All valid terminal reasons (from lifecycle-state.ts schema).
const ALL_TERMINAL_REASONS = [
  "manually_killed",
  "runtime_lost",
  "agent_process_exited",
  "probe_failure",
  "error_in_process",
  "auto_cleanup",
  "pr_merged",
] as const;

// All valid legacy statuses (from types.ts).
const VALID_LEGACY_STATUSES = new Set<SessionStatus>([
  "spawning",
  "working",
  "detecting",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "killed",
  "idle",
  "done",
  "terminated",
]);

// Probe result helper for resolveProbeDecision tests.
// The ProbeResult/ProbeDecisionInput types are internal to the module; we
// construct objects with the right shape and cast through the minimal
// interface the function reads.
function probe(state: "alive" | "dead" | "unknown", failed = false) {
  return { state, failed };
}

function probeInput(opts: {
  runtimeProbe?: ReturnType<typeof probe>;
  processProbe?: ReturnType<typeof probe>;
  activitySignal?: ReturnType<typeof createActivitySignal>;
  canProbeRuntimeIdentity?: boolean;
  currentAttempts?: number;
  activityEvidence?: string;
  idleWasBlocked?: boolean;
  detectingStartedAt?: string;
}) {
  return {
    currentAttempts: opts.currentAttempts ?? 0,
    runtimeProbe: opts.runtimeProbe ?? probe("alive"),
    processProbe: opts.processProbe ?? probe("alive"),
    canProbeRuntimeIdentity: opts.canProbeRuntimeIdentity ?? false,
    activitySignal: opts.activitySignal ?? createActivitySignal("valid", { activity: "active", timestamp: new Date() }),
    activityEvidence: opts.activityEvidence ?? "activity=active",
    idleWasBlocked: opts.idleWasBlocked ?? false,
    detectingStartedAt: opts.detectingStartedAt,
    previousEvidenceHash: undefined,
  } as unknown as Parameters<typeof resolveProbeDecision>[0];
}

// ── Invariant B: deriveLegacyStatus maps ALL canonical states ─────────

describe("Invariant B: deriveLegacyStatus maps every canonical state to a valid legacy status", () => {
  for (const state of ALL_CANONICAL_STATES) {
    it(`maps canonical state "${state}" to a valid legacy status`, () => {
      const lc = makeLifecycle(state);
      // For terminated, set a valid terminal reason so we exercise the
      // reason switch rather than the default branch.
      if (state === "terminated") {
        lc.session.reason = "manually_killed";
      }
      const result = deriveLegacyStatus(lc);
      expect(VALID_LEGACY_STATUSES.has(result)).toBe(true);
      expect(result).toBeDefined();
    });
  }
});

// ── Invariant F: deriveLegacyStatus handles every terminal reason ─────

describe("Invariant F: deriveLegacyStatus handles every terminal reason explicitly", () => {
  for (const reason of ALL_TERMINAL_REASONS) {
    it(`terminal reason "${reason}" maps to a specific (non-generic) legacy status`, () => {
      const lc = makeLifecycle("terminated", reason);
      const result = deriveLegacyStatus(lc);
      // Every terminal reason must map to a SPECIFIC status — not the
      // generic "terminated" fallback. The generic fallback is only for
      // future enum values that haven't been mapped yet.
      expect(result).not.toBe("terminated");
      expect(VALID_LEGACY_STATUSES.has(result)).toBe(true);
    });
  }

  it("maps manually_killed → killed", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "manually_killed"))).toBe("killed");
  });

  it("maps runtime_lost → killed", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "runtime_lost"))).toBe("killed");
  });

  it("maps agent_process_exited → errored (issue #96 gap — was falling to default)", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "agent_process_exited"))).toBe("errored");
  });

  it("maps probe_failure → errored", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "probe_failure"))).toBe("errored");
  });

  it("maps error_in_process → errored", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "error_in_process"))).toBe("errored");
  });

  it("maps auto_cleanup → cleanup", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "auto_cleanup"))).toBe("cleanup");
  });

  // ── Invariant E: pr_merged → cleanup ────────────────────────────────
  it("maps pr_merged → cleanup (Invariant E)", () => {
    expect(deriveLegacyStatus(makeLifecycle("terminated", "pr_merged"))).toBe("cleanup");
  });
});

// ── Invariant C: resolveProbeDecision is the sole terminal authority ──

describe("Invariant C: resolveProbeDecision returns terminated ONLY when both probes dead + no recent activity", () => {
  it("returns terminated when runtime=dead, process=dead, no recent activity", () => {
    const staleSignal = createActivitySignal("stale", { activity: "idle" });
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("dead"),
        processProbe: probe("dead"),
        activitySignal: staleSignal,
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("terminated");
    expect(decision!.sessionReason).toBe("runtime_lost");
  });

  it("returns null (no decision) when both probes are alive", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("alive"),
        processProbe: probe("alive"),
      }),
    );
    expect(decision).toBeNull();
  });

  it("returns detecting (NOT terminated) when runtime=dead, process=alive", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("dead"),
        processProbe: probe("alive"),
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns detecting (NOT terminated) when runtime=alive, process=dead", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("alive"),
        processProbe: probe("dead"),
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns detecting (NOT terminated) when runtime=dead, process=dead, BUT recent activity supports liveness", () => {
    // Even with both probes dead, recent activity means we can't conclude
    // the session is gone — escalate to detecting, not terminated.
    const recentActiveSignal = createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
    });
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("dead"),
        processProbe: probe("dead"),
        activitySignal: recentActiveSignal,
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns detecting when runtimeProbe failed (probe error, not death)", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("alive", true),
        processProbe: probe("alive"),
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns detecting when processProbe failed (probe error, not death)", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("alive"),
        processProbe: probe("alive", true),
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns detecting when runtime=dead, process=unknown, canProbeRuntimeIdentity=true", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("dead"),
        processProbe: probe("unknown"),
        canProbeRuntimeIdentity: true,
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.sessionState).toBe("detecting");
    expect(decision!.sessionState).not.toBe("terminated");
  });

  it("returns null when runtime=dead, process=unknown, canProbeRuntimeIdentity=false (can't decide)", () => {
    // Use a stale signal so the signal_disagreement branch (which fires on
    // runtime=dead + recent activity) doesn't trigger — we want to test the
    // fall-through to null when we can't probe runtime identity and there's
    // no recent activity to disagree with.
    const staleSignal = createActivitySignal("stale", { activity: "idle" });
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("dead"),
        processProbe: probe("unknown"),
        canProbeRuntimeIdentity: false,
        activitySignal: staleSignal,
      }),
    );
    // Falls through to the null return — no decision can be made.
    expect(decision).toBeNull();
  });

  it("returns null when both probes are unknown (no signal)", () => {
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe("unknown"),
        processProbe: probe("unknown"),
      }),
    );
    expect(decision).toBeNull();
  });

  // Exhaustive: enumerate all 9 probe-state combinations and assert none
  // return `terminated` unless both are `dead` AND no recent activity.
  it.each([
    ["alive", "alive"],
    ["alive", "dead"],
    ["alive", "unknown"],
    ["dead", "alive"],
    ["dead", "dead"],
    ["dead", "unknown"],
    ["unknown", "alive"],
    ["unknown", "dead"],
    ["unknown", "unknown"],
  ] as const)("probe combo runtime=%s process=%s does not return terminated when activity is recent", (rt, proc) => {
    const recentActive = createActivitySignal("valid", { activity: "active", timestamp: new Date() });
    const decision = resolveProbeDecision(
      probeInput({
        runtimeProbe: probe(rt),
        processProbe: probe(proc),
        activitySignal: recentActive,
        canProbeRuntimeIdentity: true,
      }),
    );
    if (decision) {
      expect(decision.sessionState).not.toBe("terminated");
    }
  });
});

// ── Detecting time-budget escalation (Invariant D analog) ─────────────

describe("Invariant D analog: detecting escalates after DETECTING_MAX_DURATION_MS", () => {
  it("DETECTING_MAX_DURATION_MS is 5 minutes (300000ms) — documents the time budget", () => {
    expect(DETECTING_MAX_DURATION_MS).toBe(5 * 60 * 1000);
  });
});
