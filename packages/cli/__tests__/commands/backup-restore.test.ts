/**
 * Tests for ao backup, ao restore, ao export commands (issue #74).
 *
 * Verifies:
 *  - backup creates a tar.gz of ~/.agent-orchestrator/
 *  - restore extracts tar.gz back, with conflict detection + --force
 *  - export produces JSON with session metadata
 *  - backup → restore roundtrip preserves session count
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Mock getEnvDefaults to point HOME at a temp dir.
const tempHome = vi.hoisted(() => ({ current: "" as string }));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getEnvDefaults: () => ({ HOME: tempHome.current, TMPDIR: "/tmp", SHELL: "/bin/bash", PATH: "/usr/bin", USER: "test" }),
  };
});

import { createProgram } from "../../src/program.js";

describe("ao backup / restore / export (issue #74)", () => {
  let tempDir: string;
  let storageDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-backup-"));
    tempHome.current = tempDir;
    storageDir = join(tempDir, ".agent-orchestrator");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper: create a fake storage dir with sessions.
  function createFakeStorage(sessionCount = 3): void {
    mkdirSync(storageDir, { recursive: true });
    // Global config.
    writeFileSync(join(storageDir, "config.yaml"), "projects: {}\n");
    // Running state.
    writeFileSync(join(storageDir, "running.json"), JSON.stringify({ pid: 12345 }));
    // Project dir: <hash>-<projectId>/sessions/<sessionId>/
    const projectDir = join(storageDir, "abc123def456-my-app", "sessions");
    mkdirSync(projectDir, { recursive: true });
    for (let i = 0; i < sessionCount; i++) {
      const sessionDir = join(projectDir, `session-${i}`);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "status"), "working");
      writeFileSync(join(sessionDir, "branch"), `feature-${i}`);
    }
  }

  describe("ao backup", () => {
    it("creates a tar.gz backup file", async () => {
      createFakeStorage(2);
      const outputPath = join(tempDir, "backup.tar.gz");

      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", outputPath]);

      expect(existsSync(outputPath)).toBe(true);
      // Verify it's a valid gzip (tar tzf should list contents).
      const listing = execFileSync("tar", ["tzf", outputPath], { encoding: "utf-8" });
      expect(listing).toContain(".agent-orchestrator");
      expect(listing).toContain("config.yaml");
    });

    it("appends .tar.gz if not in output path", async () => {
      createFakeStorage(1);
      const outputPath = join(tempDir, "mybackup");

      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", outputPath]);

      expect(existsSync(`${outputPath}.tar.gz`)).toBe(true);
    });

    it("exits 1 if storage dir does not exist", async () => {
      const program = createProgram();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit:1");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        program.parseAsync(["node", "ao", "backup", "--output", join(tempDir, "out.tar.gz")]),
      ).rejects.toThrow("exit:1");

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("excludes lock files and rotated error logs", async () => {
      createFakeStorage(1);
      // Add transient files that should be excluded.
      writeFileSync(join(storageDir, "daemon.lock"), "lock");
      writeFileSync(join(storageDir, "error.log"), "log");
      writeFileSync(join(storageDir, "error.log.1"), "rotated");
      writeFileSync(join(storageDir, "error.log.2"), "rotated2");

      const outputPath = join(tempDir, "backup.tar.gz");
      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", outputPath]);

      const listing = execFileSync("tar", ["tzf", outputPath], { encoding: "utf-8" });
      expect(listing).not.toContain("daemon.lock");
      expect(listing).not.toContain("error.log.1");
      expect(listing).not.toContain("error.log.2");
      // Current error.log is NOT excluded (only rotations are).
      expect(listing).toContain("error.log");
    });
  });

  describe("ao restore", () => {
    it("restores from a backup file with --force", async () => {
      createFakeStorage(3);
      const backupPath = join(tempDir, "backup.tar.gz");

      // Create backup.
      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", backupPath]);

      // Delete storage to simulate fresh machine.
      rmSync(storageDir, { recursive: true, force: true });
      expect(existsSync(storageDir)).toBe(false);

      // Restore with --force (no prompt needed).
      await program.parseAsync(["node", "ao", "restore", backupPath, "--force"]);

      // Verify storage is restored.
      expect(existsSync(storageDir)).toBe(true);
      expect(existsSync(join(storageDir, "config.yaml"))).toBe(true);
      const sessionsDir = join(storageDir, "abc123def456-my-app", "sessions");
      const restoredSessions = readdirSync(sessionsDir);
      expect(restoredSessions).toHaveLength(3);
    });

    it("renames existing data aside on restore with --force", async () => {
      createFakeStorage(2);
      const backupPath = join(tempDir, "backup.tar.gz");

      // Create backup of 2 sessions.
      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", backupPath]);

      // Add more sessions to current storage.
      const sessionsDir = join(storageDir, "abc123def456-my-app", "sessions");
      mkdirSync(join(sessionsDir, "extra-session"), { recursive: true });
      writeFileSync(join(sessionsDir, "extra-session", "status"), "idle");

      // Restore with --force — existing data should be renamed aside.
      await program.parseAsync(["node", "ao", "restore", backupPath, "--force"]);

      // Restored storage should have 2 sessions (from backup), not 3.
      const restoredSessions = readdirSync(sessionsDir);
      expect(restoredSessions).toHaveLength(2);
      expect(restoredSessions).not.toContain("extra-session");

      // Old data should be in .agent-orchestrator.pre-restore-*.
      const preRestoreDirs = readdirSync(tempDir).filter((d) =>
        d.startsWith(".agent-orchestrator.pre-restore-"),
      );
      expect(preRestoreDirs).toHaveLength(1);
    });

    it("exits 1 if backup file does not exist", async () => {
      const program = createProgram();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit:1");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        program.parseAsync(["node", "ao", "restore", "/nonexistent/backup.tar.gz", "--force"]),
      ).rejects.toThrow("exit:1");

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });

  describe("ao export", () => {
    it("exports session data as JSON", async () => {
      createFakeStorage(3);
      const outputPath = join(tempDir, "export.json");

      const program = createProgram();
      await program.parseAsync(["node", "ao", "export", "--output", outputPath]);

      expect(existsSync(outputPath)).toBe(true);
      const data = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(data.exportedAt).toBeDefined();
      expect(data.version).toBe("1.0");
      expect(data.sessions).toHaveLength(3);
      expect(data.sessions[0].projectId).toBe("my-app");
      expect(data.sessions[0].data.status).toBe("working");
    });

    it("filters by project with --project", async () => {
      createFakeStorage(2);
      // Add a second project.
      const project2Dir = join(storageDir, "a1b2c3d4e5f6-other-app", "sessions");
      mkdirSync(project2Dir, { recursive: true });
      mkdirSync(join(project2Dir, "other-session"), { recursive: true });
      writeFileSync(join(project2Dir, "other-session", "status"), "done");

      const outputPath = join(tempDir, "export.json");
      const program = createProgram();
      await program.parseAsync([
        "node", "ao", "export", "--output", outputPath, "--project", "other-app",
      ]);

      const data = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].projectId).toBe("other-app");
    });

    it("includes global config and running state", async () => {
      createFakeStorage(1);
      const outputPath = join(tempDir, "export.json");

      const program = createProgram();
      await program.parseAsync(["node", "ao", "export", "--output", outputPath]);

      const data = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(data.globalConfig).toBe("projects: {}\n");
      expect(data.runningState).toEqual({ pid: 12345 });
    });

    it("exits 1 if storage dir does not exist", async () => {
      const program = createProgram();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit:1");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        program.parseAsync(["node", "ao", "export", "--output", join(tempDir, "out.json")]),
      ).rejects.toThrow("exit:1");

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });

  describe("backup → restore roundtrip", () => {
    it("preserves session count and data", async () => {
      createFakeStorage(5);
      const backupPath = join(tempDir, "roundtrip.tar.gz");

      // Backup.
      const program = createProgram();
      await program.parseAsync(["node", "ao", "backup", "--output", backupPath]);

      // Wipe storage.
      rmSync(storageDir, { recursive: true, force: true });

      // Restore.
      await program.parseAsync(["node", "ao", "restore", backupPath, "--force"]);

      // Verify session count + data.
      const sessionsDir = join(storageDir, "abc123def456-my-app", "sessions");
      const sessions = readdirSync(sessionsDir);
      expect(sessions).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(sessions).toContain(`session-${i}`);
        const status = readFileSync(join(sessionsDir, `session-${i}`, "status"), "utf-8");
        expect(status).toBe("working");
      }
    });
  });
});
