/**
 * Next.js client instrumentation hook — runs once in the browser.
 *
 * Initializes Sentry for client-side error reporting if SENTRY_DSN is set.
 * Gracefully skips if SENTRY_DSN is unset (dev default).
 *
 * Issue #66: client-side errors (React render errors, WebSocket failures,
 * terminal disconnects) were silently lost. Now they're reported to Sentry
 * when configured.
 */

export async function register(): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0, // capture replay on errors (no terminal content — replays capture DOM, not canvas)
    sendDefaultPii: false,
  });
}
