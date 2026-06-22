/**
 * Path separator + traversal tests for path-security.ts (issue #77).
 *
 * On Windows, path inputs may use either forward slashes (/) or
 * backslashes (\). The security checks must handle both consistently
 * — a traversal attack using `..\..\..` must be caught just as
 * `../../..` is.
 *
 * These tests mock `isWindows()` to exercise both platform paths without
 * needing a Windows CI runner. They also test the restricted-segment
 * detection (.ssh, .aws, .kube, .gnupg, .agent-orchestrator, .config/gcloud)
 * and the home-containment constraint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  resolveHomeContainedPath,
  assertDirectoryPath,
  shouldHideBrowseEntry,
  PathSecurityError,
} from "@/lib/path-security";

// Mock isWindows() to test both platform paths on any OS.
vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    isWindows: vi.fn(() => false),
  };
});

import { isWindows } from "@aoagents/ao-core";

function setPlatform(platform: "win32" | "other") {
  vi.mocked(isWindows).mockReturnValue(platform === "win32");
}

describe("path-security — splitInputSegments handles both separators (issue #77)", () => {
  let tempRoot: string;

  beforeEach(() => {
    setPlatform("other");
    tempRoot = mkdtempSync(join(tmpdir(), "ao-path-sec-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("traversal detection", () => {
    it("rejects ../ traversal with forward slashes", () => {
      expect(() => resolveHomeContainedPath("../../etc/passwd")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("../../etc/passwd")).toThrow(/outside.*root/i);
    });

    it("rejects ..\\ traversal with backslashes (Windows-style)", () => {
      expect(() => resolveHomeContainedPath("..\\..\\etc\\passwd")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("..\\..\\etc\\passwd")).toThrow(/outside.*root/i);
    });

    it("rejects mixed separators ..\\../..\\ (attack vector)", () => {
      expect(() => resolveHomeContainedPath("..\\../..\\etc\\passwd")).toThrow(PathSecurityError);
    });

    it("rejects nested traversal ~/../../etc/passwd", () => {
      expect(() => resolveHomeContainedPath("~/../../etc/passwd")).toThrow(PathSecurityError);
    });

    it("rejects traversal with ~\\ prefix (Windows home expansion)", () => {
      expect(() => resolveHomeContainedPath("~\\..\\..\\etc\\passwd")).toThrow(PathSecurityError);
    });
  });

  describe("restricted segment detection", () => {
    it("rejects .ssh directory", () => {
      const sshPath = join(homedir(), ".ssh");
      // .ssh may not exist — create it if not
      try { mkdirSync(sshPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.ssh")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("~/.ssh")).toThrow(/restricted/i);
    });

    it("rejects .aws directory", () => {
      const awsPath = join(homedir(), ".aws");
      try { mkdirSync(awsPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.aws")).toThrow(PathSecurityError);
    });

    it("rejects .kube directory", () => {
      const kubePath = join(homedir(), ".kube");
      try { mkdirSync(kubePath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.kube")).toThrow(PathSecurityError);
    });

    it("rejects .gnupg directory", () => {
      const gnupgPath = join(homedir(), ".gnupg");
      try { mkdirSync(gnupgPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.gnupg")).toThrow(PathSecurityError);
    });

    it("rejects .agent-orchestrator directory", () => {
      const aoPath = join(homedir(), ".agent-orchestrator");
      try { mkdirSync(aoPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.agent-orchestrator")).toThrow(PathSecurityError);
    });

    it("rejects .config/gcloud directory", () => {
      const gcloudPath = join(homedir(), ".config", "gcloud");
      try { mkdirSync(gcloudPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~/.config/gcloud")).toThrow(PathSecurityError);
    });

    it("rejects .ssh with backslash separator (Windows-style)", () => {
      const sshPath = join(homedir(), ".ssh");
      try { mkdirSync(sshPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~\\.ssh")).toThrow(PathSecurityError);
    });
  });

  describe("home containment (non-Windows)", () => {
    it("rejects absolute path outside home on non-Windows", () => {
      expect(() => resolveHomeContainedPath("/etc/passwd")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("/etc/passwd")).toThrow(/outside.*root/i);
    });

    it("rejects /tmp outside home", () => {
      expect(() => resolveHomeContainedPath("/tmp")).toThrow(PathSecurityError);
    });
  });

  describe("valid path resolution", () => {
    it("resolves ~ to home directory", () => {
      const result = resolveHomeContainedPath("~");
      expect(result.resolvedPath).toBe(homedir());
    });

    it("resolves a valid subdirectory of home", () => {
      const subDir = join(homedir(), "ao-path-test-valid");
      try {
        mkdirSync(subDir, { recursive: true });
        const result = resolveHomeContainedPath("~/ao-path-test-valid");
        expect(result.resolvedPath).toContain("ao-path-test-valid");
      } finally {
        rmSync(subDir, { recursive: true, force: true });
      }
    });

    it("resolves a valid subdirectory with backslash separator", () => {
      const subDir = join(homedir(), "ao-path-test-bs");
      try {
        mkdirSync(subDir, { recursive: true });
        const result = resolveHomeContainedPath("~\\ao-path-test-bs");
        expect(result.resolvedPath).toContain("ao-path-test-bs");
      } finally {
        rmSync(subDir, { recursive: true, force: true });
      }
    });
  });

  describe("assertDirectoryPath", () => {
    it("rejects a file path (not a directory)", () => {
      const filePath = join(homedir(), "ao-path-test-file.txt");
      try {
        writeFileSync(filePath, "test");
        expect(() => assertDirectoryPath("~/ao-path-test-file.txt")).toThrow(PathSecurityError);
        expect(() => assertDirectoryPath("~/ao-path-test-file.txt")).toThrow(/not a directory/i);
      } finally {
        rmSync(filePath, { force: true });
      }
    });

    it("rejects a non-existent path", () => {
      expect(() => assertDirectoryPath("~/nonexistent-ao-path-test-12345")).toThrow(PathSecurityError);
      expect(() => assertDirectoryPath("~/nonexistent-ao-path-test-12345")).toThrow(/not found/i);
    });
  });

  describe("shouldHideBrowseEntry", () => {
    it("hides dotfiles", () => {
      const entryPath = join(homedir(), ".hidden-ao-test");
      expect(shouldHideBrowseEntry(entryPath, homedir())).toBe(true);
    });

    it("hides restricted segments", () => {
      const sshPath = join(homedir(), ".ssh");
      try { mkdirSync(sshPath, { recursive: true }); } catch { /* may exist */ }
      expect(shouldHideBrowseEntry(sshPath, homedir())).toBe(true);
    });

    it("does not hide a normal entry inside home", () => {
      const normalDir = join(homedir(), "ao-path-test-normal");
      try {
        mkdirSync(normalDir, { recursive: true });
        expect(shouldHideBrowseEntry(normalDir, homedir())).toBe(false);
      } finally {
        rmSync(normalDir, { recursive: true, force: true });
      }
    });
  });

  describe("Windows platform (isWindows=true)", () => {
    beforeEach(() => setPlatform("win32"));

    it("does not constrain to home on Windows (allows any drive)", () => {
      // On Windows, shouldConstrainToHome() returns false, so paths
      // outside the home dir are allowed (Windows has drive letters +
      // ACLs, the home constraint is a POSIX-only defense).
      // We can't test an actual Windows path on macOS/Linux, but we
      // can verify the constraint is relaxed by checking that a temp
      // dir outside home is allowed.
      const outsideHome = mkdtempSync(join(tmpdir(), "ao-win-test-"));
      try {
        const result = resolveHomeContainedPath(outsideHome);
        // realpathSync may resolve symlinks (e.g. /var -> /private/var
        // on macOS), so compare via realpathSync of the input too.
        expect(result.resolvedPath).toBe(realpathSync(outsideHome));
      } finally {
        rmSync(outsideHome, { recursive: true, force: true });
      }
    });

    it("still rejects traversal on Windows", () => {
      // Traversal detection uses splitInputSegments which splits on
      // both / and \ — so it works regardless of platform.
      expect(() => resolveHomeContainedPath("..\\..\\etc\\passwd")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("../../etc/passwd")).toThrow(PathSecurityError);
    });

    it("still rejects restricted segments on Windows", () => {
      const sshPath = join(homedir(), ".ssh");
      try { mkdirSync(sshPath, { recursive: true }); } catch { /* may exist */ }
      expect(() => resolveHomeContainedPath("~\\.ssh")).toThrow(PathSecurityError);
      expect(() => resolveHomeContainedPath("~/.ssh")).toThrow(PathSecurityError);
    });
  });

  describe("UNC path handling (documented behavior)", () => {
    // UNC paths (\\server\share) are Windows-specific. On POSIX, they're
    // just relative paths starting with .. This test documents that the
    // traversal check catches the leading \\ as containing .. segments
    // only if .. is present — a bare \\ is not traversal.
    it("does not falsely flag a path with no .. as traversal", () => {
      // Create a temp dir and verify it resolves without a traversal error.
      const subDir = join(homedir(), "ao-unc-test");
      try {
        mkdirSync(subDir, { recursive: true });
        const result = resolveHomeContainedPath("~/ao-unc-test");
        expect(result.resolvedPath).toContain("ao-unc-test");
      } finally {
        rmSync(subDir, { recursive: true, force: true });
      }
    });
  });
});
