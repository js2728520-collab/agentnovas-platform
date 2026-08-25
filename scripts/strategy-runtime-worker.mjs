import os from "node:os";

import pg from "pg";

import { researchDatabaseUrl } from "../lib/postgres.ts";
import {
  processNextRuntimeExplanation,
  processNextStrategyRuntimeDeployment,
} from "../lib/strategy-runtime-worker.ts";
import { processNextFollowRuntimeDeployment } from "../lib/follow-runtime-worker.ts";
import { processNextFollowSettlement } from "../lib/strategy-follow-settlement-repository.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";

const connectionString = researchDatabaseUrl();
if (!connectionString) throw new Error("RESEARCH_DATABASE_URL or DATABASE_URL is required");
if (process.env.STRATEGY_RUNTIME_ENABLED !== "true") throw new Error("STRATEGY_RUNTIME_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.STRATEGY_RUNTIME_WORKER_POOL_SIZE || 6),
  application_name: "agentnovas-runtime-worker",
});
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const heartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "runtime",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  onError: (error) => console.error("Runtime Worker heartbeat failed", {
    code: error instanceof Error ? error.name : "UNKNOWN",
  }),
});
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  await heartbeat.start();
  while (!stopping) {
    try {
      const result = await processNextStrategyRuntimeDeployment(pool, { workerId });
      const explanation = await processNextRuntimeExplanation(pool, { workerId: `${workerId}-explanation` });
      // 社区策略跟单走自己的租约与周期（T4.4）。两条租约的挑选条件互斥，不会互相饿死。
      const follow = await processNextFollowRuntimeDeployment(pool, { workerId: `${workerId}-follow` });
      // 周结算：每次只处理一个 (合同, 周)，绝大多数轮次返回 null。
      const settlement = await processNextFollowSettlement(pool);
      if (settlement) console.info("Follow week settled", {
        contractId: settlement.contractId,
        weekStart: settlement.weekStart,
        feeAmount: settlement.feeAmount,
        replayed: settlement.replayed,
      });
      if (!result && !explanation && !follow && !settlement) await delay(1_000);
      else if (result?.status === "waiting_for_candle" && !explanation) await delay(250);
      else {
        heartbeat.setCurrentJob(result?.cycleId || explanation?.jobId || null);
        if (result?.status === "completed") console.info("Runtime cycle completed", {
          cycleId: result.cycleId,
          sequence: result.sequence,
          duplicate: result.duplicate,
          liveOutcome: result.liveReceipt?.outcome ?? null,
        });
        // 实盘下发失败必须单独喊出来。
        //
        // 它曾经只是 Worker 内部一个没人读的变量：翻译失败、执行服务不可达、
        // RECONCILE_WAIT、被熔断拒单——全部静默。而周期本身照常「completed」，
        // 客户那边七阶段叙述照常产出，看起来一切正常。
        if (result?.liveExecutionError) console.error("Live execution failed", {
          cycleId: result.cycleId,
          error: result.liveExecutionError,
        });
        // 被拒的回执同样要可见：outcome=rejected 意味着这一轮没有真实成交。
        if (result?.liveReceipt && result.liveReceipt.outcome === "rejected") console.warn("Live order rejected", {
          cycleId: result.cycleId,
          reason: result.liveReceipt.rejectionReason,
        });
        if (explanation) console.info("Runtime explanation processed", {
          jobId: explanation.jobId,
          cycleId: explanation.cycleId,
          status: explanation.status,
        });
        await heartbeat.markSuccess();
      }
    } catch (error) {
      await heartbeat.markFailure(error);
      console.error("Runtime cycle failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
      await delay(1_000);
    }
  }
} finally {
  await heartbeat.stop();
  await pool.end();
}
