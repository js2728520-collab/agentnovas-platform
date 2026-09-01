"use client";

/**
 * 交易大厅与 AI 决策会议室。
 *
 * 这是平台核心卖点「可解释、可审计的决策过程」最直观的两个界面：
 * 大厅按七智能体的空间位置展示每个角色的最新结论，会议室钻进单轮决策看
 * 七阶段的完整结论、模型解释与审计记录。
 *
 * 从遗留 SPA app/client-app.tsx 抽出（P4）。原来它们只能在 /workspace 里通过
 * 决策大厅和会议室现在由交易中心 Tab 与查询参数到达。
 */

import Image from "next/image";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  ClientDemoSummary,
} from "@/packages/contracts/src/commercial-beta";
import {
  tradingHallAgentCatalog,
  type TradingHallAgent,
  type TradingHallDecisionEvent,
  type TradingHallDecisionRound,
  type TradingHallPayload,
  type TradingHallStrategy,
} from "@/packages/contracts/src/trading-hall";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./decision-hall.module.css";
import {
  strategyWorkRecordCompletenessLabel,
  strategyWorkRecordEvidenceRows,
} from "./work-record-presentation";
import {
  tradingHallDemoCardStatusLabel,
  tradingHallDemoProviderStatusLabel,
  tradingHallDemoReceiptStatusLabel,
  tradingHallEnvironmentLabel,
  tradingHallExplanationStatusLabel,
  tradingHallRoundStatusLabel,
  tradingHallStrategyPresentation,
} from "./trading-hall-status";

type PollingState<T> = {
  data: T | null;
  loading: boolean;
  error: string;
  retry: () => void;
};

type BadgeTone = "neutral" | "success" | "warning" | "danger";

const hallAgentPositions = {
  market_analysis: { x: 14, y: 35 },
  technical_analysis: { x: 74, y: 35 },
  strategy_proposal: { x: 13, y: 63 },
  adversarial_review: { x: 75, y: 63 },
  risk_approval: { x: 44, y: 26 },
  execution_receipt: { x: 44, y: 74 },
} as const;

const hallAgents = tradingHallAgentCatalog.flatMap((agent) => {
  if (agent.key === "final_decision") return [];
  return [{
    key: agent.key,
    name: agent.name,
    x: hallAgentPositions[agent.key].x,
    y: hallAgentPositions[agent.key].y,
  }];
});

const emptyAgentSnapshot: TradingHallAgent[] = tradingHallAgentCatalog.map((agent) => ({
  ...agent,
  status: "waiting",
  latestConclusion: null,
  latestUpdatedAt: null,
  latestDecisionRoundId: null,
  latestSharedDecisionRoundId: null,
  latestStrategyName: null,
  latestSymbol: null,
  latestDecisionStatus: null,
  latestCompleteness: null,
  latestExplanationStatus: null,
  latestExplanation: null,
  latestEvidence: null,
  llmUsed: null,
}));

function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}

function formatTimestamp(locale: string, value: string | null, emptyLabel: string) {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return date.toLocaleString(locale, { hour12: false });
}

function compactSymbol(symbol: string | null) {
  return symbol ? symbol.replace("USDT", "") : null;
}

function agentStatusTone(status: TradingHallAgent["status"]): BadgeTone {
  if (status === "reported") return "success";
  if (status === "legacy_gap") return "warning";
  return "neutral";
}

function agentStatusLabel(status: TradingHallAgent["status"]) {
  if (status === "reported") return "已提交报告";
  if (status === "legacy_gap") return "旧周期缺少本阶段";
  return "等待记录";
}

function completenessTone(value: TradingHallDecisionRound["completeness"]): BadgeTone {
  if (value === "complete") return "success";
  if (value === "partial") return "warning";
  return "neutral";
}

function missingAgent(round: TradingHallDecisionRound) {
  const reported = new Set(round.events.map((event) => event.role));
  return tradingHallAgentCatalog.find((agent) => !reported.has(agent.key)) ?? null;
}

function evidencePreviewRows(evidence: Record<string, unknown> | null, limit = 3) {
  return strategyWorkRecordEvidenceRows(evidence ?? {}).slice(0, limit);
}

function usePollingJsonData<T>(
  url: string | null,
  fallbackError: string,
  intervalMs: number,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!url) return;

    let active = true;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`${fallbackError} (${response.status})`);
        const payload = await response.json() as T;
        if (!active) return;
        setData(payload);
        setError("");
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : fallbackError);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [fallbackError, intervalMs, refreshVersion, url]);

  return {
    data: url ? data : null,
    loading: url ? (loading || (!data && !error)) : false,
    error: url ? error : "",
    retry: () => {
      setError("");
      setLoading(true);
      setRefreshVersion((version) => version + 1);
    },
  };
}

function useTradingHallData() {
  const { t } = useAppLocale();
  return usePollingJsonData<TradingHallPayload>(
    "/api/trading-hall",
    t("交易大厅数据读取失败"),
    5_000,
  );
}

function usePlatformDemoSummary(enabled: boolean) {
  const { t } = useAppLocale();
  return usePollingJsonData<ClientDemoSummary>(
    enabled ? "/api/trading-hall/paper/platform-demo-summary" : null,
    t("读取失败"),
    15_000,
  );
}

function StrategyMonitorTicker({
  strategies = [],
  loading = false,
}: {
  strategies?: TradingHallStrategy[];
  loading?: boolean;
}) {
  const { t } = useAppLocale();
  const rows = strategies.map((strategy) => {
    const presentation = tradingHallStrategyPresentation(strategy);
    return {
      name: `${t(strategy.name)}${strategy.version ? ` · ${strategy.version}` : ""}`,
      universe: strategy.symbols.map((symbol) => symbol.replace("USDT", "")).join(" / "),
      risk: `${t("总仓位")} ≤ ${strategy.risk.maxTotalAllocationPct}%`,
      decision: strategy.latestDecisionStatus
        ? t(tradingHallRoundStatusLabel(strategy.latestDecisionStatus))
        : t("尚无决策记录"),
      state: presentation.label.startsWith("未知状态（")
        ? `${t("未知状态")} (${strategy.status})`
        : t(presentation.label),
      inactive: presentation.inactive,
    };
  });
  return (
    <section className={styles.widget} aria-label={t("三套 AI 策略服务端状态")}>
      <div className={styles.widgetHead}>
        <b>{t("三套 AI 策略服务端状态")}</b>
        <span>SERVER STATE</span>
      </div>
      <div className={styles.monitorTrack}>
        {rows.length === 0 && (
          <article className={styles.monitorEmpty}>
            <span className={styles.monitorDot} />
            <div>
              <small>{t("官方策略卡")}</small>
              <b>{loading ? t("正在读取真实策略状态") : t("当前没有策略部署记录")}</b>
            </div>
          </article>
        )}
        {rows.map((row) => (
          <article key={row.name} className={styles.monitorItem} aria-label={`${row.name}：${row.state}`}>
            <span className={styles.monitorDot} data-inactive={row.inactive || undefined} />
            <div>
              <small>{row.state}</small>
              <b>{row.name}</b>
            </div>
            <div>
              <small>{t("目标交易池")}</small>
              <b>{row.universe} · {t("USDT 现货")}</b>
            </div>
            <div>
              <small>{t("硬风险上限")}</small>
              <b>{row.risk}</b>
            </div>
            <div>
              <small>{t("最新决策")}</small>
              <b>{row.decision}</b>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentActivityPanel({ agents }: { agents: TradingHallAgent[] }) {
  const { locale, t } = useAppLocale();
  const rows = agents.length ? agents : emptyAgentSnapshot;

  return (
    <section className={styles.widget} aria-label={t("Agent 工作记录")}>
      <div className={styles.widgetHead}>
        <b>{t("Agent 工作记录")}</b>
        <span>PUBLIC EVIDENCE</span>
      </div>
      {/* jsx-a11y 不允许非交互元素带 tabIndex，而这里需要让键盘用户滚动整块记录区域。 */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={styles.dialogueViewport} tabIndex={0} role="region" aria-label={t("七角色决策对话记录")}>
        <div className={styles.agentSummaryList} role="list">
          {rows.map((agent) => {
            const evidenceRows = evidencePreviewRows(agent.latestEvidence, 3);
            const latestRound = agent.latestStrategyName && compactSymbol(agent.latestSymbol)
              ? `${t(agent.latestStrategyName)} · ${compactSymbol(agent.latestSymbol)}`
              : null;
            return (
              <article className={styles.agentSummaryCard} role="listitem" key={agent.key}>
                <div className={styles.agentSummaryHead}>
                  <div>
                    <small>{agent.sequence}. {t(agent.outputName)}</small>
                    <b>{t(agent.name)}</b>
                  </div>
                  <Badge tone={agentStatusTone(agent.status)}>{t(agentStatusLabel(agent.status))}</Badge>
                </div>
                <p className={styles.agentQuestion}>{t(agent.question)}</p>
                <p className={styles.agentConclusion}>
                  {agent.latestConclusion || t("等待完整决策记录")}
                </p>
                <dl className={styles.evidenceMeta}>
                  <div>
                    <dt>{t("决策轮")}</dt>
                    <dd>{latestRound || t("未记录")}</dd>
                  </div>
                  <div>
                    <dt>{t("决策状态")}</dt>
                    <dd>{agent.latestDecisionStatus ? t(tradingHallRoundStatusLabel(agent.latestDecisionStatus)) : t("未记录")}</dd>
                  </div>
                  <div>
                    <dt>{t("记录完整性")}</dt>
                    <dd>{agent.latestCompleteness ? t(strategyWorkRecordCompletenessLabel(agent.latestCompleteness)) : t("未记录")}</dd>
                  </div>
                  <div>
                    <dt>{t("记录于")}</dt>
                    <dd>{formatTimestamp(locale, agent.latestUpdatedAt, t("未记录"))}</dd>
                  </div>
                </dl>
                {evidenceRows.length > 0 && (
                  <dl className={styles.evidenceRows}>
                    {evidenceRows.map((row) => (
                      <div key={`${agent.key}-${row.label}`}>
                        <dt>{t(row.label)}</dt>
                        <dd>{t(row.value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <div className={styles.inlineMeta}>
                  <span>{t("模型解释")}: {t(tradingHallExplanationStatusLabel(agent.latestExplanationStatus || "not_required"))}</span>
                  <span>{agent.llmUsed ? t("公开模型解释") : t("确定性阶段")}</span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub: string;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.pageHead}>
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className={styles.pageHeadActions}>
        {actions}
      </div>
    </div>
  );
}

function DecisionStageCard({
  round,
  agent,
  event,
}: {
  round: TradingHallDecisionRound;
  agent: typeof tradingHallAgentCatalog[number];
  event: TradingHallDecisionEvent | undefined;
}) {
  const { locale, t } = useAppLocale();
  const evidenceRows = strategyWorkRecordEvidenceRows(event?.evidence ?? {}).slice(0, 8);

  return (
    <article className={styles.stageCard}>
      <div className={styles.stageHeader}>
        <div>
          <small>{agent.sequence}. {t(agent.outputName)}</small>
          <h3>{t(agent.name)}</h3>
        </div>
        <Badge tone={event ? "success" : "warning"}>
          {event ? t("已记录") : t("缺少记录")}
        </Badge>
      </div>
      <p className={styles.stageQuestion}>{t(agent.question)}</p>
      <p className={styles.stageConclusion}>
        {event?.conclusion || t("本阶段没有公开记录；系统不会用静态结论补齐。")}
      </p>
      <dl className={styles.evidenceMeta}>
        <div>
          <dt>{t("决策轮")}</dt>
          <dd>{round.decisionRoundId}</dd>
        </div>
        <div>
          <dt>{t("记录于")}</dt>
          <dd>{event ? formatTimestamp(locale, event.createdAt, t("未记录")) : t("未记录")}</dd>
        </div>
        <div>
          <dt>{t("模型解释")}</dt>
          <dd>{event ? t(tradingHallExplanationStatusLabel(event.explanationStatus)) : t("未记录")}</dd>
        </div>
        <div>
          <dt>{t("记录类型")}</dt>
          <dd>{event?.llmUsed ? t("公开模型解释") : t("确定性阶段")}</dd>
        </div>
      </dl>
      {evidenceRows.length > 0 && (
        <dl className={styles.evidenceRows}>
          {evidenceRows.map((row) => (
            <div key={`${agent.key}-${row.label}`}>
              <dt>{t(row.label)}</dt>
              <dd>{t(row.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {event?.explanation && (
        <div className={styles.explanationCard}>
          <b>{t("公开模型解释")}</b>
          <p>{event.explanation}</p>
        </div>
      )}
    </article>
  );
}

function ExecutionEvidencePanel({
  round,
  demoSummary,
  demoLoading,
  demoError,
  onRetry,
}: {
  round: TradingHallDecisionRound;
  demoSummary: ClientDemoSummary | null;
  demoLoading: boolean;
  demoError: string;
  onRetry: () => void;
}) {
  const { locale, t } = useAppLocale();
  const providerRows = demoSummary?.providers.map((provider) => ({
    ...provider,
    card: provider.cards.find((card) => card.strategyCode === round.strategyCode) ?? null,
  })) ?? [];

  return (
    <section className={styles.executionPanel}>
      <header className={styles.sectionHeader}>
        <div>
          <small>STAGE 7</small>
          <h2>{t("第七阶段执行证据")}</h2>
        </div>
        <Badge tone="neutral">{t("不连接真实订单路由")}</Badge>
      </header>
      <dl className={styles.executionGrid}>
        <div>
          <dt>{t("Paper 订单意图")}</dt>
          <dd>{round.paperExecution.orderIntentCount}</dd>
        </div>
        <div>
          <dt>{t("Paper 模拟成交回执")}</dt>
          <dd>{round.paperExecution.fillReceiptCount}</dd>
        </div>
        <div>
          <dt>{t("创建时间")}</dt>
          <dd>{formatTimestamp(locale, round.paperExecution.latestIntentAt, t("未记录"))}</dd>
        </div>
        <div>
          <dt>{t("成交时间")}</dt>
          <dd>{formatTimestamp(locale, round.paperExecution.latestFillAt, t("未记录"))}</dd>
        </div>
      </dl>
      <p className={styles.sectionNote}>
        {t("Paper 成交来自客户模拟组合；平台 Demo 只验证测试环境，不回滚也不改写客户 Paper 结果。")}
      </p>
      <div className={styles.demoPanel}>
        <div className={styles.sectionHeader}>
          <div>
            <small>PLATFORM DEMO</small>
            <h3>{t("独立 Demo 证据")}</h3>
          </div>
          {demoLoading && <span>{t("正在读取数据…")}</span>}
        </div>
        {demoError && (
          <p className={styles.inlineError} role="alert">
            {demoError}{" "}
            <button type="button" className={styles.inlineButton} onClick={onRetry}>
              {t("重试")}
            </button>
          </p>
        )}
        {!demoError && providerRows.length === 0 && !demoLoading && (
          <p className={styles.sectionNote}>{t("暂无")}</p>
        )}
        <div className={styles.demoGrid}>
          {providerRows.map((provider) => (
            <article key={provider.provider} className={styles.demoCard}>
              <div className={styles.demoCardHead}>
                <div>
                  <small>{provider.environment}</small>
                  <b>{provider.provider}</b>
                </div>
                <Badge tone={provider.status === "VERIFIED" ? "success" : provider.status === "VERIFICATION_FAILED" ? "danger" : "neutral"}>
                  {t(tradingHallDemoProviderStatusLabel(provider.status))}
                </Badge>
              </div>
              <dl className={styles.evidenceMeta}>
                <div>
                  <dt>{t("官方策略卡")}</dt>
                  <dd>{provider.card ? t(tradingHallDemoCardStatusLabel(provider.card.status)) : t("未记录")}</dd>
                </div>
                <div>
                  <dt>{t("记录于")}</dt>
                  <dd>{formatTimestamp(locale, provider.card?.lastTestedAt ?? provider.lastTestedAt, t("未记录"))}</dd>
                </div>
                <div>
                  <dt>{t("状态")}</dt>
                  <dd>{provider.card?.receiptSummary ? t(tradingHallDemoReceiptStatusLabel(provider.card.receiptSummary.status)) : t("未记录")}</dd>
                </div>
                <div>
                  <dt>{t("记录于")}</dt>
                  <dd>{formatTimestamp(locale, provider.card?.receiptSummary?.observedAt ?? null, t("未记录"))}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function DecisionHall() {
  const { t } = useAppLocale();
  const { data, loading, error, retry } = useTradingHallData();
  const agents = data?.agents ?? emptyAgentSnapshot;
  const agentLookup = useMemo(
    () => new Map(agents.map((agent) => [agent.key, agent])),
    [agents],
  );
  const finalAgent = agentLookup.get("final_decision");
  const executionModeLabel = t(tradingHallEnvironmentLabel(data?.productBoundary.currentExecutionMode));

  return (
    <>
      <PageHead
        title={t("交易大厅")}
        sub={t("七角色顺序决策链 · 三张官方策略卡 · 每 5 秒同步")}
        actions={(
          <>
            <Link className={styles.soft} href="/trading?tab=hall&view=meeting">
              {t("进入会议室")}
            </Link>
            <Link className={styles.soft} href="/trading?tab=portfolios">
              {t("风险与交易控制")}
            </Link>
          </>
        )}
      />
      <div className={styles.stats} aria-label={t("交易大厅产品边界")}>
        <span>
          <i className={styles.pulse} />
          {t("真实订单关闭")}
        </span>
        <span>
          {t("目标市场")} <b>{t("USDT 现货")}</b>
        </span>
        <span>
          {t("交易池")} <b>BTC / ETH / SOL</b>
        </span>
        <span>
          {t("当前环境")} <b>{executionModeLabel}</b>
        </span>
      </div>
      <div className={styles.loadState} aria-live="polite">
        {loading && !data && <span>{t("正在读取交易大厅真实记录…")}</span>}
        {error && (
          <span role="alert">
            {error}{" "}
            <button type="button" className={styles.inlineButton} onClick={retry}>
              {t("重试")}
            </button>
          </span>
        )}
        {!loading && !error && data && data.decisionRounds.length === 0 && (
          <span>{t("当前没有决策轮记录；系统不会用演示数据填充。")}</span>
        )}
        {data && data.legacyAuditRecords > 0 && (
          <span>
            {t("检测到")} {data.legacyAuditRecords} {t("条旧周期审计记录；旧记录缺少独立 AI 最终决策阶段，已明确标记。")}
          </span>
        )}
      </div>
      <p className={styles.illustrationNote} role="note">
        {t("角色位置仅为界面示意，不代表智能体正在运行；状态以服务端策略与决策记录为准。")}
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
            {hallAgents.map((agent) => {
              const snapshot = agentLookup.get(agent.key) ?? emptyAgentSnapshot.find((item) => item.key === agent.key)!;
              return (
                <Link
                  key={agent.key}
                  className={styles.hotspot}
                  style={{ left: `${agent.x}%`, top: `${agent.y}%` }}
                  href="/assistant"
                >
                  <span className={styles.operator} aria-hidden="true" />
                  <i />
                  <b>{t(agent.name)}</b>
                  <small>{t(agentStatusLabel(snapshot.status))}</small>
                  <span className={styles.speech}>
                    {snapshot.latestConclusion || t("等待完整决策记录")}
                    <em>•••</em>
                  </span>
                </Link>
              );
            })}
            <Link className={styles.meetingHotspot} href="/trading?tab=hall&view=meeting">
              <span>{t("AI 决策官")}</span>
              <small>{t(agentStatusLabel(finalAgent?.status || "waiting"))}</small>
              <b className={styles.meetingSpeech}>
                {finalAgent?.latestConclusion || t("等待前五阶段完成后形成最终决定")}
                <em>•••</em>
              </b>
            </Link>
          </div>
          <StrategyMonitorTicker strategies={data?.strategies || []} loading={loading} />
        </div>
        <aside className={styles.right}>
          <AgentActivityPanel agents={agents} />
        </aside>
      </div>
    </>
  );
}

export function DecisionMeeting() {
  const { locale, t } = useAppLocale();
  const [auditOpen, setAuditOpen] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState("");
  const { data, loading, error, retry } = useTradingHallData();
  const selectedRound = data?.decisionRounds.find((round) => round.decisionRoundId === selectedRoundId)
    || data?.decisionRounds[0]
    || null;
  const { data: demoSummary, loading: demoLoading, error: demoError, retry: retryDemo } = usePlatformDemoSummary(Boolean(selectedRound));
  const finalDecision = selectedRound?.events.find((event) => event.role === "final_decision");
  const gap = selectedRound ? missingAgent(selectedRound) : null;

  return (
    <>
      <PageHead
        title={t("AI 决策会议室")}
        sub={selectedRound
          ? `${t(selectedRound.sharedDecisionRoundId ? "本卡公共决策轮" : "决策轮")} ${selectedRound.decisionRoundId} · ${t(selectedRound.strategyName)} · ${compactSymbol(selectedRound.symbol)}`
          : t("读取真实决策轮；没有记录时不会显示演示会议")}
        actions={(
          <>
            <Link className={styles.soft} href="/trading?tab=hall">
              {t("返回交易决策")}
            </Link>
            <button
              type="button"
              className={styles.soft}
              onClick={() => setAuditOpen((open) => !open)}
              aria-expanded={auditOpen}
              disabled={!selectedRound}
            >
              {auditOpen ? t("收起审计记录") : t("查看审计记录")}
            </button>
          </>
        )}
      />
      <div className={styles.meetingLoadState} aria-live="polite">
        {loading && !data && <span>{t("正在读取决策轮…")}</span>}
        {error && (
          <span role="alert">
            {error}{" "}
            <button type="button" className={styles.inlineButton} onClick={retry}>
              {t("重试")}
            </button>
          </span>
        )}
        {!loading && !error && data?.decisionRounds.length === 0 && <span>{t("当前没有可展示的决策轮。")}</span>}
      </div>
      {data && data.decisionRounds.length > 1 && (
        <label className={styles.roundPicker}>
          {t("选择决策轮")}
          <select value={selectedRound?.decisionRoundId || ""} onChange={(event) => setSelectedRoundId(event.target.value)}>
            {data.decisionRounds.map((round) => (
              <option key={round.decisionRoundId} value={round.decisionRoundId}>
                {t(round.strategyName)} · {compactSymbol(round.symbol)} · {t(tradingHallRoundStatusLabel(round.status))}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedRound && (
        <>
          <section className={styles.summaryPanel}>
            <header className={styles.sectionHeader}>
              <div>
                <small>ROUND SUMMARY</small>
                <h2>{t("本轮摘要")}</h2>
              </div>
              <Badge tone={completenessTone(selectedRound.completeness)}>
                {t(strategyWorkRecordCompletenessLabel(selectedRound.completeness))}
              </Badge>
            </header>
            <dl className={styles.summaryGrid}>
              <div>
                <dt>{t("官方策略卡")}</dt>
                <dd>{t(selectedRound.strategyName)}</dd>
              </div>
              <div>
                <dt>{t("标的与周期")}</dt>
                <dd>{compactSymbol(selectedRound.symbol)}</dd>
              </div>
              <div>
                <dt>{t("决策状态")}</dt>
                <dd>{t(tradingHallRoundStatusLabel(selectedRound.status))}</dd>
              </div>
              <div>
                <dt>{t("执行环境")}</dt>
                <dd>{t(tradingHallEnvironmentLabel(selectedRound.executionMode))}</dd>
              </div>
              <div>
                <dt>{t("公共决策轮")}</dt>
                <dd>{selectedRound.sharedDecisionRoundId || t("历史客户周期")}</dd>
              </div>
              <div>
                <dt>{t("记录于")}</dt>
                <dd>{formatTimestamp(locale, selectedRound.updatedAt, t("未记录"))}</dd>
              </div>
            </dl>
            {selectedRound.sharedDecisionRoundId && (
              <p className={styles.sectionNote}>
                {t("这是该策略卡的公共决策轮，订阅同一策略卡的客户看到相同七阶段结论；客户私有数据只在 Paper 准入与成交侧生成。")}
              </p>
            )}
            {gap && (
              <p className={styles.inlineWarning}>
                {t("缺少记录")}: {t(gap.name)}. {t("历史或不完整记录可能缺少阶段事件；系统不会生成替代结论。")}
              </p>
            )}
          </section>
          <section className={styles.stageSection}>
            <header className={styles.sectionHeader}>
              <div>
                <small>SEVEN STAGES</small>
                <h2>{t("七阶段公开记录")}</h2>
              </div>
              <Badge tone={selectedRound.events.length === 7 ? "success" : "warning"}>
                {selectedRound.events.length}/7
              </Badge>
            </header>
            <div className={styles.stageGrid}>
              {tradingHallAgentCatalog.map((agent) => (
                <DecisionStageCard
                  key={agent.key}
                  round={selectedRound}
                  agent={agent}
                  event={selectedRound.events.find((event) => event.role === agent.key)}
                />
              ))}
            </div>
          </section>
          <ExecutionEvidencePanel
            round={selectedRound}
            demoSummary={demoSummary}
            demoLoading={demoLoading}
            demoError={demoError}
            onRetry={retryDemo}
          />
        </>
      )}
      {auditOpen && selectedRound && (
        <section className={styles.auditPanel}>
          <header className={styles.sectionHeader}>
            <div>
              <small>AUDIT TRAIL</small>
              <h2>{t("会议审计详情")}</h2>
            </div>
            <span>{t("已记录")} {selectedRound.events.length} {t("项")}</span>
          </header>
          <div className={styles.auditGrid}>
            <div>
              <dt>{t("公共决策轮")}</dt>
              <dd>{selectedRound.sharedDecisionRoundId || t("历史客户周期")}</dd>
            </div>
            <div>
              <dt>{t("审计关联标识")}</dt>
              <dd>{selectedRound.traceId || t("未记录")}</dd>
            </div>
            <div>
              <dt>{t("记录完整性")}</dt>
              <dd>{t(strategyWorkRecordCompletenessLabel(selectedRound.completeness))}</dd>
            </div>
            <div>
              <dt>{t("真实订单")}</dt>
              <dd>{t("关闭")}</dd>
            </div>
          </div>
          <ol className={styles.auditList}>
            {selectedRound.events.map((event) => (
              <li key={`${event.sequence}-${event.role}`}>
                <div className={styles.auditItemHead}>
                  <b>{event.sequence}. {t(event.outputName)}</b>
                  <Badge tone={event.llmUsed ? "neutral" : "success"}>
                    {event.llmUsed ? t("公开模型解释") : t("确定性阶段")}
                  </Badge>
                </div>
                <p>{event.conclusion}</p>
                <div className={styles.inlineMeta}>
                  <span>{formatTimestamp(locale, event.createdAt, t("未记录"))}</span>
                  <span>{t(tradingHallExplanationStatusLabel(event.explanationStatus))}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {selectedRound && (
        <section className={styles.finalCard}>
          <div>
            <small>{t("最终决策")}</small>
            <h2>{finalDecision?.conclusion || t("该旧周期缺少独立 AI 最终决策记录")}</h2>
          </div>
          <dl className={styles.summaryGrid}>
            <div>
              <dt>{t("决策状态")}</dt>
              <dd>{t(tradingHallRoundStatusLabel(selectedRound.status))}</dd>
            </div>
            <div>
              <dt>{t("阶段完整性")}</dt>
              <dd>{t(strategyWorkRecordCompletenessLabel(selectedRound.completeness))}</dd>
            </div>
            <div>
              <dt>{t("执行环境")}</dt>
              <dd>{t(tradingHallEnvironmentLabel(selectedRound.executionMode))}</dd>
            </div>
            <div>
              <dt>{t("真实订单")}</dt>
              <dd className={styles.green}>{t("关闭")}</dd>
            </div>
          </dl>
          <p>{t("硬风控优先于任何 Agent 意见。影子/模拟订单意图不代表客户交易所真实成交。")}</p>
        </section>
      )}
    </>
  );
}
