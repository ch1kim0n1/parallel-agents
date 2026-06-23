import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const homeDir = os.homedir().replace(/\\/g, "/");
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Standalone output for containerized deployments (issue #72).
  // Produces a minimal .next/standalone/ dir with only needed deps.
  output: "standalone",
  transpilePackages: [
    "@aoagents/ao-plugin-agent-claude-code",
    "@aoagents/ao-plugin-agent-codex",
    "@aoagents/ao-plugin-agent-opencode",
    "@aoagents/ao-plugin-runtime-tmux",
    "@aoagents/ao-plugin-scm-github",
    "@aoagents/ao-plugin-tracker-github",
    "@aoagents/ao-plugin-tracker-linear",
    "@aoagents/ao-plugin-workspace-worktree",
  ],
  serverExternalPackages: ["yaml", "zod", "@aoagents/ao-core", "better-sqlite3"],
  webpack: (config, { isServer }) => {
    if (process.platform === "win32") {
      config.snapshot = {
        ...config.snapshot,
        managedPaths: [/^(.+?[\\/]node_modules[\\/])/],
      };
      // Prevent nft from globbing the home directory during server file tracing.
      // ao-core resolves paths like ~/.agent-orchestrator at runtime; nft tries to
      // scan them at build time and hits EPERM on Windows junction points
      // (e.g. C:\Users\<user>\Application Data).
      if (isServer) {
        const tracePlugin = config.plugins.find(
          (p) => p.constructor?.name === "TraceEntryPointsPlugin",
        );
        if (tracePlugin) {
          tracePlugin.traceIgnores = [...(tracePlugin.traceIgnores ?? []), `${homeDir}/**`];
        }
      }
    }
    return config;
  },
  async headers() {
    return [
      {
        // Security headers applied to every route (issue #93).
        // CSP is defense-in-depth: blocks XSS escalation if a future code
        // path renders unescaped user input. Tightened to 'self' for
        // scripts/styles/images/fonts; connect-src allows same-origin +
        // ws/wss for the terminal WebSocket + SSE stream.
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          // HSTS: only enforced by browsers over HTTPS; ignored on http.
          // 1 year + preload. Remove preload if not submitting to the HSTS
          // preload list (otherwise you can't easily remove the domain).
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js dev/prod injects inline scripts for hydration data;
              // allow 'unsafe-inline' for scripts only (style-src stays
              // strict). Tightening to nonces requires next.config nonce
              // plumbing — tracked as a follow-up.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              // connect-src: same-origin + ws/wss for terminal WebSocket.
              "connect-src 'self' ws: wss:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
              "worker-src 'self' blob:",
            ].join("; "),
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

// Only load bundle analyzer when ANALYZE=true (dev-only dependency)
let config = nextConfig;
if (process.env.ANALYZE === "true") {
  const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
  config = bundleAnalyzer({ enabled: true })(nextConfig);
}

export default config;
