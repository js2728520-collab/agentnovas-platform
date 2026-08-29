"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type Brief = { date: string; month: string; summary: { customers: number; collections: number; stopped: number; expiring: number; openTrades: number; targetMissing: number } };
type StaffTarget = { userId: string; email: string; role: string; assigned: boolean; actual: Record<string, number>; goals: Record<string, number>; overallProgress: number; rank: number; note: string };
type TargetPayload = { month: string; canAssign: boolean; timeProgress: number; summary: Record<string, number>; alerts: { userId: string; email: string; type: "target_missing" | "behind_schedule"; message: string }[]; staff: StaffTarget[] };
type FollowUp = { id: string; subjectUserId: string; subjectEmail: string; alertType: string; status: string; note: string; handledAt: string | null };

export function TeamWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [selectedStaff, setSelectedStaff] = useState("");
  const [goals, setGoals] = useState({ newCustomersTarget: "0", monthlyCardsTarget: "0", quarterlyCardsTarget: "0", annualCardsTarget: "0", note: "" });
  const [followUpNotes, setFollowUpNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const brief = useApiData<Brief>("/api/team/daily-brief", t("团队日报读取失败"));
  const targets = useApiData<TargetPayload>(`/api/team/monthly-targets?month=${month}`, t("月度目标读取失败"));
  const followUps = useApiData<{ followUps: FollowUp[] }>(`/api/team/monthly-targets/follow-up?month=${month}`, t("跟进记录读取失败"));
  const selected = useMemo(() => targets.data?.staff.find((staff) => staff.userId === selectedStaff) ?? null, [selectedStaff, targets.data]);

  async function mutate(endpoint: string, body: Record<string, unknown>, success: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, success));
      setMessage(t(success));
      await Promise.all([brief.refresh(), targets.refresh(), followUps.refresh()]);
    } catch (error) { setMessage(error instanceof Error ? error.message : t("团队操作失败")); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="TEAM OPERATIONS" title={t("团队日报与月度目标")} description={t("所有汇总、目标和跟进记录均限定在当前 RBAC 数据范围；导出内容使用脱敏成员标识。")} actions={<label>{t("月份")}<input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setSelectedStaff(""); }} /></label>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel"><header><div><small>DAILY BRIEF</small><h2>{t("今日运营简报")}</h2></div>{canManage ? <button className="rc-button" disabled={busy} type="button" onClick={() => void mutate("/api/team/daily-brief", {}, "日报已生成")}>{t("生成今日通知")}</button> : null}</header>{brief.loading && !brief.data ? <LoadingState /> : brief.error && !brief.data ? <ErrorState message={brief.error} retry={brief.refresh} /> : brief.data ? <div className="rc-metric-grid"><article><small>{t("可见客户")}</small><strong>{brief.data.summary.customers}</strong></article><article><small>{t("待收款/宽限")}</small><strong>{brief.data.summary.collections}</strong></article><article><small>{t("已停止新交易")}</small><strong>{brief.data.summary.stopped}</strong></article><article><small>{t("7 日内到期")}</small><strong>{brief.data.summary.expiring}</strong></article><article><small>{t("未平模拟仓位")}</small><strong>{brief.data.summary.openTrades}</strong></article><article><small>{t("未设目标")}</small><strong>{brief.data.summary.targetMissing}</strong></article></div> : null}</section>
    <section className="rc-panel"><header><div><small>MONTHLY TARGETS</small><h2>{month} {t("目标进度")}</h2></div><a className="rc-button" href={`/api/team/monthly-targets/export?month=${month}`}>{t("导出脱敏 CSV")}</a></header>{targets.loading && !targets.data ? <LoadingState /> : targets.error && !targets.data ? <ErrorState message={targets.error} retry={targets.refresh} /> : !targets.data?.staff.length ? <EmptyState title={t("没有可见团队成员")} description={t("确认组织汇报关系和当前授权范围。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("排名")}</th><th>{t("成员")}</th><th>{t("综合完成")}</th><th>{t("新增客户")}</th><th>{t("月/季/年卡")}</th><th>{t("目标")}</th></tr></thead><tbody>{targets.data.staff.map((staff) => <tr key={staff.userId}><td>{staff.rank}</td><td><b>{staff.email}</b><small>{staff.role}</small></td><td><StatusBadge value={`${staff.overallProgress}%`} /></td><td>{staff.actual.newCustomers}/{staff.goals.newCustomers}</td><td>{staff.actual.monthlyCards}/{staff.goals.monthlyCards} · {staff.actual.quarterlyCards}/{staff.goals.quarterlyCards} · {staff.actual.annualCards}/{staff.goals.annualCards}</td><td>{canManage && targets.data?.canAssign ? <button className="rc-button" type="button" onClick={() => { setSelectedStaff(staff.userId); setGoals({ newCustomersTarget: String(staff.goals.newCustomers), monthlyCardsTarget: String(staff.goals.monthlyCards), quarterlyCardsTarget: String(staff.goals.quarterlyCards), annualCardsTarget: String(staff.goals.annualCards), note: staff.note }); }}>{t("设置目标")}</button> : staff.assigned ? t("已设置") : t("未设置")}</td></tr>)}</tbody></table></div>}</section>
    {selected ? <section className="rc-panel rc-detail-panel"><header><div><small>{selected.email}</small><h2>{t("设置月度目标")}</h2></div><button className="rc-button" type="button" onClick={() => setSelectedStaff("")}>{t("关闭")}</button></header><div className="rc-form rc-form-grid"><label>{t("新增客户")}<input type="number" min="0" max="100000" value={goals.newCustomersTarget} onChange={(event) => setGoals((current) => ({ ...current, newCustomersTarget: event.target.value }))} /></label><label>{t("月卡")}<input type="number" min="0" max="100000" value={goals.monthlyCardsTarget} onChange={(event) => setGoals((current) => ({ ...current, monthlyCardsTarget: event.target.value }))} /></label><label>{t("季卡")}<input type="number" min="0" max="100000" value={goals.quarterlyCardsTarget} onChange={(event) => setGoals((current) => ({ ...current, quarterlyCardsTarget: event.target.value }))} /></label><label>{t("年卡")}<input type="number" min="0" max="100000" value={goals.annualCardsTarget} onChange={(event) => setGoals((current) => ({ ...current, annualCardsTarget: event.target.value }))} /></label><label className="rc-wide-field">{t("说明")}<textarea rows={3} maxLength={500} value={goals.note} onChange={(event) => setGoals((current) => ({ ...current, note: event.target.value }))} /></label><div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy} onClick={() => void mutate("/api/team/monthly-targets", { month, assigneeUserId: selected.userId, ...Object.fromEntries(Object.entries(goals).map(([key, value]) => [key, key === "note" ? value : Number(value)])) }, "月度目标已保存")}>{t("保存目标")}</button></div></div></section> : null}
    <section className="rc-panel"><header><div><small>FOLLOW UPS</small><h2>{t("异常跟进")}</h2></div></header>{!targets.data?.alerts.length ? <EmptyState title={t("没有待跟进异常")} description={t("当前完成进度与目标配置没有触发未处理告警。")} /> : <div className="rc-card-grid">{targets.data.alerts.map((alert) => <article className="rc-card" key={`${alert.userId}:${alert.type}`}><header><StatusBadge value={alert.type} /></header><h3>{alert.email}</h3><p>{locale === "zh-CN" ? alert.message : alert.type === "target_missing" ? "No monthly target has been set" : `Overall completion ${targets.data?.staff.find((staff) => staff.userId === alert.userId)?.overallProgress ?? 0}% is below elapsed-time progress ${targets.data?.timeProgress ?? 0}%`}</p>{canManage ? <><label>{t("处理记录")}<textarea rows={2} maxLength={500} value={followUpNotes[`${alert.userId}:${alert.type}`] ?? ""} onChange={(event) => setFollowUpNotes((current) => ({ ...current, [`${alert.userId}:${alert.type}`]: event.target.value }))} /></label><button className="rc-button" type="button" disabled={busy || !(followUpNotes[`${alert.userId}:${alert.type}`] ?? "").trim()} onClick={() => void mutate("/api/team/monthly-targets/follow-up", { month, subjectUserId: alert.userId, alertType: alert.type, note: followUpNotes[`${alert.userId}:${alert.type}`] }, "跟进事项已处理")}>{t("记录已处理")}</button></> : null}</article>)}</div>}</section>
    <section className="rc-panel"><header><div><small>FOLLOW-UP HISTORY</small><h2>{t("跟进记录")}</h2></div></header>{followUps.loading && !followUps.data ? <LoadingState /> : followUps.error && !followUps.data ? <ErrorState message={followUps.error} retry={followUps.refresh} /> : !followUps.data?.followUps.length ? <EmptyState title={t("暂无跟进记录")} description={t("已处理记录会在这里留档。")} /> : <div className="rc-timeline">{followUps.data.followUps.map((item) => <article key={item.id}><header><b>{item.subjectEmail}</b><time>{formatDateTime(item.handledAt, locale)}</time></header><p>{item.note}</p><StatusBadge value={item.status} /></article>)}</div>}</section>
  </>;
}
