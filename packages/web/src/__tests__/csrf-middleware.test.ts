import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  opts?: { origin?: string; host?: string; forwardedHost?: string; auth?: string; xff?: string },
): NextRequest {
  const host = opts?.host ?? "localhost:3000";
  const url = `http://${host}${pathname}`;
  const headers: Record<string, string> = {};
  if (opts?.origin !== undefined) headers["origin"] = opts.origin;
  if (opts?.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts?.auth !== undefined) headers["authorization"] = opts.auth;
  if (opts?.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return new NextRequest(url, { method, headers });
}

function status(res: { status: number }): number {
  return res.status;
}

describe("CSRF middleware — Origin check (issue #82)", () => {
  describe("state-changing methods", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "allows same-origin %s (Origin host matches request host)",
      (m) => {
        const res = middleware(makeReq(m, "/api/spawn", { origin: "http://localhost:3000" }));
        expect(status(res)).toBe(200);
      },
    );

    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "blocks cross-origin %s with 403 (Origin host differs from request host)",
      (m) => {
        const res = middleware(
          makeReq(m, "/api/spawn", { origin: "http://evil.example.com" }),
        );
        expect(status(res)).toBe(403);
      },
    );

    it("blocks cross-origin POST even when origin scheme/port differ but host matches", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "http://localhost:3001" }),
      );
      expect(status(res)).toBe(403);
    });

    it("allows same-origin POST when scheme differs but host:port match (intentional — only compare host:port)", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "https://localhost:3000" }),
      );
      expect(status(res)).toBe(200);
    });
  });

  describe("non-browser clients (no Origin header)", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "allows %s with no Origin header (curl / CLI / server-to-server)",
      (m) => {
        const res = middleware(makeReq(m, "/api/spawn"));
        expect(status(res)).toBe(200);
      },
    );
  });

  describe("safe methods", () => {
    it.each(["GET", "HEAD", "OPTIONS"])("allows %s without Origin check", (m) => {
      const res = middleware(makeReq(m, "/api/sessions", { origin: "http://evil.example.com" }));
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

// ── Auth tests (issue #62) ───────────────────────────────────────────

describe("Auth middleware — bearer token (issue #62)", () => {
  const originalToken = process.env.AO_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.AO_API_TOKEN;
    else process.env.AO_API_TOKEN = originalToken;
  });

  describe("when AO_API_TOKEN is unset (dev default)", () => {
    beforeEach(() => delete process.env.AO_API_TOKEN);

    it("allows GET without Authorization header", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(status(res)).toBe(200);
    });

    it("allows POST without Authorization header", () => {
      const res = middleware(makeReq("POST", "/api/spawn"));
      expect(status(res)).toBe(200);
    });
  });

  describe("when AO_API_TOKEN is set", () => {
    beforeEach(() => {
      process.env.AO_API_TOKEN = "secret-token-123";
    });

    it("rejects GET without Authorization header (401)", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(status(res)).toBe(401);
    });

    it("rejects POST without Authorization header (401)", () => {
      const res = middleware(makeReq("POST", "/api/spawn"));
      expect(status(res)).toBe(401);
    });

    it("rejects GET with wrong token (401)", () => {
      const res = middleware(makeReq("GET", "/api/sessions", { auth: "Bearer wrong-token" }));
      expect(status(res)).toBe(401);
    });

    it("rejects GET with malformed Authorization header (401)", () => {
      const res = middleware(makeReq("GET", "/api/sessions", { auth: "Token secret-token-123" }));
      expect(status(res)).toBe(401);
    });

    it("rejects GET with empty Bearer (401)", () => {
      const res = middleware(makeReq("GET", "/api/sessions", { auth: "Bearer " }));
      expect(status(res)).toBe(401);
    });

    it("allows GET with correct Bearer token (200)", () => {
      const res = middleware(makeReq("GET", "/api/sessions", { auth: "Bearer secret-token-123" }));
      expect(status(res)).toBe(200);
    });

    it("allows POST with correct Bearer token (200)", () => {
      const res = middleware(makeReq("POST", "/api/spawn", { auth: "Bearer secret-token-123" }));
      expect(status(res)).toBe(200);
    });

    it("exempts /api/health from auth (no token needed)", () => {
      const res = middleware(makeReq("GET", "/api/health"));
      expect(status(res)).toBe(200);
    });

    it("exempts /api/webhooks/* from auth (SCM providers)", () => {
      const res = middleware(makeReq("POST", "/api/webhooks/github"));
      expect(status(res)).toBe(200);
    });

    it("auth runs before CSRF — wrong token gets 401 not 403", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", {
          origin: "http://evil.example.com",
          auth: "Bearer wrong-token",
        }),
      );
      expect(status(res)).toBe(401);
    });

    it("correct token + cross-origin POST still gets 403 (CSRF applies after auth)", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", {
          origin: "http://evil.example.com",
          auth: "Bearer secret-token-123",
        }),
      );
      expect(status(res)).toBe(403);
    });

    it("correct token + same-origin POST passes both auth + CSRF (200)", () => {
      const res = middleware(
        makeReq("POST", "/api/spawn", {
          origin: "http://localhost:3000",
          auth: "Bearer secret-token-123",
        }),
      );
      expect(status(res)).toBe(200);
    });
  });
});

// ── Rate limiting tests (issue #63) ──────────────────────────────────

describe("Rate limiting middleware (issue #63)", () => {
  describe("X-RateLimit-* headers on allowed requests", () => {
    it("sets X-RateLimit-Limit header on GET", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    });

    it("sets X-RateLimit-Remaining: 59 after first GET (limit 60)", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
    });

    it("sets X-RateLimit-Reset header on GET (future Unix timestamp)", () => {
      const res = middleware(makeReq("GET", "/api/sessions"));
      const reset = res.headers.get("X-RateLimit-Reset");
      expect(reset).not.toBeNull();
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

    it("X-RateLimit-Remaining decrements on each request", () => {
      middleware(makeReq("POST", "/api/spawn")); // 1st: remaining = 9
      const res = middleware(makeReq("POST", "/api/spawn")); // 2nd: remaining = 8
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("8");
    });
  });

  describe("429 on limit exceeded", () => {
    it("returns 429 after 10 POST /api/spawn (limit 10)", () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = middleware(makeReq("POST", "/api/spawn"));
        statuses.push(res.status);
      }
      expect(statuses[9]).toBe(200);
      expect(statuses[10]).toBe(429);
    });

    it("429 response includes Retry-After header", () => {
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
      for (let i = 0; i < 9; i++) {
        middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      }
      const resB = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.2" }));
      expect(resB.status).toBe(200);
      expect(resB.headers.get("X-RateLimit-Remaining")).toBe("9");

      const resA10 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      expect(resA10.status).toBe(200);

      const resA11 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1" }));
      expect(resA11.status).toBe(429);
    });

    it("uses x-forwarded-for first IP (client, not proxy)", () => {
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1, 10.0.0.2" }));
      }
      const res = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.1, 10.0.0.2" }));
      expect(res.status).toBe(429);

      const res2 = middleware(makeReq("POST", "/api/spawn", { xff: "10.0.0.3, 10.0.0.2" }));
      expect(res2.status).toBe(200);
    });
  });

  describe("rate limit runs before CSRF and auth", () => {
    it("429 on rate limit even for cross-origin request (rate checked first)", () => {
      for (let i = 0; i < 10; i++) {
        middleware(makeReq("POST", "/api/spawn", { origin: "http://localhost:3000" }));
      }
      const res = middleware(
        makeReq("POST", "/api/spawn", { origin: "http://evil.example.com" }),
      );
      expect(res.status).toBe(429);
    });

    it("429 on rate limit even for unauthenticated request when token is set", () => {
      process.env.AO_API_TOKEN = "secret-token-123";
      try {
        for (let i = 0; i < 10; i++) {
          middleware(makeReq("POST", "/api/spawn", { auth: "Bearer secret-token-123" }));
        }
        const res = middleware(makeReq("POST", "/api/spawn"));
        expect(res.status).toBe(429);
      } finally {
        delete process.env.AO_API_TOKEN;
      }
    });
  });
});
