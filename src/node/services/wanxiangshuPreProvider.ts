import {
  runWanxiangshuCompactingTransform,
  transformWanxiangshuMessages,
} from "@/node/services/wanxiangshuBinding";

export async function applyWanxiangshuPreProviderTransforms(input: {
  workspacePath?: string;
  workspaceId?: string;
  effectiveAgentId?: string;
  messages: unknown[];
}): Promise<unknown[]> {
  let messages = input.messages;
  if (input.effectiveAgentId === "compact") {
    messages = await runWanxiangshuCompactingTransform(
      input.workspaceId?.trim() ?? "",
      input.workspacePath?.trim() ?? "",
      messages,
    );
  }
  return transformWanxiangshuMessages({
    workspacePath: input.workspacePath,
    workspaceId: input.workspaceId,
    effectiveAgentId: input.effectiveAgentId,
    messages,
  });
}