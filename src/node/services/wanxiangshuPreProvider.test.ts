import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWanxiangshuPreProviderTransforms } from "./wanxiangshuPreProvider";

describe("applyWanxiangshuPreProviderTransforms", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("compact agent runs pre-provider path without throwing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wanxiangshu-test-"));
    const messages = [{ id: "m1", role: "user", content: "hello" }];
    const result = await applyWanxiangshuPreProviderTransforms({
      workspaceId: "ws-1",
      workspacePath: tempDir,
      effectiveAgentId: "compact",
      messages,
    });
    expect(Array.isArray(result)).toBe(true);
  });

  test("non-compact agent skips compacting-only branch", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wanxiangshu-test-"));
    const messages = [{ id: "m1", role: "user", content: "hello" }];
    const result = await applyWanxiangshuPreProviderTransforms({
      workspaceId: "ws-1",
      workspacePath: tempDir,
      effectiveAgentId: "exec",
      messages,
    });
    expect(result).toEqual(messages);
  });
});