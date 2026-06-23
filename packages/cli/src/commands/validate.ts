/**
 * `ao validate` — preflight config + environment validation (issue #76).
 *
 * Lighter than `ao doctor`: focuses on config parseability, required env
 * vars, and required binaries. Exits 1 with actionable messages on failure
 * so users can fix problems before `ao start` fails cryptically.
 *
 * Reuses `ao doctor`'s PASS/WARN/FAIL style for consistency.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import {
  findConfigFile,
  loadConfig,
  ConfigNotFoundError,
  type LoadedConfig,
} from "@aoagents/ao-core";

function pass(msg: string): void {
  console.log(`${chalk.green("PASS")} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${chalk.yellow("WARN")} ${msg}`);
}

function fail(msg: string): void {
  console.error(`${chalk.red("FAIL")} ${msg}`);
}

/** Check a binary is on PATH. Returns true if found. */
function binaryAvailable(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Required binaries for the default runtime + SCM + tracker. */
const REQUIRED_BINARIES = ["git"];

/** Binaries required based on configured agent + runtime. */
function binariesForConfig(config: LoadedConfig): { name: string; required: boolean; hint: string }[] {
  const bins = [...REQUIRED_BINARIES.map((name) => ({ name, required: true, hint: "install git 2.25+" }))];

  // Runtime: tmux is the default on non-Windows; process runtime needs nothing.
  const defaultRuntime = config.defaults?.runtime;
  if (!defaultRuntime || defaultRuntime === "tmux") {
    bins.push({ name: "tmux", required: true, hint: "install tmux 3.0+" });
  }

  // Agent CLIs — map agent name to binary.
  const agent = config.defaults?.agent ?? "claude-code";
  const agentBins: Record<string, { name: string; hint: string }> = {
    "claude-code": { name: "claude", hint: "npm install -g @anthropic-ai/claude-code" },
    codex: { name: "codex", hint: "npm install -g @openai/codex" },
    aider: { name: "aider", hint: "pip install aider-chat" },
    opencode: { name: "opencode", hint: "install opencode from https://opencode.ai" },
  };
  const agentBin = agentBins[agent];
  if (agentBin) {
    bins.push({ name: agentBin.name, required: false, hint: agentBin.hint });
  }

  // SCM: gh CLI if any project uses github tracker/scm (or no tracker = github default).
  const projects = Object.values(config.projects ?? {});
  const usesGithub = projects.some((p) => {
    const tracker = p.tracker;
    const scm = p.scm;
    const trackerPlugin = tracker?.plugin ?? "";
    const scmPlugin = scm?.plugin ?? "";
    // github is the default when no tracker/scm plugin is specified.
    return (
      trackerPlugin.includes("github") ||
      scmPlugin.includes("github") ||
      (!trackerPlugin && !scmPlugin)
    );
  });
  if (usesGithub) {
    bins.push({ name: "gh", required: false, hint: "install GitHub CLI from https://cli.github.com" });
  }

  return bins;
}

/** Env vars required based on configured tracker/scm/notifier. */
function envVarsForConfig(config: LoadedConfig): { name: string; required: boolean }[] {
  const vars: { name: string; required: boolean }[] = [];
  const seen = new Set<string>();

  for (const project of Object.values(config.projects ?? {})) {
    // Tracker tokens — infer from plugin name.
    const trackerPlugin = project.tracker?.plugin ?? "";
    if (trackerPlugin.includes("github") && !seen.has("GITHUB_TOKEN")) {
      vars.push({ name: "GITHUB_TOKEN", required: true });
      seen.add("GITHUB_TOKEN");
    } else if (trackerPlugin.includes("linear") && !seen.has("LINEAR_API_KEY")) {
      vars.push({ name: "LINEAR_API_KEY", required: true });
      seen.add("LINEAR_API_KEY");
    } else if (trackerPlugin.includes("gitlab") && !seen.has("GITLAB_TOKEN")) {
      vars.push({ name: "GITLAB_TOKEN", required: true });
      seen.add("GITLAB_TOKEN");
    }

    // Webhook secrets
    const scm = project.scm;
    if (scm && typeof scm === "object" && "webhook" in scm) {
      const webhook = (scm as { webhook?: { secretEnvVar?: string } }).webhook;
      if (webhook?.secretEnvVar && !seen.has(webhook.secretEnvVar)) {
        vars.push({ name: webhook.secretEnvVar, required: false });
        seen.add(webhook.secretEnvVar);
      }
    }
  }

  return vars;
}

export function registerValidate(program: Command): void {
  program
    .command("validate")
    .description("Preflight check: config, env vars, and required binaries")
    .option("--strict", "Treat warnings (missing optional binaries/env) as failures")
    .action(async (opts: { strict?: boolean }) => {
      let failures = 0;
      let warnings = 0;

      // 1. Config file exists + parses
      let config: LoadedConfig | undefined;
      try {
        const configPath = findConfigFile();
        if (!configPath) {
          throw new ConfigNotFoundError();
        }
        config = loadConfig(configPath);
        pass(`config parsed: ${configPath}`);
      } catch (err) {
        failures++;
        if (err instanceof ConfigNotFoundError) {
          fail("No agent-orchestrator.yaml found in current directory or any parent.");
          console.error(
            chalk.gray(
              "  Fix: copy the template with: cp agent-orchestrator.yaml.example agent-orchestrator.yaml",
            ),
          );
          console.error(
            chalk.gray("  Then edit it to add your project. Run `ao setup` for an interactive wizard."),
          );
        } else {
          fail(`config parse error: ${err instanceof Error ? err.message : String(err)}`);
          console.error(
            chalk.gray("  Fix: check YAML syntax. Run `ao doctor` for a deeper diagnosis."),
          );
        }
        // Can't continue — env/binary checks depend on config.
        process.exit(1);
      }

      // 2. Required env vars
      const envVars = envVarsForConfig(config!);
      if (envVars.length === 0) {
        pass("no project-specific env vars required");
      }
      for (const v of envVars) {
        if (process.env[v.name]) {
          pass(`env var ${v.name} is set`);
        } else if (v.required) {
          failures++;
          fail(`required env var ${v.name} is not set`);
          console.error(chalk.gray(`  Fix: export ${v.name}=... in your shell or .env`));
        } else {
          warnings++;
          warn(`optional env var ${v.name} is not set (webhook signature verification will be skipped)`);
        }
      }

      // 3. Required binaries
      const bins = binariesForConfig(config!);
      for (const b of bins) {
        if (binaryAvailable(b.name)) {
          pass(`binary ${b.name} found in PATH`);
        } else if (b.required) {
          failures++;
          fail(`required binary ${b.name} not found in PATH`);
          console.error(chalk.gray(`  Fix: ${b.hint}`));
        } else {
          warnings++;
          warn(`optional binary ${b.name} not found in PATH`);
          console.error(chalk.gray(`  Fix: ${b.hint}`));
        }
      }

      // 4. Storage dir writable
      const storageDir = `${process.env.HOME ?? process.env.USERPROFILE}/.agent-orchestrator`;
      if (existsSync(storageDir)) {
        pass(`storage dir exists: ${storageDir}`);
      } else {
        // Don't fail — ao start will create it. Just inform.
        pass(`storage dir will be created on start: ${storageDir}`);
      }

      // Exit code
      if (failures > 0) {
        console.error(
          chalk.red(`\n${failures} failure(s), ${warnings} warning(s). Fix the failures before running ao start.`),
        );
        process.exit(1);
      }
      if (opts.strict && warnings > 0) {
        console.error(chalk.yellow(`\n0 failures, ${warnings} warning(s) (--strict mode).`));
        process.exit(1);
      }
      if (warnings > 0) {
        console.log(chalk.yellow(`\n0 failures, ${warnings} warning(s). Run with --strict to fail on warnings.`));
      } else {
        console.log(chalk.green("\nAll checks passed. Ready to run `ao start`."));
      }
    });
}
