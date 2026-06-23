import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Re-import middleware fresh for each test to reset rate limiter state.
// The rate limiter uses module-level Map — vi.resetModules() clears it.
import type { middleware as middlewareType } from "@/middleware";
let middleware: typeof middlewareType;

beforeEach(async () => {
  vi.resetModules();
  ({ middleware } = await import("@/middleware"));
});

function makeReq(
  method: string,
  pathname: string,
  opts?: { origin?: string; host?: string; forwardedHost?: string; xff?: string },
): NextRequest {
  const host = opts?.host ?? "localhost:3000";
  const url = `http://${host}${pathname}`;
  const headers: Record<string, string> = {};
  if (opts?.origin !== undefined) headers["origin"] = opts.origin;
  if (opts?.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts?.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return new NextRequest(url, { method, headers });
}

function status(res: ReturnType<typeof middleware>): number {
  return res.status;
}

describe("CSRF middleware — Origin check (issue #82)", () => {
  describe("state-changing methods", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "allows same-origin %s (Origin host matches request host)",
      (method) => {
        const res = middleware(makeReq(method, "/api/spawn", { origin: "http://localhost:3000" }));
        expect(status(res)).toBe(200);
      },
    );

    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "blocks cross-origin %s with 403 (Origin host differs from request host)",
      (method) => {
        const res = middleware(
          makeReq(method, "/api/spawn", { origin: "http://evil.example.com" }),
        );
        expect(status(res)).toBe(403);
        // Body should explain the CSRF block
        // NextResponse.json returns a Response; inspect via .json()
      },
    );

    it("blocks cross-origin POST even when origin scheme/port differ but host matches", () => {
      // http://localhost:3000 vs http://localhost:3001 — different port = different host
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "http://localhost:3001" }),
      );
      expect(status(res)).toBe(403);
    });

    it("allows same-origin POST when scheme differs but host:port match (Fetch standard same-origin is scheme+host+port)", () => {
      // Different scheme (http vs https) IS cross-origin per Fetch standard.
      // This test documents that we compare full host (including port), and
      // scheme is part of the URL but we only compare .host (host:port).
      // A same-host different-scheme request is technically cross-origin,
      // but for a localhost dev server behind no TLS this is the common case
      // and blocking it would break dev workflows. We intentionally only
      // compare host:port, not scheme.
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "https://localhost:3000" }),
      );
      expect(status(res)).toBe(200);
    });
  });

  describe("non-browser clients (no Origin header)", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "allows %s with no Origin header (curl / CLI / server-to-server)",
      (method) => {
        const res = middleware(makeReq(method, "/api/spawn"));
        expect(status(res)).toBe(200);
      },
    );
  });

  describe("safe methods", () => {
    it.each(["GET", "HEAD", "OPTIONS"])("allows %s without Origin check", (method) => {
      const res = middleware(makeReq(method, "/api/sessions", { origin: "http://evil.example.com" }));
      expect(status(res)).toBe(200);
    });
  });

  describe("webhook exemption", () => {
    it("allows cross-origin POST to /api/webhooks/* (SCM providers)", () => {
      const res = middleware(
        makeReq("POST", "/api/webhooks/github", { origin: "http://github.com" }),
      );
      expect(status(res)).toBe(200);
    });

    it("allows POST to /api/webhooks/* with no Origin", () => {
      const res = middleware(makeReq("POST", "/api/webhooks/github"));
      expect(status(res)).toBe(200);
    });
  });

  describe("proxy / forwarded host", () => {
    it("uses x-forwarded-host when present (behind reverse proxy)", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", {
          origin: "https://dashboard.example.com",
          forwardedHost: "dashboard.example.com",
          host: "10.0.0.1:3000",
        }),
      );
      expect(status(res)).toBe(200);
    });

    it("blocks when Origin matches direct host but not forwarded host (prefers forwarded)", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", {
          origin: "http://10.0.0.1:3000",
          forwardedHost: "dashboard.example.com",
          host: "10.0.0.1:3000",
        }),
      );
      expect(status(res)).toBe(403);
    });
  });

  describe("malformed Origin", () => {
    it("blocks 403 on unparseable Origin header", () => {
      const res = middleware(makeReq("POST", "/api/spawn", { origin: "not-a-url" }));
      expect(status(res)).toBe(403);
    });
  });

  describe("matcher scope", () => {
    // The config.matcher restricts middleware to /api/*. We can't easily test
    // the matcher itself (it's evaluated by Next.js before middleware runs),
    // but we verify the middleware function is a no-op for safe methods so
    // even if a non-API route slipped through, GETs are unaffected.
    it("middleware is a no-op for GET on any path", () => {
      const res = middleware(
        makeReq("GET", "/some/random/path", { origin: "http://evil.example.com" }),
      );
      expect(status(res)).toBe(200);
    });
  });
});

function method(m: string): string {
  return m;
}

// ── Rate limiting tests (issue #63) ──────────────────────────────────

describe("Rate limiting middleware (issue #63)", () => {
  describe("X-RateLimit-* headers on allowed requests", () => {
    it("sets X-RateLimit-Limit header on GET", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    });

    it("sets X-RateLimit-Remaining header on GET", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
    });

    it("sets X-RateLimit-Reset header on GET", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      const reset = res.headers.get("X-RateLimit-Reset");
      expect(reset).not.toBeNull();
      // Should be a Unix timestamp (seconds) in the future.
      const resetNum = Number(reset);
      expect(resetNum).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("sets stricter limit on /api/spawn (10/min)", () => {
      const res = middleware(makeReq("POST", "/api/spawn"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    });

    it("sets stricter limit on /api/reviews/execute (10/min)", () => {
      const res = middleware(makeReq("POST", "/api/reviews/execute"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    });

    it("sets higher limit on /api/webhooks/* (100/min)", () => {
      const res = middleware(makeReq("POST", "/api/webhooks/github"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    });
  });

  describe("429 on limit exceeded", () => {
    it("returns 429 after 10 POST /api/spawn (limit 10)", () => {
      // First 9 should pass (200), 10th should be 429.
      // Note: each test gets fresh module state via beforeEach.
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = middleware(makeReq("POST", "/api/spawn"));
        statuses.push(res.status);
      }
      // First 10 pass (200), 11th gets 429.
      expect(statuses[9]).toBe(200);
      expect(statuses[10]).toBe(429);
    });

    it("429 response includes Retry-After header", () => {
      // Exhaust the limit.
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn"));
      }
      const res = middleware(makeReq("POST", "/api/spawn"));
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it("429 response includes X-RateLimit-Remaining: 0", () => {
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn"));
      }
      const res = middleware(makeReq("POST", "/api/spawn"));
      expect(res.status).toBe(429);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    });

    it("default limit (60/min) allows 60 GETs, 429 on 61st", () => {
      const statuses: number[] = [];
      for (let i = 0; i < 61; i++) {
        const res = middleware(makeReq("GET", "/api/projects"));
        statuses.push(res.status);
      }
      expect(statuses[59]).toBe(200);
      expect(statuses[60]).toBe(429);
    });
  });

  describe("per-IP isolation", () => {
    it("limits are per-IP — different IPs have separate buckets", () => {
      // IP A uses 9 of 10 spawn requests.
      for (let i = 0; i < 9; i++) {
        middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      }
      // IP B should still have full quota.
      const resB = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.2" }));
      expect(resB.status).toBe(200);
      expect(resB.headers.get("X-RateLimit-Remaining")).toBe("9");

      // IP A's 10th request passes.
      const resA10 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      expect(resA10.status).toBe(200);

      // IP A's 11th request gets 429.
      const resA11 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      expect(resA11.status).toBe(429);
    });

    it("uses x-forwarded-for first IP (client, not proxy)", () => {
      // "10.0.0.1, 10.0.0.2" — client is 10.0.0.1.
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1, 10.0.0.2" }));
      }
      // Same client IP → 429.
      const res = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1, 10.0.0.2" }));
      expect(res.status).toBe(429);

      // Different client IP through same proxy → 200.
      const res2 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.3, 10.0.0.2" }));
      expect(res2.status).toBe(200);
    });
  });

  describe("rate limit runs before CSRF", () => {
    it("429 on rate limit even for cross-origin request (rate checked first)", () => {
      // Exhaust limit with same-origin requests.
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn", { origin: "http://localhost:3000" }));
      }
      // Cross-origin request should get 429 (rate limit), not 403 (CSRF).
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "http://evil.example.com" }),
      );
      expect(res.status).toBe(429);
    });
  });
});
