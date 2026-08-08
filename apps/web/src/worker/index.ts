import { createApp } from "./app.js";
import { buildDeps, type ExecCtx } from "./build-deps.js";
import { describeError, startDigestRun } from "./digest-run.js";
import type { Env } from "./env.js";

export { TilChatAgent } from "./chat-agent.js";
export { DigestWorkflow } from "./digest-workflow.js";

const app = createApp((c) => buildDeps(c.env as Env, c.executionCtx as ExecCtx));

export default {
  fetch: app.fetch,
  async scheduled(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx: ExecCtx,
  ): Promise<void> {
    const deps = buildDeps(env, ctx);
    try {
      const started = await startDigestRun(deps, {});
      console.log(
        `[cron ${controller.cron}] digest run ${started.id} started (window ${started.windowDays}d)`,
      );
    } catch (err) {
      console.error(
        `[cron ${controller.cron}] could not start digest run:`,
        describeError(err),
      );
    }
  },
};
