# Deploying AgentMesh on a Server

This guide covers running AgentMesh on a remote machine or VPS so your whole team can share one dashboard.

## Prerequisites

- Node.js 20.18.3+ (`node --version`)
- Git 2.25+ (`git --version`)
- GitHub CLI authenticated (`gh auth status`)
- A static IP or hostname for your server

## Install

```bash
npm install -g @aoagents/ao
ao --version  # confirm install
```

## Configure

Create `agent-orchestrator.yaml` in your working directory:

```yaml
$schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json
port: 3000

defaults:
  runtime: process
  agent: claude-code
  workspace: worktree

projects:
  my-project:
    repo: owner/my-repo
    path: ~/my-repo
    defaultBranch: main
```

Set your public URL so agents link back to the right host:

```bash
export AO_PUBLIC_URL=https://ao.example.com
```

## Run as a service (Linux — systemd)

```ini
# /etc/systemd/system/agentmesh.service
[Unit]
Description=AgentMesh
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/project
Environment=AO_PUBLIC_URL=https://ao.example.com
ExecStart=/usr/local/bin/ao start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable agentmesh
sudo systemctl start agentmesh
```

## Run with PM2 (cross-platform)

```bash
npm install -g pm2
pm2 start "ao start" --name agentmesh
pm2 save
pm2 startup
```

## Reverse proxy (Caddy)

```caddy
ao.example.com {
  reverse_proxy localhost:3000
  reverse_proxy /ao-terminal-mux localhost:14801
}
```

## Remote access via Tailscale

1. Install Tailscale on both server and your devices
2. Set `AO_PUBLIC_URL=http://100.x.x.x:3000` (your Tailscale IP)
3. Access the dashboard from any Tailscale device

## Updating

```bash
ao update
```

This pauses the running instance, upgrades the npm package, and restarts automatically.

## Health check

```bash
curl http://localhost:3000/api/health
# {"status":"ok","version":"0.9.2"}
```

Use this URL for your load balancer or uptime monitor health checks.
