/**
 * `ao restore` — restore ~/.agent-orchestrator/ from a backup (issue #74).
 *
 * Extracts a tar.gz backup into the storage directory. Detects conflicts:
 * if the storage dir already exists and is non-empty, prompts for
 * confirmation unless --force is passed.
 *
 * Usage:
 *   ao restore backup.tar.gz           # prompt if existing data
 *   ao restore backup.tar.gz --force   # overwrite without prompting
 */

import { existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { getEnvDefaults } from "@aoagents/ao-core";
import type { Command } from "commander";
import chalk from "chalk";

function storageDir(): string {
  return join(getEnvDefaults().HOME, ".agent-orchestrator");
}

function prompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

export function registerRestore(program: Command): void {
  program
    .command("restore <backup-file>")
    .description("Restore ~/.agent-orchestrator/ from a tar.gz backup")
    .option("-f, --force", "Overwrite existing data without prompting")
    .action(async (backupFile: string, opts: { force?: boolean }) => {
      const dest = storageDir();

      // Validate backup file exists.
      if (!existsSync(backupFile)) {
        console.error(chalk.red(`Backup file not found: ${backupFile}`));
        process.exit(1);
      }

      // Conflict detection: if dest exists and is non-empty, prompt.
      if (!opts.force && existsSync(dest)) {
        let entries: string[];
        try {
          entries = readdirSync(dest);
        } catch {
          // Dir exists but unreadable — treat as conflict.
          entries = ["unknown"];
        }
        if (entries.length > 0) {
          console.log(
            chalk.yellow(
              `Storage directory ${dest} already exists and contains ${entries.length} item(s).`,
            ),
          );
          console.log(
            chalk.yellow(
              "Existing data will be renamed to .agent-orchestrator.pre-restore-<timestamp>",
            ),
          );
          const confirmed = await prompt(
            chalk.cyan("Continue? [y/N] "),
          );
          if (!confirmed) {
            console.log(chalk.gray("Restore cancelled."));
            process.exit(0);
          }
        }
      }

      // If existing data, rename it aside (don't delete — safety net).
      if (existsSync(dest)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const backupName = `.agent-orchestrator.pre-restore-${ts}`;
        const backupPath = join(dirname(dest), backupName);
        console.log(chalk.gray(`Renaming existing data → ${backupPath}`));
        renameSync(dest, backupPath);
      }

      // Ensure parent dir exists.
      mkdirSync(dirname(dest), { recursive: true });

      console.log(chalk.cyan(`Restoring ${backupFile} → ${dest}`));

      try {
        // Extract relative to HOME so .agent-orchestrator/ lands in the right place.
        execFileSync(
          "tar",
          [
            "xzf",
            backupFile,
            "-C",
            getEnvDefaults().HOME,
          ],
          { stdio: "inherit", timeout: 120_000 },
        );

        // Verify extraction.
        if (!existsSync(dest)) {
          console.error(
            chalk.red(
              `Restore completed but ${dest} not found. The backup may be corrupted or have a different structure.`,
            ),
          );
          process.exit(1);
        }

        const restoredEntries = readdirSync(dest);
        console.log(
          chalk.green(
            `\nRestore complete: ${dest} (${restoredEntries.length} items)`,
          ),
        );
        console.log(
          chalk.gray(
            "Run `ao start` to resume. Sessions will be detected and offered for restore.",
          ),
        );
      } catch (err) {
        console.error(
          chalk.red(
            `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    });
}
