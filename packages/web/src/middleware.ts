import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware: CSRF defense-in-depth + per-IP rate limiting.
 *
 * CSRF (issue #82): reject cross-origin state-changing API requests.
 * Browsers send the `Origin` header on all cross-origin requests
 * (and modern browsers send it on same-origin POST/PUT/PATCH/DELETE too). A
 * malicious website can't strip it. We compare Origin's host to the request's
 * own host (per the Fetch standard's same-origin definition) and 403 any
 * mismatch.
 *
 * Rate limiting (issue #63): in-memory sliding-window per-IP limits.
 * Prevents DoS by hammering /api/spawn, webhook floods, and enumeration
 * at scale. Returns 429 + Retry-After + X-RateLimit-* headers when exceeded.
 *
 * Non-browser clients (curl, the `ao` CLI, server-to-server) don't send
 * Origin and are allowed through — they're not subject to CSRF, which is a
 * browser-cookie attack. Webhook endpoints (`/api/webhooks/*`) are also
 * exempt from CSRF because they're called by SCM providers (GitHub, GitLab)
 * which send their own signature headers and may not send Origin.
 *
 * Config matcher (below) restricts this middleware to `/api/*` so it never
 * runs on the dashboard HTML/JS/CSS assets.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths under /api/ that accept third-party (non-browser) callers and must
// not be gated by Origin. Keep this list minimal — every exemption weakens
// the CSRF boundary.
const ORIGIN_EXEMPT_PATH_PREFIXES = ["/api/webhooks/"];

// ── Rate limiting (issue #63) ─────────────────────────────────────────
//
// In-memory sliding window. Per-IP. Tiered limits:
//   - Expensive routes (spawn, reviews/execute, sessions/*/kill): 10 req/min
//   - Webhook routes: 100 req/min (GitHub can send 10K+ events/min during incidents)
//   - Default: 60 req/min
//
// Window size: 60 seconds (1 minute). Sliding window = count requests in
// the last 60s. When limit exceeded, return 429 + Retry-After (seconds until
// oldest request in window expires) + X-RateLimit-* headers.
//
// Memory: each IP entry is a sorted array of timestamps. Entries are pruned
// on each request. A periodic sweep (every 5 min) removes IPs with no
// recent requests to bound memory. For multi-instance deployments, replace
// with Redis-backed limiter — documented below.

const WINDOW_MS = 60_000; // 1 minute

// Route-specific limits. Checked in order; first match wins.
const ROUTE_LIMITS: Array<{ prefix: string; limit: number }> = [
  // Expensive operations — spawning agents, executing reviews, killing sessions.
  { prefix: "/api/spawn", limit: 10 },
  { prefix: "/api/reviews/execute", limit: 10 },
  { prefix: "/api/sessions/", limit: 30 }, // covers /:id/kill, /:id/send, etc.
  // Webhook receiver — SCM providers can flood during incidents.
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

// IP → array of request timestamps (sorted ascending).
const ipRequests = new Map<string, number[]>();

// Periodic sweep — remove IPs with no requests in the last window.
// Runs lazily on every 100th request to avoid setInterval (which doesn't
// work well in serverless/edge contexts).
let requestCounter = 0;
function maybeSweep(): void {
  requestCounter++;
  if (requestCounter % 100 !== 0) return;
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, timestamps] of ipRequests) {
    // Remove all timestamps older than the window.
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      ipRequests.delete(ip);
    }
  }
}

/** Extract client IP from request. Falls back to "unknown" if no IP found. */
function getClientIP(request: NextRequest): string {
  // x-forwarded-for: "client, proxy1, proxy2" — first entry is the client.
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // x-real-ip: set by some proxies (nginx).
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  // Next.js doesn't expose socket address in middleware (edge runtime).
  // Fall back to "unknown" — all unknown-IP requests share a single bucket.
  return "unknown";
}

/** Check rate limit. Returns null if OK, or a 429 NextResponse if exceeded. */
function checkRateLimit(
  request: NextRequest,
  pathname: string,
): NextResponse | null {
  const limit = getLimit(pathname);
  const ip = getClientIP(request);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  maybeSweep();

  const timestamps = ipRequests.get(ip) ?? [];
  // Prune expired entries.
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    // Rate limited. Calculate Retry-After = seconds until oldest request
    // exits the window.
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + WINDOW_MS - now;
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const resetTimestamp = Math.ceil((oldestInWindow + WINDOW_MS) / 1000);

    return NextResponse.json(
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
    );
  }

  // Allowed — record this request.
  timestamps.push(now);
  ipRequests.set(ip, timestamps);

  // Return null to indicate "allowed". The caller will add rate limit headers
  // to the response.
  return null;
}

/** Add X-RateLimit-* headers to a response (for allowed requests). */
function addRateLimitHeaders(
  response: NextResponse,
  pathname: string,
): NextResponse {
  const limit = getLimit(pathname);
  const remaining = Math.max(0, limit - 1); // this request counts as 1
  const reset = Math.ceil((Date.now() + WINDOW_MS) / 1000);
  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  response.headers.set("X-RateLimit-Reset", String(reset));
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;

  // ── Rate limit check (issue #63) ────────────────────────────────────
  const rateLimitError = checkRateLimit(request, pathname);
  if (rateLimitError) {
    return rateLimitError;
  }

  // ── CSRF check (issue #82) ──────────────────────────────────────────
  if (!STATE_CHANGING_METHODS.has(request.method)) {
    return addRateLimitHeaders(NextResponse.next(), pathname);
  }

  if (ORIGIN_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return addRateLimitHeaders(NextResponse.next(), pathname);
  }

  const origin = request.headers.get("origin");
  // No Origin header → non-browser client (curl, CLI, server-to-server).
  // CSRF is a browser-cookie attack; non-browser clients can't be tricked
  // into sending authenticated requests by a malicious page. Allow.
  if (!origin) {
    return addRateLimitHeaders(NextResponse.next(), pathname);
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
    return addRateLimitHeaders(NextResponse.next(), pathname);
  }

  if (originHost !== requestHost) {
    return NextResponse.json(
      { error: "Cross-origin request blocked by CSRF protection" },
      { status: 403 },
    );
  }

  return addRateLimitHeaders(NextResponse.next(), pathname);
}

export const config = {
  // Only run on API routes — never on dashboard HTML/JS/CSS assets.
  matcher: ["/api/:path*"],
};
