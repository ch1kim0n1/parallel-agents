/**
 * `ao backup` — archive ~/.agent-orchestrator/ to tar.gz (issue #74).
 *
 * Creates a timestamped tar.gz of the entire storage directory, including
 * session metadata, activity events, global config, running state, and
 * last-stop state. Excludes transient files (error.log rotations, lock
 * files) that would be stale on restore.
 *
 * Usage:
 *   ao backup                     # → ~/.agent-orchestrator-backup-2026-06-23T04-00-00.tar.gz
 *   ao backup --output /tmp/ao    # → /tmp/ao.tar.gz
 *   ao backup --output /tmp/ao.bak  # → /tmp/ao.bak (exact name, no .tar.gz appended)
 */

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

export function registerBackup(program: Command): void {
  program
    .command("backup")
    .description("Archive ~/.agent-orchestrator/ to a tar.gz backup file")
    .option(
      "-o, --output <path>",
      "Output file path. If no extension, .tar.gz is appended. " +
        "Default: ~/.agent-orchestrator-backup-<timestamp>.tar.gz",
    )
    .action((opts: { output?: string }) => {
      const src = storageDir();

      if (!existsSync(src)) {
        console.error(
          chalk.red(`Storage directory not found: ${src}`),
        );
        console.error(
          chalk.yellow(
            "Nothing to back up. Run `ao start` first to initialize storage.",
          ),
        );
        process.exit(1);
      }

      const stat = statSync(src);
      if (!stat.isDirectory()) {
        console.error(
          chalk.red(`Storage path is not a directory: ${src}`),
        );
        process.exit(1);
      }

      // Resolve output path.
      let outputPath: string;
      if (opts.output) {
        if (opts.output.endsWith(".tar.gz") || opts.output.endsWith(".tgz")) {
          outputPath = opts.output;
        } else {
          outputPath = `${opts.output}.tar.gz`;
        }
      } else {
        outputPath = join(
          getEnvDefaults().HOME,
          `.agent-orchestrator-backup-${timestamp()}.tar.gz`,
        );
      }

      console.log(chalk.cyan(`Backing up ${src} → ${outputPath}`));

      // Use system tar. Exclude transient files that would be stale on restore.
      // --exclude patterns are relative to the archive root.
      try {
        execFileSync(
          "tar",
          [
            "czf",
            outputPath,
            "--exclude=*.lock",
            "--exclude=error.log.*", // rotated logs
            "-C",
            getEnvDefaults().HOME, // archive relative to HOME
            ".agent-orchestrator",
          ],
          { stdio: "inherit", timeout: 120_000 },
        );

        const sizeMB = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);
        console.log(
          chalk.green(`\nBackup complete: ${outputPath} (${sizeMB} MB)`),
        );
        console.log(
          chalk.gray(
            "Restore with: ao restore " + outputPath,
          ),
        );
      } catch (err) {
        console.error(
          chalk.red(
            `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    });
}
