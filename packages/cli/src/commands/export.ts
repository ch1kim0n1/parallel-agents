/**
 * `ao export` — export session data as portable JSON (issue #74).
 *
 * Exports session metadata, activity events, and config as a single JSON
 * file. Suitable for GDPR data portability, migration to another tool,
 * or external analysis.
 *
 * Usage:
 *   ao export                     # → ~/.agent-orchestrator-export-<ts>.json
 *   ao export --output /tmp/ao    # → /tmp/ao.json
 *   ao export --project my-app    # only sessions for my-app
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvDefaults } from "@aoagents/ao-core";
import type { Command } from "commander";
import chalk from "chalk";

function storageDir(): string {
  return join(getEnvDefaults().HOME, ".agent-orchestrator");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

interface ExportData {
  exportedAt: string;
  version: string;
  storageDir: string;
  globalConfig: unknown | null;
  sessions: Array<{ projectId: string; sessionId: string; data: Record<string, string> }>;
  runningState: unknown | null;
  lastStopState: unknown | null;
}

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export session data as portable JSON")
    .option("-o, --output <path>", "Output file path. Default: ~/.agent-orchestrator-export-<ts>.json")
    .option("-p, --project <id>", "Export only sessions for the given project")
    .action((opts: { output?: string; project?: string }) => {
      const src = storageDir();

      if (!existsSync(src)) {
        console.error(chalk.red(`Storage directory not found: ${src}`));
        console.error(
          chalk.yellow("Nothing to export. Run `ao start` first to initialize storage."),
        );
        process.exit(1);
      }

      const data: ExportData = {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        storageDir: src,
        globalConfig: null,
        sessions: [],
        runningState: null,
        lastStopState: null,
      };

      // Global config.
      const globalConfigPath = join(src, "config.yaml");
      if (existsSync(globalConfigPath)) {
        try {
          const raw = readFileSync(globalConfigPath, "utf-8");
          // Store as raw string — parsing YAML here would add a dep.
          data.globalConfig = raw;
        } catch {
          // Skip unreadable config.
        }
      }

      // Running state.
      const runningPath = join(src, "running.json");
      if (existsSync(runningPath)) {
        try {
          data.runningState = JSON.parse(readFileSync(runningPath, "utf-8"));
        } catch {
          // Skip corrupted file.
        }
      }

      // Last-stop state.
      const lastStopPath = join(src, "last-stop.json");
      if (existsSync(lastStopPath)) {
        try {
          data.lastStopState = JSON.parse(readFileSync(lastStopPath, "utf-8"));
        } catch {
          // Skip corrupted file.
        }
      }

      // Sessions: scan project directories (hash-projectId/sessions/sessionId).
      // Each session is a directory of key-value files.
      const entries = readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Project dirs match pattern: <12char-hash>-<projectId>
        const match = entry.name.match(/^[0-9a-f]{12}-(.+)$/);
        if (!match) continue;
        const projectId = match[1];

        if (opts.project && projectId !== opts.project) continue;

        const sessionsDir = join(src, entry.name, "sessions");
        if (!existsSync(sessionsDir)) continue;

        const sessionEntries = readdirSync(sessionsDir, { withFileTypes: true });
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isDirectory()) continue;
          const sessionId = sessionEntry.name;
          const sessionPath = join(sessionsDir, sessionId);
          const sessionData: Record<string, string> = {};

          const files = readdirSync(sessionPath, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile()) continue;
            try {
              sessionData[file.name] = readFileSync(join(sessionPath, file.name), "utf-8");
            } catch {
              // Skip unreadable files.
            }
          }

          data.sessions.push({ projectId, sessionId, data: sessionData });
        }
      }

      // Resolve output path.
      let outputPath: string;
      if (opts.output) {
        outputPath = opts.output.endsWith(".json") ? opts.output : `${opts.output}.json`;
      } else {
        outputPath = join(
          getEnvDefaults().HOME,
          `.agent-orchestrator-export-${timestamp()}.json`,
        );
      }

      try {
        writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
        const sizeKB = (JSON.stringify(data).length / 1024).toFixed(1);
        console.log(chalk.green(`Export complete: ${outputPath}`));
        console.log(chalk.gray(`  Sessions: ${data.sessions.length}`));
        console.log(chalk.gray(`  Size: ${sizeKB} KB`));
        if (opts.project) {
          console.log(chalk.gray(`  Filtered to project: ${opts.project}`));
        }
      } catch (err) {
        console.error(
          chalk.red(`Export failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
