import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function makeReq(
  method: string,
  pathname: string,
  opts?: { origin?: string; host?: string; forwardedHost?: string; auth?: string },
): NextRequest {
  const host = opts?.host ?? "localhost:3000";
  const url = `http://${host}${pathname}`;
  const headers: Record<string, string> = {};
  if (opts?.origin !== undefined) headers["origin"] = opts.origin;
  if (opts?.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts?.auth !== undefined) headers["authorization"] = opts.auth;
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
      // Cross-origin POST with wrong token: auth fails first (401), CSRF never checked.
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
