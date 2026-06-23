import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware: CSRF defense-in-depth + bearer-token API authentication.
 *
 * CSRF (issue #82): reject cross-origin state-changing API requests.
 * Browsers send the `Origin` header on all cross-origin requests
 * (and modern browsers send it on same-origin POST/PUT/PATCH/DELETE too). A
 * malicious website can't strip it. We compare Origin's host to the request's
 * own host (per the Fetch standard's same-origin definition) and 403 any
 * mismatch.
 *
 * Auth (issue #62): if `AO_API_TOKEN` env var is set, all `/api/*` requests
 * (except webhooks + health) must include `Authorization: Bearer <token>`.
 * If unset (dev default), auth is skipped — local dev works without a token.
 * This is a static-token auth scheme suitable for single-operator / small-team
 * deployments. Multi-user auth (OAuth, sessions) is a larger feature and is
 * deferred.
 *
 * Non-browser clients (curl, the `ao` CLI, server-to-server) don't send
 * Origin and are allowed through — they're not subject to CSRF, which is a
 * browser-cookie attack. Webhook endpoints (`/api/webhooks/*`) are also
 * exempt from both CSRF + auth because they're called by SCM providers
 * (GitHub, GitLab) which send their own signature headers and may not send
 * Origin. The health endpoint (`/api/health`) is exempt from auth so
 * load balancers + monitoring can probe it without a token.
 *
 * Config matcher (below) restricts this middleware to `/api/*` so it never
 * runs on the dashboard HTML/JS/CSS assets.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths under /api/ that accept third-party (non-browser) callers and must
// not be gated by Origin or auth. Keep this list minimal — every exemption
// weakens the security boundary.
const ORIGIN_EXEMPT_PATH_PREFIXES = ["/api/webhooks/"];
const AUTH_EXEMPT_PATH_PREFIXES = ["/api/webhooks/", "/api/health"];

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Check bearer token auth. Returns null if OK, or a 401 NextResponse if rejected. */
function checkAuth(request: NextRequest, pathname: string): NextResponse | null {
  const expectedToken = process.env.AO_API_TOKEN;
  if (!expectedToken) {
    // No token configured → auth disabled (dev default).
    return null;
  }

  if (AUTH_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Authentication required. Set Authorization: Bearer <token> header." },
      { status: 401 },
    );
  }

  const providedToken = authHeader.slice(7); // "Bearer ".length
  if (!timingSafeEqual(providedToken, expectedToken)) {
    return NextResponse.json(
      { error: "Invalid authentication token." },
      { status: 401 },
    );
  }

  return null;
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;

  // ── Auth check (issue #62) ──────────────────────────────────────────
  const authError = checkAuth(request, pathname);
  if (authError) {
    return authError;
  }

  // ── CSRF check (issue #82) ──────────────────────────────────────────
  if (!STATE_CHANGING_METHODS.has(request.method)) {
    return NextResponse.next();
  }

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
