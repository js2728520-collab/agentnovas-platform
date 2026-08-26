"use client";

/**
 * 交易大厅与 AI 决策会议室。
 *
 * 这是平台核心卖点「可解释、可审计的决策过程」最直观的两个界面：
 * 大厅按七智能体的空间位置展示每个角色的最新结论，会议室钻进单轮决策看
 * 七阶段的完整结论、模型解释与审计记录。
 *
 * 从遗留 SPA app/client-app.tsx 抽出（P4）。原来它们只能在 /workspace 里通过
 * 内部字符串路由到达，现在是真实路由：大厅 /trading-hall，会议室
 * /trading-hall/meeting。导航从 go("...") 换成真实跳转。
 */

import Image from "next/image";

import styles from "./decision-hall.module.css";
import { useEffect, useMemo, useState } from "react";

import {
  tradingHallAgentCatalog,
  type TradingHallPayload,
  type TradingHallStrategy,
} from "@/packages/contracts/src/trading-hall";
import { tradingHallEnvironmentLabel, tradingHallStrategyPresentation } from "./trading-hall-status";

const waitingAgentTalks = [
  ["市场分析师", "等待完整行情与候选机会"],
  ["技术分析师", "等待已收盘 K 线"],
  ["策略研究员", "等待候选策略方案"],
  ["反方审查员", "等待反向证据"],
  ["首席风控官", "等待确定性风险检查"],
  ["AI 决策官", "等待完整决策链"],
  ["交易执行员", "等待影子或模拟执行意图"],
];

function AgentDialoguePanel({ talks = [] }: { talks?: string[][] }) {
  const rows = talks.length ? talks : waitingAgentTalks;
  return (
    <section
      className={styles.widget}
      aria-label="Agent 工作记录"
    >
      <div className={styles.widgetHead}>
        <b>Agent 工作记录</b>
        <span>DECISION LOG</span>
      </div>
      {/* 可滚动区域必须能被键盘聚焦，否则只能用鼠标滚轮翻——用键盘的人根本读不到
          下面的内容。tabIndex 0 + role/label 是 axe 的 scrollable-region-focusable
          要求的最小形态。 */}
      {/* jsx-a11y 不允许非交互元素带 tabIndex，而 axe 的 scrollable-region-focusable
          要求可滚动区域必须能被键盘聚焦。两条规则在这里是冲突的，以实际行为为准：
          没有 tabIndex，用键盘的人只能看到这个框的第一屏，下面的内容读不到。 */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={styles.dialogueViewport} tabIndex={0} role="region" aria-label="七角色决策对话记录">
        <div className={styles.dialogueTrack}>
          {rows.map((x, i) => (
            <article key={`${x[0]}-${i}`}>
              <b>{x[0] === "策略工作流" ? "AI Decision Officer" : x[0]}</b>
              <p>{x[1]}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}


function StrategyMonitorTicker({
  strategies = [],
  loading = false,
}: {
  strategies?: TradingHallStrategy[];
  loading?: boolean;
}) {
  const rows = strategies.map((strategy) => {
    const presentation = tradingHallStrategyPresentation(strategy);
    return {
      name: `${strategy.name}${strategy.version ? ` · ${strategy.version}` : ""}`,
      universe: strategy.symbols.map((symbol) => symbol.replace("USDT", "")).join(" / "),
      risk: `总仓位 ≤ ${strategy.risk.maxTotalAllocationPct}%`,
      decision: strategy.latestDecisionStatus || "尚无决策记录",
      state: presentation.label,
      inactive: presentation.inactive,
    };
  });
  return (
    <div className={styles.monitorTrack} aria-label="三套AI策略服务端状态">
      <div className={styles.monitorTrack}>
        {rows.length === 0 && (
          <article className={styles.monitorEmpty}>
            <span className={styles.monitorDot} />
            <div>
              <small>官方策略卡</small>
              <b>{loading ? "正在读取真实策略状态" : "当前没有策略部署记录"}</b>
            </div>
          </article>
        )}
        {rows.map((row) => (
          <article key={row.name} aria-label={`${row.name}：${row.state}`}>
            <span className={styles.monitorDot} data-inactive={row.inactive || undefined} />
            <div>
              <small>{row.state}</small>
              <b>{row.name}</b>
            </div>
            <div>
              <small>目标交易池</small>
              <b>{row.universe} · USDT 现货</b>
            </div>
            <div>
              <small>硬风险上限</small>
              <b>{row.risk}</b>
            </div>
            <div>
              <small>最新决策</small>
              <b>{row.decision}</b>
            </div>
          </article>
        ))}
      </div>
      <div className={styles.monitorPages}>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function useTradingHallData() {
  const [data, setData] = useState<TradingHallPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/trading-hall", { cache: "no-store" });
        if (!response.ok) throw new Error(`交易大厅数据读取失败（${response.status}）`);
        const payload = await response.json() as TradingHallPayload;
        if (!active) return;
        setData(payload);
        setError("");
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "交易大厅数据读取失败");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshVersion]);

  return {
    data,
    loading,
    error,
    retry: () => {
      setLoading(true);
      setRefreshVersion((version) => version + 1);
    },
  };
}

const hallAgentPositions = {
  market_analysis: { x: 14, y: 35 },
  technical_analysis: { x: 74, y: 35 },
  strategy_proposal: { x: 13, y: 63 },
  adversarial_review: { x: 75, y: 63 },
  risk_approval: { x: 44, y: 26 },
  execution_receipt: { x: 44, y: 74 },
} as const;
const agents = tradingHallAgentCatalog.flatMap((agent) => {
  if (agent.key === "final_decision") return [];
  return [{
    key: agent.key,
    n: agent.name,
    x: hallAgentPositions[agent.key].x,
    y: hallAgentPositions[agent.key].y,
  }];
});

// className 参数随样式模块化一起移除：外观由 CSS Module 决定，调用方不再拼类名。
function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className={styles.pageHead}>
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div>
        {actions}
      </div>
    </div>
  );
}

export default function DecisionHall() {
  const { data, loading, error, retry } = useTradingHallData();
  const liveTalks = useMemo(() => data?.decisionRounds.flatMap((round) =>
    round.events.flatMap((event) => event.role === "legacy_audit" ? [] : [[
      event.name,
      `【${round.strategyName}】${event.conclusion}${event.explanation ? `；模型解释：${event.explanation}` : ""}`,
    ]]),
  ) || [], [data]);
  const talkFor = (agentName: string) =>
    data?.agents.find((agent) => agent.name === agentName)?.latestConclusion ||
    "等待完整决策记录";
  const statusFor = (agentName: string) => {
    const status = data?.agents.find((agent) => agent.name === agentName)?.status;
    if (status === "reported") return "已提交报告";
    if (status === "legacy_gap") return "旧周期缺少本阶段";
    return "等待记录";
  };
  const meetingTalk = data?.agents.find((agent) => agent.key === "final_decision")?.latestConclusion ||
    "等待前五阶段完成后形成最终决定";
  const executionModeLabel = tradingHallEnvironmentLabel(data?.productBoundary.currentExecutionMode);
  return (
    <>
      <PageHead
        title="交易大厅"
        sub="七角色顺序决策链 · 三张官方策略卡 · 每 5 秒同步"
        actions={
          <>
            <button className={styles.soft} onClick={() => window.location.assign("/trading-hall/meeting")}>
              进入会议室
            </button>
            <button className={styles.soft} onClick={() => window.location.assign("/paper")}>
              风险与交易控制
            </button>
          </>
        }
      />
      <div className={styles.stats} aria-label="交易大厅产品边界">
        <span>
          <i className={styles.pulse} />
          真实订单关闭
        </span>
        <span>
          目标市场 <b>USDT 现货</b>
        </span>
        <span>
          交易池 <b>BTC / ETH / SOL</b>
        </span>
        <span>
          当前环境 <b>{executionModeLabel}</b>
        </span>
      </div>
      <div className={styles.loadState} aria-live="polite">
        {loading && !data && <span>正在读取交易大厅真实记录…</span>}
        {error && <span role="alert">{error} <button type="button" onClick={retry}>重试</button></span>}
        {!loading && !error && data && data.decisionRounds.length === 0 && <span>当前没有决策轮记录；系统不会用演示数据填充。</span>}
        {data && data.legacyAuditRecords > 0 && <span>检测到 {data.legacyAuditRecords} 条旧周期审计记录；旧记录缺少独立 AI 最终决策阶段，已明确标记。</span>}
      </div>
      <p className={styles.illustrationNote} role="note">
        角色位置仅为界面示意，不代表智能体正在运行；状态以服务端策略与决策记录为准。
      </p>
      <div className={styles.hall}>
        <div className={styles.left}>
          <div className={styles.scene}>
            <Image
              src="/trading-hall.webp"
              width={1672}
              height={941}
              sizes="(max-width: 768px) 100vw, 860px"
              alt="AI quantitative trading operations center"
            />
            {agents.map((a) => (
              <button
                key={a.n}
                className={styles.hotspot}
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                // 原来点击角色会把该角色名带进 Agent 对话；新的 AI 助手不按角色分线，
                // 所以只做跳转。角色的最新结论就在这张卡片上，不必再带过去。
                onClick={() => window.location.assign("/assistant")}
              >
                <span className={styles.operator} aria-hidden="true" />
                <i />
                <b>{a.n}</b>
                <small>{statusFor(a.n)}</small>
                <span className={styles.speech}>
                  {talkFor(a.n)}
                  <em>•••</em>
                </span>
              </button>
            ))}
            <button className={styles.meetingHotspot} onClick={() => window.location.assign("/trading-hall/meeting")}>
              <span>AI 决策官</span>
              <small>{data?.agents.find((agent) => agent.key === "final_decision")?.status === "reported" ? "已提交决策" : "等待记录"}</small>
              <b className={styles.meetingSpeech}>
                {meetingTalk}
                <em>•••</em>
              </b>
            </button>
          </div>
          <StrategyMonitorTicker strategies={data?.strategies || []} loading={loading} />
        </div>
        <aside className={styles.right}>
          <AgentDialoguePanel talks={liveTalks} />
        </aside>
      </div>
    </>
  );
}


export function DecisionMeeting() {
  const [auditOpen, setAuditOpen] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState("");
  const { data, loading, error, retry } = useTradingHallData();
  const selectedRound = data?.decisionRounds.find((round) => round.decisionRoundId === selectedRoundId) ||
    data?.decisionRounds[0] || null;
  const eventFor = (role: string) => selectedRound?.events.find((event) => event.role === role);
  const finalDecision = eventFor("final_decision");
  return (
    <>
      <PageHead
        title="AI 决策会议室"
        sub={selectedRound
          ? `${selectedRound.sharedDecisionRoundId ? "本卡公共决策轮" : "决策轮"} ${selectedRound.decisionRoundId} · ${selectedRound.strategyName} · ${selectedRound.symbol}`
          : "读取真实决策轮；没有记录时不会显示演示会议"}
        actions={
          <>
            <button className={styles.soft} onClick={() => window.location.assign("/trading-hall")}>返回交易大厅</button>
            <button
              className={styles.soft}
              onClick={() => setAuditOpen((open) => !open)}
              aria-expanded={auditOpen}
              disabled={!selectedRound}
            >
              {auditOpen ? "收起审计记录" : "查看审计记录"}
            </button>
          </>
        }
      />
      <div className={styles.meetingLoadState} aria-live="polite">
        {loading && !data && <span>正在读取决策轮…</span>}
        {error && <span role="alert">{error} <button type="button" onClick={retry}>重试</button></span>}
        {!loading && !error && data?.decisionRounds.length === 0 && <span>当前没有可展示的决策轮。</span>}
      </div>
      {data && data.decisionRounds.length > 1 && (
        <label className={styles.roundPicker}>
          选择决策轮
          <select value={selectedRound?.decisionRoundId || ""} onChange={(event) => setSelectedRoundId(event.target.value)}>
            {data.decisionRounds.map((round) => (
              <option key={round.decisionRoundId} value={round.decisionRoundId}>
                {round.strategyName} · {round.symbol} · {round.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedRound && (
        <div className={styles.meetingGrid}>
          <section className={styles.roundtable} aria-label="七智能体决策顺序">
            <div className={styles.tableCore}>
              <b>{selectedRound.symbol.replace("USDT", "")}</b>
              <span>{selectedRound.status}</span>
            </div>
            {tradingHallAgentCatalog.map((agent, index) => {
              const event = eventFor(agent.key);
              return (
                <div className={styles.seat} data-seat={index} key={agent.key}>
                  <i>{agent.sequence}</i>
                  <b>{agent.name}</b>
                  <small>{event ? "已记录" : "缺少记录"}</small>
                </div>
              );
            })}
          </section>
          <section className={styles.transcript}>
            <h3>
              七阶段公开记录 <span>{selectedRound.completeness.toUpperCase()}</span>
            </h3>
            {tradingHallAgentCatalog.map((agent) => {
              const event = eventFor(agent.key);
              return (
                <div className={styles.line} key={agent.key}>
                  <i className={event ? undefined : styles.warn} />
                  <div>
                    <b>
                      {agent.sequence}. {agent.name}{" "}
                      {event && <time>{new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>}
                    </b>
                    <p>{event?.conclusion || "本阶段没有公开记录；系统不会用静态结论补齐。"}</p>
                  </div>
                </div>
              );
            })}
          </section>
        </div>
      )}
      {auditOpen && selectedRound && (
        <section className={styles.auditPanel}>
          <header>
            <div>
              <small>AUDIT TRAIL</small>
              <h3>会议审计详情</h3>
            </div>
            <span>已记录 {selectedRound.events.length} 项</span>
          </header>
          <div className={styles.auditGrid}>
            <div>
              <b>会议时间</b>
              <span>{selectedRound.updatedAt ? new Date(selectedRound.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</span>
            </div>
            <div>
              <b>记录完整性</b>
              <span>{selectedRound.completeness}</span>
            </div>
            <div>
              <b>参与 Agent</b>
              <span>{selectedRound.events.filter((event) => event.role !== "legacy_audit").length} / 7 个阶段</span>
            </div>
            <div>
              <b>执行环境</b>
              <span>{selectedRound.executionMode} · 真实订单关闭</span>
            </div>
          </div>
          <ol>
            {selectedRound.events.map((event) => (
              <li key={`${event.sequence}-${event.role}`}>
                <b>{event.sequence}. {event.outputName}</b>
                <span>{event.conclusion}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {selectedRound && (
        <section className={styles.finalCard}>
          <div>
            <small>最终决策</small>
            <h2>{finalDecision?.conclusion || "该旧周期缺少独立 AI 最终决策记录"}</h2>
          </div>
          <dl>
            <div>
              <dt>决策状态</dt>
              <dd>{selectedRound.status}</dd>
            </div>
            <div>
              <dt>阶段完整性</dt>
              <dd>{selectedRound.completeness}</dd>
            </div>
            <div>
              <dt>执行环境</dt>
              <dd>{selectedRound.executionMode}</dd>
            </div>
            <div>
              <dt>真实订单</dt>
              <dd className={styles.green}>关闭</dd>
            </div>
          </dl>
          <p>硬风控优先于任何 Agent 意见。影子/模拟订单意图不代表客户交易所真实成交。</p>
        </section>
      )}
    </>
  );
}
