/**
 * Tests for Sentry instrumentation (issue #66).
 *
 * Verifies that the instrumentation hooks gracefully skip Sentry init when
 * SENTRY_DSN is unset (dev default) and init when it is set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Sentry instrumentation (issue #66)", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalPublicDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn;
    else delete process.env.SENTRY_DSN;
    if (originalPublicDsn !== undefined) process.env.NEXT_PUBLIC_SENTRY_DSN = originalPublicDsn;
    else delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    vi.restoreAllMocks();
  });

  it("server instrumentation skips init when SENTRY_DSN unset", async () => {
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation");
    await register();

    expect(sentryInit).not.toHaveBeenCalled();
  });

  it("server instrumentation calls Sentry.init when SENTRY_DSN set", async () => {
    process.env.SENTRY_DSN = "https://test@sentry.example.com/1";
    process.env.SENTRY_ENVIRONMENT = "staging";
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation");
    await register();

    expect(sentryInit).toHaveBeenCalledTimes(1);
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://test@sentry.example.com/1",
        environment: "staging",
        sendDefaultPii: false,
      }),
    );
  });

  it("server instrumentation defaults environment to 'production'", async () => {
    process.env.SENTRY_DSN = "https://test@sentry.example.com/1";
    delete process.env.SENTRY_ENVIRONMENT;
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation");
    await register();

    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production" }),
    );
  });

  it("client instrumentation skips init when NEXT_PUBLIC_SENTRY_DSN unset", async () => {
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation-client");
    await register();

    expect(sentryInit).not.toHaveBeenCalled();
  });

  it("client instrumentation calls Sentry.init when NEXT_PUBLIC_SENTRY_DSN set", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://test@sentry.example.com/2";
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation-client");
    await register();

    expect(sentryInit).toHaveBeenCalledTimes(1);
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://test@sentry.example.com/2",
        sendDefaultPii: false,
      }),
    );
  });

  it("client instrumentation enables error replay (replaysOnErrorSampleRate=1.0)", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://test@sentry.example.com/3";
    const sentryInit = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init: sentryInit }));

    const { register } = await import("../../instrumentation-client");
    await register();

    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        replaysOnErrorSampleRate: 1.0,
        replaysSessionSampleRate: 0,
      }),
    );
  });
});
