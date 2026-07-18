import * as fs from "fs/promises";
import * as path from "path";

import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config project normalization", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("drops persisted null taskExperiments before projects.list output validation", async () => {
    const projectPath = "/tmp/project-with-legacy-task-experiments";
    const configPath = path.join(env.config.rootDir, "config.json");

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          projects: [
            [
              projectPath,
              {
                workspaces: [
                  {
                    path: "/tmp/project-with-legacy-task-experiments/ws-1",
                    taskExperiments: null,
                  },
                ],
              },
            ],
          ],
        },
        null,
        2
      )
    );

    const projects = await env.orpc.projects.list();
    expect(projects).toEqual([
      [
        projectPath,
        {
          workspaces: [
            {
              path: "/tmp/project-with-legacy-task-experiments/ws-1",
            },
          ],
        },
      ],
    ]);

    const reloaded = env.config.loadConfigOrDefault();
    expect(reloaded.projects.get(projectPath)?.workspaces[0]?.taskExperiments).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      projects: Array<[string, { workspaces: Array<{ taskExperiments?: unknown }> }]>
    };
    expect(persisted.projects[0]?.[1].workspaces[0]?.taskExperiments).toBeUndefined();
  });
});
