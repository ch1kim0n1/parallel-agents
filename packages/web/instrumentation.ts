/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * Initializes Sentry for server-side error reporting if SENTRY_DSN is set.
 * Gracefully skips if SENTRY_DSN is unset (dev default) so local dev is
 * unaffected.
 *
 * Issue #66: Sentry was installed (@sentry/nextjs in package.json) but
 * never initialized — all production errors went only to the local
 * ~/.agent-orchestrator/error.log file, invisible to operators.
 */

export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    // Dev default — no Sentry. Errors fall back to error-log.ts.
    return;
  }

  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    // Performance monitoring — sample 10% in prod to control cost.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Session replay — disabled by default to avoid capturing terminal
    // content. Enable via env if needed for debugging.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Don't send PII (IP, user agent) — AO stores PR author names and
    // commit messages which may contain PII.
    sendDefaultPii: false,
  });
}
