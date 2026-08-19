"use client";

import { useCallback, useEffect, useState } from "react";

import { SystemLlmConfigPanel } from "./llm-config";
import MarketNewsSettings from "./market-news-settings";

type Section = "system" | "features" | "billing" | "integrations" | "security";
type Tone = "ok" | "muted" | "warn";
type ClientSettings = {
  system: { siteName: string; primaryDomain: string; supportEmail: string; copyrightOwner: string; defaultLocale: string; supportedLocales: string[]; maintenanceBanner: string };
  features: { marketCenter: boolean; newsCenter: boolean; agentAssistant: boolean; strategyMarketplace: boolean; strategyStudio: boolean; tradingCenter: boolean; membershipCenter: boolean; notificationCenter: boolean; inviteRegistration: boolean; autoTrading: boolean; releaseChannel: string; minimumClientVersion: string };
  billing: { settlementCurrency: string; pointsPerUsdt: number; couponsEnabled: boolean; refundsEnabled: boolean; commissionSettlementDay: number };
  integrations: { primaryMarketSource: string; newsRssUrls: string[]; newsRefreshSeconds: number; marketRequestTimeoutMs: number };
  security: { maxActiveSessions: number; passwordMinLength: number; requireEmailVerification: boolean; loginIpAudit: boolean; rateLimitEnabled: boolean; emergencyStop: boolean; adminIpAllowlist: string[]; blockedIpList: string[] };
};

const localeNames: Record<string, string> = { "zh-CN": "简体中文", "zh-TW": "繁體中文", "en-US": "English", "ja-JP": "日本語", "ko-KR": "한국어", "es-ES": "Español", "ru-RU": "Русский" };
const allLocales = Object.keys(localeNames);
const marketSources = ["COINBASE", "BINANCE", "OKX", "BYBIT", "BITGET", "GATE.IO", "KUCOIN", "KRAKEN"];

const defaults: ClientSettings = {
  system: { siteName: "AgentNovas", primaryDomain: "www.tzxsea.com", supportEmail: "support@agentnovas.com", copyrightOwner: "AgentNovas", defaultLocale: "zh-CN", supportedLocales: allLocales, maintenanceBanner: "" },
  features: { marketCenter: true, newsCenter: true, agentAssistant: true, strategyMarketplace: true, strategyStudio: true, tradingCenter: true, membershipCenter: true, notificationCenter: true, inviteRegistration: true, autoTrading: false, releaseChannel: "stable", minimumClientVersion: "1.0.0" },
  billing: { settlementCurrency: "USDT", pointsPerUsdt: 1, couponsEnabled: false, refundsEnabled: false, commissionSettlementDay: 5 },
  integrations: { primaryMarketSource: "BINANCE", newsRssUrls: ["https://www.coindesk.com/arc/outboundfeeds/rss/", "https://cointelegraph.com/rss"], newsRefreshSeconds: 60, marketRequestTimeoutMs: 6000 },
  security: { maxActiveSessions: 3, passwordMinLength: 10, requireEmailVerification: false, loginIpAudit: true, rateLimitEnabled: true, emergencyStop: false, adminIpAllowlist: [], blockedIpList: [] },
};

function Badge({ children, tone = "ok" }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`maintenance-status is-${tone}`}><i />{children}</span>;
}

function useSettings<S extends Section>(section: S) {
  const [value, setValue] = useState<ClientSettings[S]>(defaults[section]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/platform-settings", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || "读取配置失败"));
      if (data.settings?.[section]) setValue({ ...defaults[section], ...data.settings[section] });
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "读取配置失败"); } finally { setLoading(false); }
  }, [section]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/platform-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ section, value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || "保存失败"));
      setValue(data.value || value);
      setMessage("配置已保存并写入审计日志");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setSaving(false); }
  };
  return { value, setValue, loading, saving, message, load, save };
}

function SaveBar({ loading, saving, message, onSave, onReload }: { loading: boolean; saving: boolean; message: string; onSave: () => void; onReload: () => void }) {
  return <div className="maintenance-form-actions"><span className={message && !message.includes("已保存") ? "is-error" : ""}>{loading ? "正在读取服务端配置…" : message || "修改后保存才会生效"}</span><div><button className="soft" onClick={onReload} disabled={loading || saving}>重新读取</button><button className="primary" onClick={onSave} disabled={loading || saving}>{saving ? "保存中…" : "保存配置"}</button></div></div>;
}

export function MaintenanceSystemPanel() {
  const state = useSettings("system");
  const value = state.value;
  const update = (patch: Partial<typeof value>) => state.setValue({ ...value, ...patch });
  const toggleLocale = (locale: string) => update({ supportedLocales: value.supportedLocales.includes(locale) ? value.supportedLocales.filter((item) => item !== locale) : [...value.supportedLocales, locale] });
  return <div className="maintenance-content-grid">
    <section className="maintenance-panel maintenance-panel-wide"><header><div><span className="eyebrow">SYSTEM CONFIGURATION</span><h2>品牌、站点与多语言</h2><p>名称、域名、默认语言及公告统一保存到服务端，所有变更保留管理员审计记录。</p></div><Badge>服务端配置</Badge></header>
      <div className="maintenance-field-grid"><label><span>平台名称</span><input value={value.siteName} onChange={(event) => update({ siteName: event.target.value })} /></label><label><span>主站域名</span><input value={value.primaryDomain} onChange={(event) => update({ primaryDomain: event.target.value })} /></label><label><span>客服邮箱</span><input value={value.supportEmail} onChange={(event) => update({ supportEmail: event.target.value })} /></label><label><span>版权主体</span><input value={value.copyrightOwner} onChange={(event) => update({ copyrightOwner: event.target.value })} /></label><label><span>默认语言</span><select value={value.defaultLocale} onChange={(event) => update({ defaultLocale: event.target.value })}>{allLocales.map((locale) => <option value={locale} key={locale}>{localeNames[locale]}</option>)}</select></label></div>
      <div className="maintenance-announcement-editor">
        <div className="maintenance-announcement-head"><div><b>维护公告</b><span>保存后显示在网站顶部，可用于维护提醒、服务升级和临时通知。</span></div><em>{value.maintenanceBanner.length}/240</em></div>
        <textarea aria-label="维护公告内容" maxLength={240} value={value.maintenanceBanner} onChange={(event) => update({ maintenanceBanner: event.target.value })} placeholder="例如：系统将于今晚 23:00–23:30 进行升级维护，期间部分功能可能短暂不可用。留空则不显示公告。" />
        <div className="maintenance-announcement-actions"><span>下方和右侧预览会同步显示当前内容</span><button type="button" className="soft" disabled={!value.maintenanceBanner} onClick={() => update({ maintenanceBanner: "" })}>清空公告</button></div>
        <div className="maintenance-announcement-inline-preview"><span>网站顶部公告预览</span><strong>{value.maintenanceBanner || "填写公告后，这里会显示实际公告样式；留空则不显示。"}</strong></div>
      </div>
      <div className="maintenance-control-group"><b>启用语言</b><div className="maintenance-language-grid">{allLocales.map((locale) => <label key={locale}><input type="checkbox" checked={value.supportedLocales.includes(locale)} onChange={() => toggleLocale(locale)} /><span>{localeNames[locale]}<small>{locale}</small></span></label>)}</div></div>
      <SaveBar loading={state.loading} saving={state.saving} message={state.message} onSave={() => void state.save()} onReload={() => void state.load()} />
    </section>
    <section className="maintenance-panel"><header><div><span className="eyebrow">LIVE PREVIEW</span><h2>配置预览</h2></div><Badge tone="muted">编辑中预览</Badge></header><div className="maintenance-brand-preview"><i>A</i><div><b>{value.siteName || "AgentNovas"}</b><span>{value.primaryDomain || "未配置域名"}</span><small>{value.maintenanceBanner || "当前没有维护公告"}</small></div></div><div className="maintenance-preview-location"><b>显示位置</b><span>用户网站顶部，紧接导航栏下方；保存后刷新页面即可看到。</span></div><dl className="maintenance-definition-list"><div><dt>默认语言</dt><dd>{localeNames[value.defaultLocale] || value.defaultLocale}</dd></div><div><dt>启用语言数</dt><dd>{value.supportedLocales.length} 种</dd></div><div><dt>支持联系</dt><dd>{value.supportEmail}</dd></div></dl></section>
  </div>;
}

export function MaintenanceFeaturePanel() {
  const state = useSettings("features");
  const value = state.value;
  const update = (patch: Partial<typeof value>) => state.setValue({ ...value, ...patch });
  const rows: Array<[keyof typeof value, string, string, boolean]> = [
    ["marketCenter", "行情中心", "实时行情、K 线和多市场数据", true], ["newsCenter", "新闻与事件", "RSS 新闻源及事件聚合", true], ["agentAssistant", "Agent 对话", "AI 咨询与团队协作", true], ["strategyMarketplace", "策略广场", "平台策略与用户策略市场", true], ["strategyStudio", "AI 策略生成", "用户策略创建、回测与提交审核", true], ["tradingCenter", "交易中心", "交易所连接、持仓与执行", true], ["membershipCenter", "会员中心", "套餐、续费和权益", true], ["notificationCenter", "通知中心", "站内、邮件和第三方通知", true], ["inviteRegistration", "邀请码注册", "允许客户通过邀请链接注册", true], ["autoTrading", "自动交易执行", "生产自动下单总开关", false],
  ];
  return <section className="maintenance-panel"><header><div><span className="eyebrow">FEATURE FLAGS</span><h2>功能模块开关</h2><p>常规模块控制前端入口；邀请码注册和自动交易同时由服务端阻止。自动交易默认关闭，开启前仍需验证执行环境。</p></div><Badge tone={value.releaseChannel === "maintenance" ? "warn" : "ok"}>{value.releaseChannel === "stable" ? "稳定通道" : value.releaseChannel === "beta" ? "测试通道" : "维护模式"}</Badge></header>
    <div className="maintenance-toggle-grid">{rows.map(([key, name, description, safe]) => <label className="maintenance-toggle-card" key={String(key)}><span className="maintenance-feature-dot" data-enabled={Boolean(value[key])} /><span><b>{name}</b><small>{description}</small></span><input type="checkbox" checked={Boolean(value[key])} onChange={(event) => update({ [key]: event.target.checked } as Partial<typeof value>)} /><em>{safe ? "可即时配置" : "高风险开关"}</em></label>)}</div>
    <div className="maintenance-field-grid maintenance-version-fields"><label><span>发布通道</span><select value={value.releaseChannel} onChange={(event) => update({ releaseChannel: event.target.value })}><option value="stable">Stable 稳定</option><option value="beta">Beta 测试</option><option value="maintenance">Maintenance 维护</option></select></label><label><span>最低客户端版本</span><input value={value.minimumClientVersion} onChange={(event) => update({ minimumClientVersion: event.target.value })} /></label></div>
    <SaveBar loading={state.loading} saving={state.saving} message={state.message} onSave={() => void state.save()} onReload={() => void state.load()} />
  </section>;
}

export function MaintenanceAiPanel() {
  const skills = [["市场研究", "实时行情与指标解释", "已启用"], ["策略生成", "需求澄清、结构化规则与回测", "已启用"], ["风险审查", "仓位、回撤与熔断检查", "已启用"], ["执行建议", "只生成建议，真实执行受硬规则约束", "受限"]];
  return <div className="maintenance-stack"><section className="maintenance-panel"><header><div><span className="eyebrow">AI OPERATIONS</span><h2>模型路由与技能运营</h2><p>系统模型、用户自带模型、技能工具及提示词职责分开管理。系统默认模型可在下方直接更换并测试。</p></div><Badge>密钥加密</Badge></header><div className="maintenance-summary-cards"><article><small>模型优先级</small><b>用户接口 → 系统接口</b><span>个人 Key 不会覆盖平台配置</span></article><article><small>调用方式</small><b>OpenAI 兼容端点</b><span>支持 chat/completions 与 responses</span></article><article><small>审计边界</small><b>决策与执行分离</b><span>模型输出不能绕过硬风控</span></article></div><div className="maintenance-feature-list maintenance-ai-skills">{skills.map(([name, description, status]) => <div className="maintenance-feature-row" key={name}><span className="maintenance-feature-dot" data-enabled={status === "已启用"} /><div><b>{name}</b><small>{description}</small></div><Badge tone={status === "已启用" ? "ok" : "muted"}>{status}</Badge></div>)}</div></section><SystemLlmConfigPanel /><section className="maintenance-panel"><header><div><span className="eyebrow">PROMPT & TOKEN GOVERNANCE</span><h2>提示词与用量治理</h2><p>现阶段已完成系统/个人模型分流和密钥加密；提示词版本库、token 账单明细和预算告警仍需接入专用用量账本。</p></div><Badge tone="warn">待接用量账本</Badge></header><div className="maintenance-checklist"><span>✓ 模型供应商与自定义端点可更换</span><span>✓ API Key 加密保存且不回显</span><span>✓ 连接测试与超时保护</span><span>○ 提示词版本回滚、token 日/周/月统计待建设</span></div></section></div>;
}

export function MaintenanceBillingPanel() {
  const state = useSettings("billing");
  const value = state.value;
  const update = (patch: Partial<typeof value>) => state.setValue({ ...value, ...patch });
  const tiers = [["< 1,000", "20%"], ["1,000–4,999.99", "25%"], ["5,000–9,999.99", "30%"], ["10,000–19,999.99", "35%"], ["20,000–49,999.99", "40%"], ["≥ 50,000", "50%"]];
  return <div className="maintenance-stack"><section className="maintenance-panel"><header><div><span className="eyebrow">BILLING & PAYMENTS</span><h2>计费与结算参数</h2><p>可调整积分、优惠、退款和结算日；核心收入分配比例按审计后的业务规则单独展示。</p></div><Badge>账本口径</Badge></header><div className="maintenance-field-grid"><label><span>默认结算币种</span><select value={value.settlementCurrency} onChange={(event) => update({ settlementCurrency: event.target.value })}><option>USDT</option><option>USD</option></select></label><label><span>每 USDT 对应积分</span><input type="number" min="0" value={value.pointsPerUsdt} onChange={(event) => update({ pointsPerUsdt: Number(event.target.value) })} /></label><label><span>月度结算日</span><input type="number" min="1" max="28" value={value.commissionSettlementDay} onChange={(event) => update({ commissionSettlementDay: Number(event.target.value) })} /></label><label className="maintenance-inline-check"><input type="checkbox" checked={value.couponsEnabled} onChange={(event) => update({ couponsEnabled: event.target.checked })} /><span>启用优惠券</span></label><label className="maintenance-inline-check"><input type="checkbox" checked={value.refundsEnabled} onChange={(event) => update({ refundsEnabled: event.target.checked })} /><span>允许后台退款流程</span></label></div><SaveBar loading={state.loading} saving={state.saving} message={state.message} onSave={() => void state.save()} onReload={() => void state.load()} /></section>
    <section className="maintenance-panel"><header><div><span className="eyebrow">REVENUE RULES</span><h2>当前奖励分成规则</h2><p>以下比例来自服务端结算函数，用于对账与运营说明。</p></div><Badge tone="muted">代码级规则</Badge></header><div className="maintenance-rule-grid"><article><small>会员充值</small><b>总公司 60% · 分公司 40%</b><span>先扣 50%运营成本；剩余网站收益按总部20%/分公司80%</span></article><article><small>盈利分成费率</small><b>周卡20% · 季卡19% · 年卡18% · 终身16%</b><span>仅对每周正的已实现净利润收费，亏损不结转</span></article><article><small>策略广场作者分成</small><b>平台 50% · 作者 50%</b><span>仅已确认收款参与分配；自建自用策略收益归用户</span></article><article><small>总部网站收益内部</small><b>技术2.5% · 招商2.5% · 运营15%</b><span>三项合计网站可分配收入的20%</span></article></div><h3 className="maintenance-subtitle">个人代理月度阶梯</h3><div className="maintenance-tier-grid">{tiers.map(([range, rate]) => <span key={range}><small>{range} USDT</small><b>{rate}</b></span>)}</div></section>
  </div>;
}

export function MaintenanceRolesPanel() {
  const rows = [
    ["客户详情", "直客", "直属范围", "团队范围", "全分公司", "全站"], ["账户与券商", "查看", "查看", "查看", "查看", "查看"], ["交易与风控", "查询", "查看", "查看", "查看", "全局审计"], ["数据看板", "自身", "直属汇总", "团队汇总", "分公司汇总", "全站汇总"], ["邀请客户", "永久码", "永久码", "永久码", "永久码", "全局/客服码"], ["创建下级", "无", "创建员工", "创建主管", "创建经理", "创建分公司"], ["账户启停", "无", "员工", "主管/员工", "分公司人员", "全局"], ["运营审批", "提交", "提交", "提交", "最终审批", "审计查看"],
  ];
  return <div className="maintenance-stack"><section className="maintenance-panel"><header><div><span className="eyebrow">ACCESS CONTROL</span><h2>五级运营权限矩阵</h2><p>权限由服务端角色与客户归属链共同控制；界面隐藏不能替代接口授权。</p></div><Badge>服务端强制</Badge></header><div className="maintenance-permission-matrix"><div className="head"><b>功能</b><span>员工</span><span>主管</span><span>经理</span><span>分公司</span><span>总公司</span></div>{rows.map((row) => <div key={row[0]}><b>{row[0]}</b>{row.slice(1).map((value, index) => <span key={`${row[0]}-${index}`}>{value}</span>)}</div>)}</div></section><section className="maintenance-panel"><header><div><span className="eyebrow">ROLE BOUNDARIES</span><h2>职能角色与技术权限</h2></div><Badge tone="muted">最小权限</Badge></header><div className="maintenance-rule-grid"><article><small>运维账号</small><b>运维后台全部功能</b><span>独立 maintenance_admin 角色，只能使用系统配置、接口、审核、运维与安全模块</span></article><article><small>超级管理员</small><b>后台选择与运维管理</b><span>可生成运维一次性邀请码，并保留总公司管理权限</span></article><article><small>总公司客服</small><b>客户与公共池</b><span>不进入运维配置，不查看密钥</span></article><article><small>审核员</small><b>审计查看</b><span>不直接修改资金或执行配置</span></article></div></section></div>;
}

export function MaintenanceIntegrationPanel() {
  const state = useSettings("integrations");
  const value = state.value;
  const update = (patch: Partial<typeof value>) => state.setValue({ ...value, ...patch });
  return <div className="maintenance-stack"><section className="maintenance-panel"><header><div><span className="eyebrow">INTEGRATION ROUTING</span><h2>行情与新闻主路由</h2><p>可直接更换默认公开行情供应商和 RSS 新闻源。用户已连接的交易所行情优先于平台默认源。</p></div><Badge>运行时生效</Badge></header><div className="maintenance-field-grid"><label><span>默认行情供应商</span><select value={value.primaryMarketSource} onChange={(event) => update({ primaryMarketSource: event.target.value })}>{marketSources.map((source) => <option key={source}>{source}</option>)}</select></label><label><span>新闻刷新建议（秒）</span><input type="number" min="15" max="3600" value={value.newsRefreshSeconds} onChange={(event) => update({ newsRefreshSeconds: Number(event.target.value) })} /></label><label><span>行情请求超时（毫秒）</span><input type="number" min="2000" max="20000" value={value.marketRequestTimeoutMs} onChange={(event) => update({ marketRequestTimeoutMs: Number(event.target.value) })} /></label><label className="maintenance-wide-field"><span>新闻 RSS 地址（每行一个 HTTPS 地址）</span><textarea value={value.newsRssUrls.join("\n")} onChange={(event) => update({ newsRssUrls: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label></div><SaveBar loading={state.loading} saving={state.saving} message={state.message} onSave={() => void state.save()} onReload={() => void state.load()} /></section><MarketNewsSettings /></div>;
}

type Overview = { generatedAt?: string; counts?: Record<string, number>; runtimeChecks?: Record<string, boolean>; integrations?: Record<string, unknown>; recentAudit?: Array<Record<string, unknown>> };

function useOverview() {
  const [data, setData] = useState<Overview>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const response = await fetch("/api/admin/maintenance/overview", { cache: "no-store" }); const value = await response.json().catch(() => ({})); if (!response.ok) throw new Error(String(value.error || "读取运维状态失败")); setData(value); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : "读取失败"); } finally { setLoading(false); } }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  return { data, loading, message, load };
}

export function MaintenanceOperationsPanel() {
  const state = useOverview();
  const counts = state.data.counts || {};
  const checks = state.data.runtimeChecks || {};
  const audits = state.data.recentAudit || [];
  const [health, setHealth] = useState("");
  const checkHealth = async () => { setHealth("检查中…"); try { const response = await fetch("/api/health", { cache: "no-store" }); const data = await response.json().catch(() => ({})); setHealth(response.ok ? `服务正常 · ${String(data.status || "ok")}` : String(data.error || `HTTP ${response.status}`)); } catch { setHealth("健康检查失败"); } };
  const cards = [["用户账户", counts.users || 0], ["组织节点", counts.organizations || 0], ["活动会话", counts.activeSessions || 0], ["待审批", counts.pendingApprovals || 0], ["待审策略", counts.pendingStrategies || 0], ["交易记录", counts.trades || 0], ["审计日志", counts.auditLogs || 0]];
  return <div className="maintenance-stack"><section className="maintenance-panel"><header><div><span className="eyebrow">SYSTEM OPERATIONS</span><h2>系统状态与任务总览</h2><p>读取数据库、会话、审批、策略、交易和审计记录的实时统计。</p></div><button className="soft" onClick={() => void state.load()} disabled={state.loading}>{state.loading ? "刷新中…" : "刷新状态"}</button></header>{state.message && <div className="maintenance-review-empty is-error">{state.message}</div>}<div className="maintenance-ops-kpis">{cards.map(([label, value]) => <article key={String(label)}><small>{label}</small><b>{String(value)}</b></article>)}</div><div className="maintenance-runtime-grid">{[["数据库", checks.database], ["凭证加密", checks.credentialEncryption], ["自动任务密钥", checks.automationSecret], ["系统大模型", checks.systemLlm], ["紧急停止", !checks.emergencyStop]].map(([label, ok]) => <article key={String(label)}><span className="maintenance-feature-dot" data-enabled={Boolean(ok)} /><b>{label}</b><Badge tone={ok ? "ok" : "warn"}>{ok ? "正常" : label === "紧急停止" ? "已停止" : "待配置"}</Badge></article>)}</div><div className="maintenance-health-card"><div><span className="maintenance-health-icon">⌁</span><div><b>应用健康接口</b><small>{health || "尚未执行主动健康检查"}</small></div></div><button className="primary" onClick={() => void checkHealth()}>立即检查</button></div></section><section className="maintenance-panel"><header><div><span className="eyebrow">AUDIT LOG</span><h2>最近系统审计</h2><p>管理员配置、登录、客户、策略与执行事件统一留痕。</p></div><Badge>{audits.length} 条</Badge></header><div className="maintenance-audit-list">{audits.length ? audits.map((row) => <article key={String(row.id)}><div><b>{String(row.action)}</b><span>{String(row.subjectType)} · {String(row.subjectId)}</span></div><small>{String(row.createdAt)}{row.ipAddress ? ` · ${String(row.ipAddress)}` : ""}</small></article>) : <div className="maintenance-review-empty">暂无审计记录</div>}</div></section></div>;
}

export function MaintenanceSecurityPanel() {
  const state = useSettings("security");
  const value = state.value;
  const update = (patch: Partial<typeof value>) => state.setValue({ ...value, ...patch });
  return <div className="maintenance-stack"><section className={`maintenance-panel${value.emergencyStop ? " maintenance-security-alert" : ""}`}><header><div><span className="eyebrow">SECURITY CENTER</span><h2>登录、风控与网络策略</h2><p>控制会话数量、密码强度、邮箱验证、IP 审计和平台级交易紧急停止。</p></div><Badge tone={value.emergencyStop ? "warn" : "ok"}>{value.emergencyStop ? "交易已停止" : "安全策略运行中"}</Badge></header><div className="maintenance-field-grid"><label><span>每个账号最大活动会话</span><input type="number" min="1" max="10" value={value.maxActiveSessions} onChange={(event) => update({ maxActiveSessions: Number(event.target.value) })} /></label><label><span>最短密码长度</span><input type="number" min="10" max="64" value={value.passwordMinLength} onChange={(event) => update({ passwordMinLength: Number(event.target.value) })} /></label></div><div className="maintenance-security-switches"><label aria-label="强制邮箱验证"><input type="checkbox" checked={value.requireEmailVerification} onChange={(event) => update({ requireEmailVerification: event.target.checked })} /><span><b>强制邮箱验证</b><small>新注册账户验证邮箱后才能登录</small></span></label><label aria-label="记录登录 IP"><input type="checkbox" checked={value.loginIpAudit} onChange={(event) => update({ loginIpAudit: event.target.checked })} /><span><b>记录登录 IP</b><small>保存到会话和审计日志</small></span></label><label aria-label="接口频率保护"><input type="checkbox" checked={value.rateLimitEnabled} onChange={(event) => update({ rateLimitEnabled: event.target.checked })} /><span><b>接口频率保护</b><small>作为边缘限流策略的总开关</small></span></label><label aria-label="平台紧急停止交易" className="danger-switch"><input type="checkbox" checked={value.emergencyStop} onChange={(event) => update({ emergencyStop: event.target.checked })} /><span><b>平台紧急停止交易</b><small>阻止自动策略生成新开仓，现有风控状态同步显示</small></span></label></div><div className="maintenance-field-grid"><label><span>超级管理员允许 IP（每行一个；留空不限）</span><textarea value={value.adminIpAllowlist.join("\n")} onChange={(event) => update({ adminIpAllowlist: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label><label><span>禁止登录 IP（每行一个）</span><textarea value={value.blockedIpList.join("\n")} onChange={(event) => update({ blockedIpList: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label></div><div className="maintenance-readonly-note"><b>重要提醒</b><span>启用超级管理员 IP 白名单前，请先确认当前公网出口 IP；错误配置会阻止超级管理员下次登录。</span></div><SaveBar loading={state.loading} saving={state.saving} message={state.message} onSave={() => void state.save()} onReload={() => void state.load()} /></section></div>;
}
