import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function makeReq(
  method: string,
  pathname: string,
  opts?: { origin?: string; host?: string; forwardedHost?: string },
): NextRequest {
  const host = opts?.host ?? "localhost:3000";
  const url = `http://${host}${pathname}`;
  const headers: Record<string, string> = {};
  if (opts?.origin !== undefined) headers["origin"] = opts.origin;
  if (opts?.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
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
