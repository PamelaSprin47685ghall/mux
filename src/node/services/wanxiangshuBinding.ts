import { jsonSchema, tool, type Tool } from "ai";
import { createRegistration } from "../../../../wanxiangshu/build/src/Hosts/Mux/Plugin.js";
import type {
  HostDependencies,
  ParentRuntimeMuxEnvOverlay,
  PluginEvent,
  PluginEventHelpers,
  PluginRegistration,
  PluginToolConfiguration,
  PluginToolLike,
  RuntimeHandle,
  TaskServiceLike,
  TaskWaitOptions,
} from "wanxiangshu";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import type { Runtime } from "@/node/runtime/Runtime";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import { log } from "@/node/services/log";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { createRuntimeForWorkspace, resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { readAgentDefinition, resolveAgentFrontmatter } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";

const pluginConcurrentTools = new Set(["coder", "investigator", "meditator", "browser"]);
const eventIntegratedServices = new WeakSet<AIService>();

const roleScopedHostRemovals: Record<string, string[]> = {
  manager: [
    "bash",
    "bash_.*",
    "file_read",
    "task",
    "task_.*",
    "stealth_browser_mcp_.*",
    "attach_file",
    "review_pane_.*",
    "set_goal",
    "get_goal",
    "complete_goal",
    "notify",
    "agent_skill_list",
  ],
  coder: [
    "bash",
    "bash_.*",
    "web_.*",
    "google_search",
    "url_context",
    "ask_user_question",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
  investigator: [
    "bash",
    "bash_.*",
    "file_edit_.*",
    "web_.*",
    "google_search",
    "url_context",
    "agent_skill_.*",
    "skills_catalog_.*",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
  reviewer: [
    "bash",
    "bash_.*",
    "file_edit_.*",
    "web_.*",
    "google_search",
    "url_context",
    "agent_skill_.*",
    "skills_catalog_.*",
    "stealth_browser_mcp_.*",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
  browser: [
    "bash",
    "bash_.*",
    "file_edit_.*",
    "web_.*",
    "google_search",
    "url_context",
    "agent_skill_.*",
    "skills_catalog_.*",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
  meditator: [
    "bash",
    "bash_.*",
    "file_edit_.*",
    "web_.*",
    "google_search",
    "url_context",
    "agent_skill_.*",
    "skills_catalog_.*",
    "stealth_browser_mcp_.*",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
  executor: [
    "bash",
    "bash_.*",
    "file_edit_.*",
    "web_.*",
    "google_search",
    "url_context",
    "agent_skill_.*",
    "skills_catalog_.*",
    "stealth_browser_mcp_.*",
    "todo_.*",
    "memory",
    "workflow_.*",
    "heartbeat",
    "notify",
    "set_goal",
    "get_goal",
    "complete_goal",
    "attach_file",
  ],
};

const roleScopedHostAdds: Record<string, string[]> = {
  coder: ["file_edit_.*"],
};

function shouldSkipStreamEndEvent(event: StreamEndEvent): boolean {
  return event.metadata.muxMetadata?.type === "compaction-request";
}

export let boundConfig: Config | undefined;
let boundAiService: AIService | undefined;
let boundWorkspaceService: WorkspaceService | undefined;
let boundHistoryService: HistoryService | undefined;
let boundTaskService: TaskService | undefined;
let slashCommandParentRuntime: ParentRuntimeMuxEnvOverlay | undefined;

function toRuntimeHandle(runtime: Runtime | null | undefined): RuntimeHandle | null {
  return (runtime ?? null) as unknown as RuntimeHandle | null;
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  switch (value?.trim()) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value.trim() as ThinkingLevel;
    case "med":
      return "medium";
    default:
      return undefined;
  }
}

function pickWorkspaceAiSettings(metadata: WorkspaceMetadata): {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
} {
  const selectedAgentId = metadata.agentId?.trim() || metadata.agentType?.trim() || undefined;
  const byAgent = selectedAgentId ? metadata.aiSettingsByAgent?.[selectedAgentId] : undefined;
  const aiSettings = byAgent ?? metadata.aiSettings;
  return {
    ...(aiSettings?.model?.trim() ? { modelString: aiSettings.model.trim() } : {}),
    ...(normalizeThinkingLevel(aiSettings?.thinkingLevel) ? { thinkingLevel: normalizeThinkingLevel(aiSettings?.thinkingLevel) } : {}),
  };
}

function mergeParentRuntimeMuxEnv(
  muxEnv: Record<string, string>,
  parentRuntime: ParentRuntimeMuxEnvOverlay | null | undefined
): Record<string, string> {
  if (!parentRuntime) {
    return muxEnv;
  }

  const merged = { ...muxEnv };
  const modelString = parentRuntime.MUX_MODEL_STRING?.trim();
  const thinkingLevel = normalizeThinkingLevel(parentRuntime.MUX_THINKING_LEVEL);
  if (modelString) {
    merged.MUX_MODEL_STRING = modelString;
  }
  if (thinkingLevel) {
    merged.MUX_THINKING_LEVEL = thinkingLevel;
  }
  return merged;
}

function createTaskServiceLike(taskService: TaskService): TaskServiceLike {
  return {
    async create(input) {
      const result = await taskService.create({
        parentWorkspaceId: input.parentWorkspaceId,
        kind: input.kind,
        agentId: input.agentId,
        modelString: input.modelString,
        thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
        parentRuntimeAiSettings: input.parentRuntimeAiSettings
          ? {
              modelString: input.parentRuntimeAiSettings.modelString,
              thinkingLevel: normalizeThinkingLevel(input.parentRuntimeAiSettings.thinkingLevel),
            }
          : undefined,
        prompt: input.prompt,
        title: input.title,
        experiments: input.experiments as Record<string, unknown> | undefined,
      });

      return result.success
        ? {
            success: true as const,
            data: {
              taskId: result.data.taskId,
              kind: result.data.kind,
              status: result.data.status,
            },
          }
        : {
            success: false as const,
            error: result.error,
          };
    },
    async waitForAgentReport(taskId: string, opts: TaskWaitOptions) {
      const result = await taskService.waitForAgentReport(taskId, {
        requestingWorkspaceId: opts.requestingWorkspaceId,
        abortSignal: opts.abortSignal,
        backgroundOnMessageQueued: opts.backgroundOnMessageQueued,
        timeoutMs: opts.timeoutMs,
      });
      return { reportMarkdown: result.reportMarkdown };
    },
    async continueAgentTask() {
      return {
        success: false as const,
        error: "Task continuation is not supported by the Mux task service.",
      };
    },
  };
}

async function resolveWorkspacePluginContext(
  workspaceId: string,
  parentRuntime?: ParentRuntimeMuxEnvOverlay | null
): Promise<{ cwd: string; runtime: RuntimeHandle | null; muxEnv: Record<string, string> } | null> {
  if (!boundAiService) {
    return null;
  }

  const metadataResult = await boundAiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) {
    return null;
  }

  const metadata = metadataResult.data;
  const runtime = createRuntimeForWorkspace(metadata);
  const workspaceRoot = resolveWorkspaceRootPath(metadata, runtime);
  const aiSettings = pickWorkspaceAiSettings(metadata);
  const muxEnv = mergeParentRuntimeMuxEnv(
    getMuxEnv(metadata.projectPath, getRuntimeType(metadata.runtimeConfig), metadata.name, {
      workspaceId,
      modelString: aiSettings.modelString,
      thinkingLevel: aiSettings.thinkingLevel,
    }),
    parentRuntime ?? slashCommandParentRuntime
  );

  return {
    cwd: workspaceRoot,
    runtime: toRuntimeHandle(runtime),
    muxEnv,
  };
}

const hostDependencies: HostDependencies & { directory?: string } = {
  log,
  get directory() {
    return boundConfig ? ((boundConfig as any).getSessionDir ? (boundConfig as any).getSessionDir("mux-e2e-session") : ((boundConfig as any).rootDir || "")) : "";
  },
  get taskService() {
    return boundTaskService ? createTaskServiceLike(boundTaskService) : undefined;
  },
  resolveWorkspacePluginContext,
  loadConfigOrDefault: () => {
    if (!boundConfig) {
      throw new Error("wanxiangshu host is not bound");
    }
    return boundConfig.loadConfigOrDefault() as unknown as ReturnType<HostDependencies["loadConfigOrDefault"]>;
  },
  readAgentDefinition: (runtime, workspacePath, agentId) =>
    readAgentDefinition(runtime as unknown as Runtime, workspacePath, agentId),
  resolveAgentFrontmatter: (runtime, workspacePath, agentId) =>
    resolveAgentFrontmatter(runtime as unknown as Runtime, workspacePath, agentId),
  resolveAgentInheritanceChain: (request) =>
    resolveAgentInheritanceChain({
      ...request,
      runtime: request.runtime as unknown as Runtime,
    } as Parameters<typeof resolveAgentInheritanceChain>[0]),
  findWorkspaceEntry: (configFile, workspaceId) => {
    const entry = findWorkspaceEntry(
      configFile as unknown as ReturnType<Config["loadConfigOrDefault"]>,
      workspaceId
    );
    if (!entry?.workspace.id) {
      return undefined;
    }
    return {
      projectPath: entry.projectPath,
      workspace: { ...entry.workspace, id: entry.workspace.id },
    } as unknown as NonNullable<ReturnType<HostDependencies["findWorkspaceEntry"]>>;
  },
  getChatHistory: async (workspaceId) => {
    if (!boundHistoryService) {
      return [];
    }
    const result = await boundHistoryService.getHistoryFromLatestBoundary(workspaceId);
    return result.success ? result.data : [];
  },
};

const rawRegistration = createRegistration(hostDependencies);
export const registration: PluginRegistration =
  typeof rawRegistration === "function"
    ? (rawRegistration as any)(hostDependencies)
    : (rawRegistration as unknown as PluginRegistration);

export const wanxiangshuSlashCommands = registration.slashCommands;
export const wanxiangshuMcpServers = registration.mcpServers;

export function bindWanxiangshuHost(deps: {
  config: Config;
  aiService: AIService;
  workspaceService: WorkspaceService;
  historyService: HistoryService;
  taskService: TaskService;
}): void {
  boundConfig = deps.config;
  boundAiService = deps.aiService;
  boundWorkspaceService = deps.workspaceService;
  boundHistoryService = deps.historyService;
  boundTaskService = deps.taskService;
}

export function getWanxiangshuPluginToolPolicy(
  agentId: string,
  role?: string
): { add?: string[]; remove?: string[] } | undefined {
  // wanxiangshu exposes its own `read` tool on the plugin surface. Hide the host-native
  // `file_read` so the two do not compete for the same intent. This policy is only
  // supplied when the plugin integration is active; ordinary (non-plugin) agents never
  // see it, so `file_read` remains available outside the plugin path.
  const roleKey = role ?? "manager";
  const base = registration.getToolPolicy(agentId, roleKey);
  const add = [...(base?.add ?? [])];
  for (const pattern of roleScopedHostAdds[roleKey] ?? []) {
    if (!add.includes(pattern)) {
      add.push(pattern);
    }
  }
  const remove = [...(base?.remove ?? [])];
  for (const pattern of roleScopedHostRemovals[roleKey] ?? []) {
    if (!remove.includes(pattern)) {
      remove.push(pattern);
    }
  }
  if (!remove.includes("file_read")) {
    remove.push("file_read");
  }

  if (add.length === 0 && remove.length === 0) {
    return undefined;
  }

  return {
    ...(add.length > 0 ? { add } : {}),
    remove,
  };
}

function toAiTool(toolLike: PluginToolLike): Tool {
  if ("inputSchema" in toolLike && toolLike.inputSchema != null) {
    return toolLike as unknown as Tool;
  }

  if ("parameters" in toolLike && toolLike.parameters != null) {
    const { parameters, ...rest } = toolLike;
    return {
      ...rest,
      inputSchema: jsonSchema(parameters as Parameters<typeof jsonSchema>[0]),
    } as unknown as Tool;
  }

  return toolLike as unknown as Tool;
}

type WanxiangshuToolExecuteAfter = (
  input: Record<string, unknown>,
  output: { output: string; error: string; args?: unknown },
) => Promise<void>;

function getWanxiangshuToolExecuteAfter(): WanxiangshuToolExecuteAfter | undefined {
  const hook = (registration as PluginRegistration & Record<string, unknown>)["tool.execute.after"];
  return typeof hook === "function" ? (hook as WanxiangshuToolExecuteAfter) : undefined;
}

type WanxiangshuToolExecuteBefore = (
  input: Record<string, unknown>,
  output: { args?: unknown },
) => Promise<void>;

function getWanxiangshuToolExecuteBefore(): WanxiangshuToolExecuteBefore | undefined {
  const hook = (registration as PluginRegistration & Record<string, unknown>)["tool.execute.before"];
  return typeof hook === "function" ? (hook as WanxiangshuToolExecuteBefore) : undefined;
}

function toolResultToHookOutputString(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined || result === null) {
    return "";
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Mux plugin tools resolve to a plain string on success and to a failure object
// (`{ success: false, error }`, or any object carrying a non-empty `error`) on
// failure. The F# `tool.execute.after` hook treats `output.error === ""` as
// success and only then records to the bookkeeper, so a failed tool call must
// surface a non-empty error here or it would be recorded as if it succeeded.
function toolResultToHookError(result: unknown): string {
  if (result === null || result === undefined || typeof result !== "object") {
    return "";
  }
  const record = result as Record<string, unknown>;
  const errorField =
    typeof record.error === "string" && record.error.trim() !== "" ? record.error : "";
  if (record.success === false) {
    return errorField !== "" ? errorField : toolResultToHookOutputString(result);
  }
  return errorField;
}

export function wrapToolExecuteWithAfterHook(
  toolName: string,
  execute: NonNullable<Tool["execute"]>,
  pluginConfig: PluginToolConfiguration,
  after: WanxiangshuToolExecuteAfter,
): NonNullable<Tool["execute"]> {
  return async (args, options) => {
    const result = await execute(args, options);
    const hookOutput = {
      output: toolResultToHookOutputString(result),
      error: toolResultToHookError(result),
    };
    const workspaceId = pluginConfig.workspaceId?.trim() ?? "";
    await after(
      {
        tool: toolName,
        sessionID: workspaceId,
        workspaceId,
        directory: pluginConfig.cwd,
        callID: options?.toolCallId?.trim() ?? "",
        args,
      },
      hookOutput,
    );
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      return {
        ...record,
        output: hookOutput.output,
        error: hookOutput.error,
        success: !hookOutput.error,
      };
    }
    return hookOutput.output;
  };
}

function wrapToolExecuteWithBeforeHook(
  toolName: string,
  execute: NonNullable<Tool["execute"]>,
  toolExecuteBefore: any,
  workspaceId: string,
  cwd: string
): NonNullable<Tool["execute"]> {
  return async (args, options) => {
    const beforeOutput: { args?: unknown; error?: string } = { args };
    await toolExecuteBefore(
      {
        tool: toolName,
        sessionID: workspaceId,
        workspaceId,
        directory: cwd,
        callID: options?.toolCallId?.trim() ?? "",
        args,
      },
      beforeOutput,
    );
    if (beforeOutput.error) {
      return { success: false, error: beforeOutput.error };
    }
    return execute(beforeOutput.args ?? args, options);
  };
}

function registerToolDefinition(
  tools: Record<string, Tool>,
  allowlistedToolNames: Set<string>,
  definition: any,
  pluginConfig: PluginToolConfiguration
) {
  const execute: NonNullable<Tool["execute"]> = async (args, options) => {
    return definition.execute({ ...pluginConfig, abortSignal: options?.abortSignal }, args);
  };

  const integratedTool = tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
    execute,
  }) as Tool & { __allowConcurrent?: boolean };

  if (pluginConcurrentTools.has(definition.name)) {
    integratedTool.__allowConcurrent = true;
  }

  tools[definition.name] = integratedTool;
  allowlistedToolNames.add(definition.name);
}

function applyWrapper(
  tools: Record<string, Tool>,
  wrapperEntry: any,
  pluginConfig: PluginToolConfiguration
) {
  const target = tools[wrapperEntry.targetTool];
  if (!target) return;
  const wrappedToolLike = wrapperEntry.wrapper(target as unknown as PluginToolLike, pluginConfig);
  const wrappedAiTool = toAiTool(wrappedToolLike as PluginToolLike);
  let merged = {
    ...(target as unknown as Record<string, unknown>),
    ...(wrappedAiTool as unknown as Record<string, unknown>),
  } as Tool;
  tools[wrapperEntry.targetTool] = merged;
}

export function integrateWanxiangshuTools(
  tools: Record<string, Tool>,
  allowlistedToolNames: Set<string>,
  config: ToolConfiguration,
  streamWorkspaceId: string
): void {
  const workspaceId = config.workspaceId?.trim() || streamWorkspaceId;
  const pluginTaskService = config.taskService ?? boundTaskService;
  const subagentRole =
    config.experiments && typeof config.experiments.subagentRole === "string"
      ? config.experiments.subagentRole
      : undefined;
  const pluginConfig: PluginToolConfiguration & { sessionID?: string; sessionId?: string } = {
    cwd: config.cwd,
    workspaceId,
    sessionID: config.sessionID || config.sessionId || workspaceId,
    sessionId: config.sessionId || config.sessionID || workspaceId,
    runtime: toRuntimeHandle(config.runtime),
    ...(pluginTaskService ? { taskService: createTaskServiceLike(pluginTaskService) } : {}),
    ...(config.muxEnv ? { muxEnv: config.muxEnv } : {}),
    ...(subagentRole ? { subagentRole } : {}),
  };

  const toolExecuteAfter = getWanxiangshuToolExecuteAfter();
  const toolExecuteBefore = getWanxiangshuToolExecuteBefore();

  for (const definition of registration.tools) {
    if (definition.condition && !definition.condition(pluginConfig)) {
      continue;
    }
    registerToolDefinition(tools, allowlistedToolNames, definition, pluginConfig);
  }

  for (const entry of registration.wrappers) {
    applyWrapper(tools, entry, pluginConfig);
  }

  for (const name of Object.keys(tools)) {
    const t = tools[name];
    if (t && t.execute) {
      let exec = t.execute;
      if (toolExecuteAfter) {
        exec = wrapToolExecuteWithAfterHook(name, exec, pluginConfig, toolExecuteAfter);
      }
      if (toolExecuteBefore) {
        exec = wrapToolExecuteWithBeforeHook(name, exec, toolExecuteBefore, workspaceId, config.cwd);
      }
      t.execute = exec;
    }
  }
}

export async function runWanxiangshuCompactingTransform(
  workspaceId: string,
  workspacePath: string,
  messages: unknown[],
): Promise<unknown[]> {
  const compactingTransform = registration.compactingTransform;
  if (!compactingTransform) {
    return messages;
  }

  const output = { messages };
  await compactingTransform(
    {
      sessionID: workspaceId,
      workspaceId,
      workspacePath,
    },
    output,
  );
  return output.messages;
}

export async function runWanxiangshuSystemTransform(input: {
  system?: { length?: number; content?: unknown } | null;
}): Promise<{ system?: { length: number; content?: unknown } | null }> {
  type SystemTransformResult = { system?: { length: number; content?: unknown } | null };
  const hook = (registration as PluginRegistration & Record<string, unknown>)["systemTransform"];
  if (typeof hook !== "function") {
    return input as SystemTransformResult;
  }
  const output = { system: input.system ?? null };
  await (hook as (i: unknown, o: typeof output) => Promise<void>)({ workspacePath: boundConfig?.rootDir ?? "" }, output);
  return (output.system ? output : {}) as SystemTransformResult;
}

export async function executeWanxiangshuSlashCommand(
  command: string,
  workspaceId: string,
  args: string,
  parentRuntimeMuxEnv?: ParentRuntimeMuxEnvOverlay | null
): Promise<string | null> {
  const slashCommand = registration.slashCommands.find((candidate) => candidate.key === command);
  if (!slashCommand) {
    return null;
  }

  slashCommandParentRuntime = parentRuntimeMuxEnv ?? undefined;
  try {
    return await slashCommand.execute(workspaceId, args);
  } finally {
    slashCommandParentRuntime = undefined;
  }
}

export async function transformWanxiangshuMessages(input: {
  workspacePath?: string;
  workspaceId?: string;
  effectiveAgentId?: string;
  messages: unknown[];
}): Promise<unknown[]> {
  if (!registration.messagesTransform) {
    return input.messages;
  }

  const output = { messages: input.messages };
  await registration.messagesTransform(
    {
      workspacePath: input.workspacePath,
      workspaceId: input.workspaceId,
      effectiveAgentId: input.effectiveAgentId,
    },
    output
  );
  return output.messages;
}

async function sendNudgeHelper(workspaceId: string, message: string, modelOverride?: string, agentOverride?: string) {
  if (!boundWorkspaceService) {
    return false;
  }
  const sendOptions = boundWorkspaceService.getGoalContinuationKickoffSendOptions(workspaceId);
  if (!sendOptions) {
    return false;
  }
  if (modelOverride) {
    let normalizedModel = modelOverride;
    if (modelOverride.includes("/") && !modelOverride.includes(":")) {
      normalizedModel = modelOverride.replace("/", ":");
    }
    sendOptions.model = normalizedModel;
  }
  if (agentOverride) {
    sendOptions.agentId = agentOverride;
  }
  const result = await boundWorkspaceService.sendMessage(workspaceId, message, sendOptions, {
    synthetic: true,
    agentInitiated: true,
    startStreamInBackground: true,
  });
  return result.success;
}

async function getTodosHelper(workspaceId: string) {
  if (!boundConfig) {
    return [];
  }
  const todos = await readTodosForSessionDir(boundConfig.getSessionDir(workspaceId));
  return todos.filter((todo) => todo.status !== "completed").map((todo) => todo.content);
}

export function integrateWanxiangshuEvents(aiService: AIService): void {
  if (eventIntegratedServices.has(aiService)) {
    return;
  }
  eventIntegratedServices.add(aiService);

  const helpers: PluginEventHelpers = {
    nudge: sendNudgeHelper,
    getTodos: getTodosHelper,
  };

  const dispatch = (event: PluginEvent) => {
    void Promise.resolve(registration.eventHook(event, helpers)).catch((error) => {
      log.debug("wanxiangshu event hook failed", { error, event });
    });
  };

  aiService.on("stream-end", (event: StreamEndEvent) => {
    if (shouldSkipStreamEndEvent(event)) {
      return;
    }
    dispatch({ type: "stream-end", workspaceId: event.workspaceId, properties: event });
  });
  aiService.on("stream-abort", (event: StreamAbortEvent) => {
    dispatch({ type: "stream-abort", workspaceId: event.workspaceId, properties: event });
  });
  aiService.on("error", (event: ErrorEvent) => {
    dispatch({ type: "error", workspaceId: event.workspaceId, properties: event });
  });
}
