import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { jsonSchema, type Tool } from "ai";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

import {
  bindWanxiangshuHost,
  executeWanxiangshuSlashCommand,
  getWanxiangshuPluginToolPolicy,
  integrateWanxiangshuTools,
  registration,
  runWanxiangshuCompactingTransform,
  runWanxiangshuSystemTransform,
  transformWanxiangshuMessages,
  wrapToolExecuteWithAfterHook,
} from "./wanxiangshuBinding";

function readJsonSchema(t: Tool): unknown {
  return (t.inputSchema as { readonly jsonSchema: unknown }).jsonSchema;
}

function createMockConfig(): Config {
  return {
    loadConfigOrDefault: () =>
      ({
        projects: new Map([
          [
            "/repo",
            {
              trusted: true,
              workspaces: [
                {
                  id: "ws-1",
                  name: "ws-1",
                  path: "/repo",
                },
              ],
            },
          ],
        ]),
      }) as ReturnType<Config["loadConfigOrDefault"]>,
  } as unknown as Config;
}

function createMockAiService(): AIService {
  return {
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({
        success: true,
        data: {
          id: "ws-1",
          name: "ws-1",
          projectPath: "/repo",
          projectName: "repo",
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-4o", thinkingLevel: "low" },
        },
      })
    ),
  } as unknown as AIService;
}

function createMockTaskService(): TaskService {
  return {
    create: mock((_input: unknown) =>
      Promise.resolve({
        success: true,
        data: { taskId: "child-ws", kind: "agent", status: "queued" },
      })
    ),
    waitForAgentReport: mock((_taskId: string, _opts: unknown) =>
      Promise.resolve({ reportMarkdown: "done" })
    ),
  } as unknown as TaskService;
}

describe("wanxiangshuBinding", () => {
  let mockConfig: Config;
  let mockAiService: AIService;
  let mockTaskService: TaskService;
  const originalCwd = process.cwd();

  beforeEach(() => {
    mockConfig = createMockConfig();
    mockAiService = createMockAiService();
    mockTaskService = createMockTaskService();
    bindWanxiangshuHost({
      config: mockConfig,
      aiService: mockAiService,
      workspaceService: {} as WorkspaceService,
      historyService: {} as HistoryService,
      taskService: mockTaskService,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  describe("integrateWanxiangshuTools", () => {
    test("registers coder with JSON schema and concurrent marker", () => {
      const tools: Record<string, Tool> = {};
      const allowlisted = new Set<string>();
      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
        } as ToolConfiguration,
        "ws-1"
      );

      expect(tools.coder).toBeDefined();
      expect(readJsonSchema(tools.coder!)).toMatchObject({
        type: "object",
        required: ["intents", "tdd", "warn_tdd"],
      });
      expect((tools.coder! as Tool & { __allowConcurrent?: boolean }).__allowConcurrent).toBe(true);
      expect(allowlisted.has("coder")).toBe(true);
    });

    test("registers read tool without concurrent marker", () => {
      const tools: Record<string, Tool> = {};
      const allowlisted = new Set<string>();
      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
        } as ToolConfiguration,
        "ws-1"
      );

      expect(tools.read).toBeDefined();
      expect((tools.read! as Tool & { __allowConcurrent?: boolean }).__allowConcurrent).toBeUndefined();
    });

    test("file_read wrapper captures host read and disables it", () => {
      const originalExecute = mock(() => Promise.resolve("host bytes"));
      const hostFileRead: Tool = {
        description: "host read",
        inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
        execute: originalExecute,
      };
      const tools: Record<string, Tool> = { file_read: hostFileRead };
      const allowlisted = new Set<string>();
      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
        } as ToolConfiguration,
        "ws-1"
      );

      expect(tools.file_read).toBeDefined();
      expect(tools.file_read!.execute).not.toBe(originalExecute);
    });

    test("keeps host agent_report unchanged for non-reviewer subagents", async () => {
      const originalExecute = mock((args: unknown) => Promise.resolve({ success: true, args }));
      const hostAgentReport: Tool = {
        description: "host report",
        inputSchema: jsonSchema({
          type: "object",
          properties: { reportMarkdown: { type: "string" } },
          required: ["reportMarkdown"],
        }),
        execute: originalExecute,
      };
      const tools: Record<string, Tool> = { agent_report: hostAgentReport };
      const allowlisted = new Set<string>();

      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
          experiments: { subagentRole: "coder" },
        } as ToolConfiguration,
        "ws-1"
      );

      expect(readJsonSchema(tools.agent_report!)).toEqual({
        type: "object",
        properties: { reportMarkdown: { type: "string" } },
        required: ["reportMarkdown"],
      });

      const result = await tools.agent_report!.execute!(
        { reportMarkdown: "done" },
        { toolCallId: "tc-agent-report", messages: [], context: {} }
      );

      expect(result).toEqual({ success: true, args: { reportMarkdown: "done" } });
      expect(originalExecute).toHaveBeenCalledWith(
        { reportMarkdown: "done" },
        { toolCallId: "tc-agent-report", messages: [], context: {} }
      );
    });

    test("wraps host agent_report for reviewer subagents only", async () => {
      const originalExecute = mock((args: unknown) => Promise.resolve({ success: true, args }));
      const hostAgentReport: Tool = {
        description: "host report",
        inputSchema: jsonSchema({
          type: "object",
          properties: { reportMarkdown: { type: "string" } },
          required: ["reportMarkdown"],
        }),
        execute: originalExecute,
      };
      const tools: Record<string, Tool> = { agent_report: hostAgentReport };
      const allowlisted = new Set<string>();

      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
          experiments: { subagentRole: "reviewer" },
        } as ToolConfiguration,
        "ws-1"
      );

      expect(readJsonSchema(tools.agent_report!)).toEqual({
        type: "object",
        properties: {
          verdict: {
            type: "string",
            enum: ["PASS", "REJECT"],
            description: "PASS accepts the work; REJECT sends actionable feedback.",
          },
          feedback: {
            type: "string",
            description: "Detailed actionable feedback. Optional when passing.",
          },
        },
        required: ["verdict", "feedback"],
        additionalProperties: false,
      });

      const result = await tools.agent_report!.execute!(
        { verdict: "REJECT", feedback: "needs tests" },
        { toolCallId: "tc-agent-report", messages: [], context: {} }
      );

      expect(result).toEqual({
        success: true,
        args: { reportMarkdown: "REJECT: needs tests" },
        report: { reportMarkdown: "REJECT: needs tests" },
      });
      expect(originalExecute).toHaveBeenCalledWith(
        { reportMarkdown: "REJECT: needs tests" },
        { toolCallId: "tc-agent-report", messages: [], context: {} }
      );
    });
  });

  describe("executeWanxiangshuSlashCommand", () => {
    test("returns null for an unknown command", async () => {
      const result = await executeWanxiangshuSlashCommand("not-a-command", "ws-1", "");
      expect(result).toBeNull();
    });

    test("executes the loop slash command", async () => {
      const result = await executeWanxiangshuSlashCommand("loop", "ws-1", "test task");
      expect(typeof result).toBe("string");
      expect((result as string).toLowerCase()).toContain("with-review");
    });
  });

  describe("getWanxiangshuPluginToolPolicy", () => {
    test("always hides host-native file_read", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "manager");
      expect(policy).toBeDefined();
      expect(policy?.remove).toContain("file_read");
    });

    test("manager removes write, file_read, fuzzy_grep, and bash", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "manager");
      expect(policy?.remove).toContain("file_read");
      expect(policy?.remove).toContain("fuzzy_grep");
      expect(policy?.remove).toContain("bash");
      expect(policy?.remove).toContain("write");
      expect(policy?.add).toBeUndefined();
    });

    test("coder keeps write but removes subagent delegation tools", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "coder");
      expect(policy?.remove).toContain("file_read");
      expect(policy?.remove).toContain("coder");
      expect(policy?.remove).toContain("meditator");
      expect(policy?.remove).toContain("browser");
      expect(policy?.remove).toContain("executor");
      expect(policy?.remove).not.toContain("investigator");
      expect(policy?.remove).not.toContain("write");
    });

    test("coder removes host bash and question tools but keeps file edits", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "coder");
      expect(policy?.add).toContain("file_edit_.*");
      expect(policy?.remove).toContain("bash");
      expect(policy?.remove).toContain("web_.*");
      expect(policy?.remove).toContain("ask_user_question");
      expect(policy?.remove).not.toContain("file_edit_.*");
    });

    test("investigator removes host bash and edit tools but keeps executor", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "investigator");
      expect(policy?.remove).toContain("bash");
      expect(policy?.remove).toContain("file_edit_.*");
      expect(policy?.remove).toContain("web_.*");
      expect(policy?.remove).toContain("agent_skill_.*");
      expect(policy?.remove).not.toContain("executor");
    });

    test("meditator removes host execution, edit, web, skill, and stealth tools", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "meditator");
      expect(policy?.remove).toContain("bash");
      expect(policy?.remove).toContain("file_edit_.*");
      expect(policy?.remove).toContain("web_.*");
      expect(policy?.remove).toContain("agent_skill_.*");
      expect(policy?.remove).toContain("stealth_browser_mcp_.*");
      expect(policy?.remove).toContain("memory");
      expect(policy?.remove).not.toContain("read");
    });

    test("reviewer removes stealth MCP tools", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "reviewer");
      expect(policy?.remove).toContain("stealth_browser_mcp_.*");
    });

    test("browser keeps stealth MCP while removing bash, edit, and web tools", () => {
      const policy = getWanxiangshuPluginToolPolicy("any-agent", "browser");
      expect(policy?.remove).toContain("bash");
      expect(policy?.remove).toContain("file_edit_.*");
      expect(policy?.remove).toContain("web_.*");
      expect(policy?.remove).not.toContain("stealth_browser_mcp_.*");
      expect(policy?.remove).not.toContain("read");
    });
  });

  describe("runWanxiangshuCompactingTransform", () => {
    test("returns the messages array after compacting hook runs", async () => {
      const messages = [{ id: "m1", role: "user", content: "hello" }];
      const result = await runWanxiangshuCompactingTransform("ws-1", "/repo", messages);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("transformWanxiangshuMessages", () => {
    test("returns messages unchanged when no wiki transform applies", async () => {
      const messages = [{ id: "m1", role: "user", content: "hello" }];
      const result = await transformWanxiangshuMessages({
        workspacePath: "/repo",
        workspaceId: "ws-1",
        effectiveAgentId: "exec",
        messages,
      });
      expect(result).toEqual(messages);
    });
  });

  describe("createTaskServiceLike forwarding", () => {
    test("forwards parentRuntimeAiSettings from muxEnv to TaskService.create", async () => {
      const tools: Record<string, Tool> = {};
      const allowlisted = new Set<string>();
      integrateWanxiangshuTools(
        tools,
        allowlisted,
        {
          cwd: "/repo",
          runtime: new LocalRuntime("/repo"),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
          muxEnv: {
            MUX_MODEL_STRING: "openai:gpt-4o-mini",
            MUX_THINKING_LEVEL: "medium",
          },
        } as ToolConfiguration,
        "ws-1"
      );

      await tools.coder!.execute!(
        {
          intents: [
            {
              objective: "add test",
              background: "coverage",
              targets: [{ file: "src/a.ts", guide: "add a test" }],
            },
          ],
          tdd: "red",
        },
        { toolCallId: "tc-1", messages: [], abortSignal: undefined, context: {} }
      );

      expect(mockTaskService.create).toHaveBeenCalled();
      const typedCreate = mockTaskService.create as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      };
      const callArgs = typedCreate.mock.calls[0][0];
      expect(callArgs.parentRuntimeAiSettings).toEqual({
        modelString: "openai:gpt-4o-mini",
        thinkingLevel: "medium",
      });
    });
  });

  describe("tool.execute.after hook wiring", () => {
    test("tool.execute.after hook is invoked after execute", async () => {
      const reg = registration as unknown as Record<string, unknown>;
      const original = reg["tool.execute.after"];
      const afterSpy = mock((_input: unknown, _output: unknown) => Promise.resolve());
      reg["tool.execute.after"] = afterSpy;
      try {
        const tools: Record<string, Tool> = {};
        const allowlisted = new Set<string>();
        integrateWanxiangshuTools(
          tools,
          allowlisted,
          {
            cwd: "/repo",
            runtime: new LocalRuntime("/repo"),
            runtimeTempDir: "/tmp",
            workspaceId: "ws-1",
          } as ToolConfiguration,
          "ws-1"
        );

        await tools.coder!.execute!(
          {
            intents: [
              {
                objective: "add test",
                background: "coverage",
                targets: [{ file: "src/a.ts", guide: "add a test" }],
              },
            ],
            tdd: "red",
          },
          { toolCallId: "tc-after", messages: [], abortSignal: undefined, context: {} }
        );

        expect(afterSpy).toHaveBeenCalled();
        const [input, output] = afterSpy.mock.calls[0] as unknown as [
          { tool: string },
          { error: string },
        ];
        expect(input.tool).toBe("coder");
        expect(output.error).toBe("");
      } finally {
        reg["tool.execute.after"] = original;
      }
    });

    test("after hook receives error when tool returns failure object", async () => {
      const afterSpy = mock((_input: unknown, _output: unknown) => Promise.resolve());
      const fakeExecute = (async () => ({ success: false, error: "denied" })) as NonNullable<
        Tool["execute"]
      >;
      const wrapped = wrapToolExecuteWithAfterHook(
        "coder",
        fakeExecute,
        { cwd: "/repo", workspaceId: "ws-1", runtime: null } as Parameters<
          typeof wrapToolExecuteWithAfterHook
        >[2],
        afterSpy as unknown as Parameters<typeof wrapToolExecuteWithAfterHook>[3]
      );

      const result = await wrapped(
        { intents: [] },
        { toolCallId: "tc-fail", messages: [], context: {} } as Parameters<NonNullable<Tool["execute"]>>[1]
      );

      expect(result).toEqual({ success: false, error: "denied" });
      expect(afterSpy).toHaveBeenCalled();
      const output = afterSpy.mock.calls[0][1] as unknown as { error: string };
      expect(output.error).toBe("denied");
      expect(output.error.length).toBeGreaterThan(0);
    });
  });


    test('tool.execute.before hook is invoked before execute on coder', async () => {
      const reg = registration as unknown as Record<string, unknown>;
      const original = reg['tool.execute.before'];
      const beforeSpy = mock((_input: unknown, _output: unknown) => Promise.resolve());
      reg['tool.execute.before'] = beforeSpy;
      try {
        const tools: Record<string, Tool> = {};
        const allowlisted = new Set<string>();
        integrateWanxiangshuTools(
          tools,
          allowlisted,
          {
            cwd: '/repo',
            runtime: new LocalRuntime('/repo'),
            runtimeTempDir: '/tmp',
            workspaceId: 'ws-1',
          } as ToolConfiguration,
          'ws-1'
        );
        const args = {
          intents: [
            {
              objective: 'Refactor module X',
              background: 'cleanup',
              targets: [{ file: 'src/x.ts', guide: 'split file' }],
            },
          ],
          tdd: 'red',
        };
        await tools.coder!.execute!(
          args,
          { toolCallId: 'tc-ui', messages: [], abortSignal: undefined, context: {} }
        );
        // Verify the binding actually invoked the before hook with the right tool name.
        expect(beforeSpy).toHaveBeenCalled();
        const [input] = beforeSpy.mock.calls[0] as unknown as [
          { tool: string },
        ];
        expect(input.tool).toBe('coder');
      } finally {
        reg['tool.execute.before'] = original;
      }
    });

  describe('runWanxiangshuSystemTransform', () => {
    test('clears system output length via hook', async () => {
      const reg = registration as unknown as Record<string, unknown>;
      const original = reg['systemTransform'];
      const transformSpy = mock((_input: unknown, output: { system: { length: number } | null }) => {
        if (output.system) {
          output.system.length = 0;
        }
        return Promise.resolve();
      });
      reg['systemTransform'] = transformSpy;
      try {
        const result = await runWanxiangshuSystemTransform({
          system: { length: 1000, content: 'long prompt' },
        });
        expect(transformSpy).toHaveBeenCalled();
        expect(result.system).toBeDefined();
        expect(result.system?.length).toBe(0);
      } finally {
        reg['systemTransform'] = original;
      }
    });

    test('passes through when systemTransform not registered', async () => {
      const reg = registration as unknown as Record<string, unknown>;
      const original = reg['systemTransform'];
      reg['systemTransform'] = undefined;
      try {
        const result = await runWanxiangshuSystemTransform({
          system: { length: 500 },
        });
        expect(result.system?.length).toBe(500);
      } finally {
        reg['systemTransform'] = original;
      }
    });
  });
});
