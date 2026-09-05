import { createApp } from "./app.js";
import { buildDeps, type ExecCtx } from "./build-deps.js";
import { describeError, startScheduledRun } from "./digest-run.js";
import type { Env } from "./env.js";

export { TilChatAgent } from "./chat-agent.js";
export { DigestWorkflow } from "./digest-workflow.js";

const app = createApp((c) =>
  buildDeps(c.env as Env, c.executionCtx as ExecCtx),
);

export default {
  fetch: app.fetch,
  /**
   * Two schedules share this handler (`triggers.crons` in wrangler.jsonc): the
   * Monday weekly digest and the 1st-of-the-month reading report. Cloudflare's
   * documented way to tell them apart is `controller.cron` — the verbatim cron
   * expression that fired — so which run to start is decided from that string
   * alone, in `startScheduledRun`. Keeping the routing there and not here is what
   * makes it testable: this module imports the Workflow and the chat agent, so it
   * cannot be loaded outside workerd.
   *
   * One firing fans out over every eligible user, so the result is a list: each
   * started run gets its own line (a per-user failure was already logged and
   * skipped inside `startScheduledRun`), and an empty list is logged too — "no
   * eligible users" is a very different diagnosis from "the cron never fired".
   */
  async scheduled(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx: ExecCtx,
  ): Promise<void> {
    const deps = buildDeps(env, ctx);
    try {
      const started = await startScheduledRun(deps, controller.cron);
      if (started.length === 0) {
        console.log(
          `[cron ${controller.cron}] no eligible users — nothing started`,
        );
      }
      for (const run of started) {
        console.log(
          `[cron ${controller.cron}] ${run.kind} run ${run.id} started for user ${run.userId} (window ${run.windowDays}d)`,
        );
      }
    } catch (err) {
      console.error(
        `[cron ${controller.cron}] could not start scheduled run:`,
        describeError(err),
      );
    }
  },
};
