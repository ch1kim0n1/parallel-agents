import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware: CSRF defense-in-depth + bearer-token API auth + per-IP rate limiting.
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
 * Rate limiting (issue #63): in-memory sliding-window per-IP limits.
 * Prevents DoS by hammering /api/spawn, webhook floods, and enumeration
 * at scale. Returns 429 + Retry-After + X-RateLimit-* headers when exceeded.
 *
 * Non-browser clients (curl, the `ao` CLI, server-to-server) do not send
 * Origin and are allowed through — they are not subject to CSRF, which is a
 * browser-cookie attack. Webhook endpoints (`/api/webhooks/*`) are also
 * exempt from both CSRF + auth because they are called by SCM providers
 * (GitHub, GitLab) which send their own signature headers and may not send
 * Origin. The health endpoint (`/api/health`) is exempt from auth so
 * load balancers + monitoring can probe it without a token.
 *
 * Config matcher (below) restricts this middleware to `/api/*` so it never
 * runs on the dashboard HTML/JS/CSS assets.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const ORIGIN_EXEMPT_PATH_PREFIXES = ["/api/webhooks/"];
const AUTH_EXEMPT_PATH_PREFIXES = ["/api/webhooks/", "/api/health"];

// ── Auth (issue #62) ──────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function checkAuth(request: NextRequest, pathname: string): NextResponse | null {
  const expectedToken = process.env.AO_API_TOKEN;
  if (!expectedToken) {
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
  const providedToken = authHeader.slice(7);
  if (!timingSafeEqual(providedToken, expectedToken)) {
    return NextResponse.json(
      { error: "Invalid authentication token." },
      { status: 401 },
    );
  }
  return null;
}

// ── Rate limiting (issue #63) ─────────────────────────────────────────
//
// In-memory sliding window. Per-IP. Tiered limits:
//   - Expensive routes (spawn, reviews/execute, sessions/*/kill): 10 req/min
//   - Webhook routes: 100 req/min (GitHub can send 10K+ events/min during incidents)
//   - Default: 60 req/min
//
// Window size: 60 seconds (1 minute). When limit exceeded, return 429 +
// Retry-After (seconds until oldest request exits window) + X-RateLimit-* headers.
//
// Memory: each IP entry is a sorted array of timestamps. Entries are pruned
// on each request. A periodic sweep (every 100 requests) removes IPs with no
// recent requests to bound memory. For multi-instance deployments, replace
// with Redis-backed limiter.

const WINDOW_MS = 60_000;

const ROUTE_LIMITS: Array<{ prefix: string; limit: number }> = [
  { prefix: "/api/spawn", limit: 10 },
  { prefix: "/api/reviews/execute", limit: 10 },
  { prefix: "/api/sessions/", limit: 30 },
  { prefix: "/api/webhooks/", limit: 100 },
];

const DEFAULT_LIMIT = 60;

function getLimit(pathname: string): number {
  for (const route of ROUTE_LIMITS) {
    if (pathname.startsWith(route.prefix)) {
      return route.limit;
    }
  }
  return DEFAULT_LIMIT;
}

const ipRequests = new Map<string, number[]>();

let requestCounter = 0;
function maybeSweep(): void {
  requestCounter++;
  if (requestCounter % 100 !== 0) return;
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, timestamps] of ipRequests) {
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      ipRequests.delete(ip);
    }
  }
}

function getClientIP(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

function checkRateLimit(
  request: NextRequest,
  pathname: string,
): { error: NextResponse } | { remaining: number } {
  const limit = getLimit(pathname);
  const ip = getClientIP(request);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  maybeSweep();

  const timestamps = ipRequests.get(ip) ?? [];
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + WINDOW_MS - now;
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const resetTimestamp = Math.ceil((oldestInWindow + WINDOW_MS) / 1000);

    return {
      error: NextResponse.json(
        { error: "Rate limit exceeded. Try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(resetTimestamp),
          },
        },
      ),
    };
  }

  timestamps.push(now);
  ipRequests.set(ip, timestamps);
  return { remaining: limit - timestamps.length };
}

function addRateLimitHeaders(
  response: NextResponse,
  pathname: string,
  remaining: number,
): NextResponse {
  const limit = getLimit(pathname);
  const reset = Math.ceil((Date.now() + WINDOW_MS) / 1000);
  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  response.headers.set("X-RateLimit-Reset", String(reset));
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;

  // Rate limit first — cheapest check, denies DoS before auth processing.
  const rateResult = checkRateLimit(request, pathname);
  if ("error" in rateResult) {
    return rateResult.error;
  }
  const { remaining } = rateResult;

  // Auth check — runs after rate limiting.
  const authError = checkAuth(request, pathname);
  if (authError) {
    return authError;
  }

  // CSRF check — state-changing methods only.
  if (!STATE_CHANGING_METHODS.has(request.method)) {
    return addRateLimitHeaders(NextResponse.next(), pathname, remaining);
  }

  if (ORIGIN_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return addRateLimitHeaders(NextResponse.next(), pathname, remaining);
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return addRateLimitHeaders(NextResponse.next(), pathname, remaining);
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

  const requestHost =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  if (!requestHost) {
    return addRateLimitHeaders(NextResponse.next(), pathname, remaining);
  }

  if (originHost !== requestHost) {
    return NextResponse.json(
      { error: "Cross-origin request blocked by CSRF protection" },
      { status: 403 },
    );
  }

  return addRateLimitHeaders(NextResponse.next(), pathname, remaining);
}

export const config = {
  matcher: ["/api/:path*"],
};
