import { NextResponse, type NextRequest } from "next/server";

/**
 * CSRF defense-in-depth: reject cross-origin state-changing API requests.
 *
 * Issue #82. Browsers send the `Origin` header on all cross-origin requests
 * (and modern browsers send it on same-origin POST/PUT/PATCH/DELETE too). A
 * malicious website can't strip it. We compare Origin's host to the request's
 * own host (per the Fetch standard's same-origin definition) and 403 any
 * mismatch.
 *
 * This is the piece of CSRF protection that works WITHOUT authentication.
 * The remaining checklist items (SameSite=Strict session cookies, double-
 * submit tokens) are companion to auth (#1) and are intentionally deferred.
 *
 * Non-browser clients (curl, the `ao` CLI, server-to-server) don't send
 * Origin and are allowed through — they're not subject to CSRF, which is a
 * browser-cookie attack. Webhook endpoints (`/api/webhooks/*`) are also
 * exempt because they're called by SCM providers (GitHub, GitLab) which send
 * their own signature headers and may not send Origin.
 *
 * Config matcher (below) restricts this middleware to `/api/*` so it never
 * runs on the dashboard HTML/JS/CSS assets.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths under /api/ that accept third-party (non-browser) callers and must
// not be gated by Origin. Keep this list minimal — every exemption weakens
// the CSRF boundary.
const ORIGIN_EXEMPT_PATH_PREFIXES = ["/api/webhooks/"];

export function middleware(request: NextRequest): NextResponse {
  if (!STATE_CHANGING_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;
  if (ORIGIN_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");
  // No Origin header → non-browser client (curl, CLI, server-to-server).
  // CSRF is a browser-cookie attack; non-browser clients can't be tricked
  // into sending authenticated requests by a malicious page. Allow.
  if (!origin) {
    return NextResponse.next();
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json(
      { error: "Invalid Origin header" },
      { status: 403 },
    );
  }

  // Resolve the request's own host. Precedence: forwarded host (when behind
  // a reverse proxy), Host header (direct browser request), then nextUrl.host
  // (derived from the request URL — always available, used as a reliable
  // fallback in test environments where the Host header isn't auto-set).
  const requestHost =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  if (!requestHost) {
    // No host to compare against — can't make a same-origin decision.
    // Fail open rather than blocking legitimate requests through unusual
    // proxies. The Origin check still blocks the common CSRF vector when a
    // host is present (the normal case).
    return NextResponse.next();
  }

  if (originHost !== requestHost) {
    return NextResponse.json(
      { error: "Cross-origin request blocked by CSRF protection" },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  // Only run on API routes — never on dashboard HTML/JS/CSS assets.
  matcher: ["/api/:path*"],
};
