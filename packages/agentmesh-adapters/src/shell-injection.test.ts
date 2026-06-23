import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@aoagents/ao-core";
import {
  AiderAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  CursorAdapter,
  GeminiAdapter,
  KimiCodeAdapter,
  OpenCodeAdapter,
} from "./index.js";

function createSessionManagerMock() {
  return {
    spawn: vi.fn().mockResolvedValue({ id: "ao-test-1" }),
    send: vi.fn(),
    get: vi.fn(),
    kill: vi.fn(),
  };
}

function asSessionManager(mock: ReturnType<typeof createSessionManagerMock>): SessionManager {
  return mock as unknown as SessionManager;
}

// Shell metacharacters that would break out of a string-interpolated command.
const INJECTION_PAYLOADS = [
  "; rm -rf ~/important-dir",
  "$(echo INJECTED)",
  "`echo INJECTED`",
  "&& echo INJECTED",
  "| echo INJECTED",
  "'; echo INJECTED; '",
  '" && echo INJECTED && "',
  "'; rm -rf / #",
];

const ADAPTERS: Array<[string, new (sm: SessionManager) => InstanceType<typeof ClaudeCodeAdapter>]> = [
  ["ClaudeCodeAdapter", ClaudeCodeAdapter],
  ["CodexAdapter", CodexAdapter],
  ["CursorAdapter", CursorAdapter],
  ["AiderAdapter", AiderAdapter],
  ["GeminiAdapter", GeminiAdapter],
  ["OpenCodeAdapter", OpenCodeAdapter],
  ["KimiCodeAdapter", KimiCodeAdapter],
];

describe("shell injection regression — task-derived values are data, not shell commands", () => {
  describe.each(ADAPTERS)("%s", (_name, AdapterClass) => {
    it.each(INJECTION_PAYLOADS)("passes malicious taskId as data to spawn(): %s", async (payload) => {
      const sm = createSessionManagerMock();
      const adapter = new AdapterClass(asSessionManager(sm));

      await adapter.start({
        taskId: payload,
        role: "builder",
        prompt: "legitimate task",
        workspacePath: "C:/repo",
        branch: "feat/test",
      });

      // taskId flows into spawn() as issueId — a data field, not a shell argument
      expect(sm.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: payload }),
      );
      // The payload must appear verbatim, proving it was not interpreted
      const spawnCall = sm.spawn.mock.calls[0][0] as { issueId: string };
      expect(spawnCall.issueId).toBe(payload);
    });

    it.each(INJECTION_PAYLOADS)("passes malicious branch as data to spawn(): %s", async (payload) => {
      const sm = createSessionManagerMock();
      const adapter = new AdapterClass(asSessionManager(sm));

      await adapter.start({
        taskId: "TASK-1",
        role: "builder",
        prompt: "legitimate task",
        workspacePath: "C:/repo",
        branch: payload,
      });

      expect(sm.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ branch: payload }),
      );
      const spawnCall = sm.spawn.mock.calls[0][0] as { branch: string };
      expect(spawnCall.branch).toBe(payload);
    });

    it.each(INJECTION_PAYLOADS)("passes malicious prompt as data to send(): %s", async (payload) => {
      const sm = createSessionManagerMock();
      const adapter = new AdapterClass(asSessionManager(sm));

      await adapter.start({
        taskId: "TASK-1",
        role: "builder",
        prompt: payload,
        workspacePath: "C:/repo",
        branch: "feat/test",
      });

      // prompt flows into send() as message text — a data field, not a shell argument
      expect(sm.send).toHaveBeenCalledTimes(1);
      const sentText = sm.send.mock.calls[0][1] as string;
      // The payload must appear verbatim in the prompt, proving it was not interpreted
      expect(sentText).toContain(payload);
    });
  });

  describe.each(ADAPTERS)("%s sendMessage", (_name, AdapterClass) => {
    it.each(INJECTION_PAYLOADS)("passes malicious message body as data to send(): %s", async (payload) => {
      const sm = createSessionManagerMock();
      const adapter = new AdapterClass(asSessionManager(sm));

      await adapter.sendMessage(
        {
          aoSessionId: "ao-test-1",
          taskId: "TASK-1",
          role: "builder",
          startedAt: new Date(),
        },
        {
          type: "qa_request",
          body: payload,
        },
      );

      expect(sm.send).toHaveBeenCalledTimes(1);
      const sentText = sm.send.mock.calls[0][1] as string;
      expect(sentText).toContain(payload);
    });
  });
});

describe("shell injection regression — execFile uses array args, not shell strings", () => {
  it.each(ADAPTERS)(
    "%s preflight does not interpolate user input into shell commands",
    async (_name, AdapterClass) => {
      // preflight() runs a --version check with a hardcoded command name.
      // It does not accept or interpolate any user-controlled values.
      // execFile is called with array arguments (not a shell string), so
      // even if a user-controlled value were present, shell metacharacters
      // would be treated as literal characters, not executed.
      const sm = createSessionManagerMock();
      const adapter = new AdapterClass(asSessionManager(sm));

      // preflight should not throw — it either finds the CLI or doesn't
      const result = await adapter.preflight({
        role: "builder",
        workspacePath: "C:/repo",
      });

      expect(result).toHaveProperty("ok");
      expect(typeof result.ok).toBe("boolean");
      // No spawn/send calls during preflight — user input never reaches a process
      expect(sm.spawn).not.toHaveBeenCalled();
      expect(sm.send).not.toHaveBeenCalled();
    },
  );
});
