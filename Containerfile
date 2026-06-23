# syntax=docker/dockerfile:1
#
# AgentMesh Containerfile (issue #72).
# Multi-stage: build → production. Works with both Docker and Podman.
#
# Image layout:
#   Stage 1 (builder): full toolchain, builds all packages
#   Stage 2 (runtime): minimal — only standalone Next.js + CLI + git
#
# Runtime requirements:
#   - Node.js 20 (LTS)
#   - git (worktree support)
#   - No tmux needed — runtime-process plugin is the default in containers
#
# Usage:
#   docker build -t agentmesh .
#   docker run -p 3000:3000 -v ~/.agent-orchestrator:/data agentmesh
#
# Or with Podman:
#   podman build -t agentmesh .
#   podman run -p 3000:3000 -v ~/.agent-orchestrator:/data:Z agentmesh

# ── Stage 1: Builder ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy lockfile + workspace manifests first for cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/ao/package.json packages/ao/
COPY packages/plugins/*/package.json packages/plugins/

# Install all deps (including devDeps for build).
RUN pnpm install --frozen-lockfile

# Copy source.
COPY . .

# Build all packages.
RUN pnpm build

# ── Stage 2: Runtime ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy standalone Next.js output (minimal server + traced deps).
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

# Copy CLI dist (for `ao` commands inside container).
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/ao/dist ./packages/ao/dist
COPY --from=builder /app/packages/ao/bin ./packages/ao/bin

# Copy plugin dists.
COPY --from=builder /app/packages/plugins ./packages/plugins

# Copy example config + legal docs.
COPY agent-orchestrator.yaml.example ./
COPY TERMS.md PRIVACY.md SECURITY.md ./

# Data volume: ~/.agent-orchestrator persists across container restarts.
ENV AO_HOME=/data
ENV HOME=/data
VOLUME /data

# Dashboard port.
EXPOSE 3000

# Health check — probe the dashboard's /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the dashboard server. The standalone server.js is at repo root
# in the standalone output (Next.js traces it there).
CMD ["node", "packages/web/server.js"]
