"use client";

import { useEffect, useMemo, useState } from "react";
import AccountSettings, { type AccountViewer } from "./account-settings";
import CommunityStrategyCenter from "./community-strategy-center";
import ConnectLive from "./connect-live";
import ExchangeLogo from "./exchange-logo";
import FollowPolicySettings from "./follow-policy-settings";
import LiveMarket from "./live-market";
import MarketNewsSettings from "./market-news-settings";
import NotificationSettingsPanel from "./notification-settings-panel";
import OrganizationRelationshipTree from "./organization-relationship-tree";
import SupportFloating from "./support-floating";
import TradingCenterV2 from "./trading-center";
import MembershipCenter from "./membership-center";
import StrategyDetail, { type StrategyDetailData } from "./strategy-detail";
import { dedupeAdjacentEnglish, scrubNonChineseText } from "./i18n-runtime";
import { getAvatarPreset } from "@/lib/avatar-presets";
import PersistentAgentChat from "./agent-chat";
import { CustomLlmButton } from "./llm-config";

const AdminWithPolicy = () => (
  <>
    <Admin />
    <FollowPolicySettings />
  </>
);

type Page =
  | "home"
  | "login"
  | "connect"
  | "trading"
  | "membership"
  | "strategies"
  | "hall"
  | "market"
  | "agent"
  | "meeting"
  | "security"
  | "admin";
const waitingAgentTalks = [
  ["市场分析师", "等待实时策略市场任务"],
  ["首席风控官", "等待风险复核数据"],
  ["审计 Agent", "等待决策链同步"],
];
type AgentAction =
  | "idle"
  | "typing"
  | "standing"
  | "stretching"
  | "waving"
  | "walking";
type HallStrategy = {
  code: string;
  name: string;
  status: string;
  version: string | null;
  openPositions: number;
  unrealizedReferenceUsdt: number;
  lastUpdatedAt: string | null;
  latestDecision?: { symbol?: string } | null;
};
function AgentDialoguePanel({ talks = [] }: { talks?: string[][] }) {
  const rows = talks.length ? talks : waitingAgentTalks;
  return (
    <section
      className="market-widget agent-dialogue-widget"
      aria-label="Agent 工作记录"
    >
      <div className="widget-head">
        <b>Agent 工作记录</b>
        <span>LIVE</span>
      </div>
      <div className="agent-dialogue-viewport">
        <div className="agent-dialogue-track">
          {[...rows, ...rows, ...rows].map((x, i) => (
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
const sidebarRoleLabels: Record<string, { zh: string; en: string }> = {
  hq_admin: { zh: "总公司超级管理员", en: "HQ Super Admin" },
  hq_support: { zh: "总公司客服", en: "HQ Support" },
  branch_admin: { zh: "分公司管理员", en: "Branch Admin" },
  manager: { zh: "经理", en: "Manager" },
  supervisor: { zh: "主管", en: "Supervisor" },
  employee: { zh: "员工", en: "Employee" },
  customer: { zh: "用户", en: "Member" },
  finance: { zh: "财务", en: "Finance" },
  auditor: { zh: "审核员", en: "Auditor" },
};
function SidebarAccount({
  viewer,
  t,
  onOpenSettings,
}: {
  viewer: AccountViewer | null;
  t: Record<string, string>;
  onOpenSettings: () => void;
}) {
  const zh = t._lang === "zh-CN" || t._lang === "zh-TW";
  const displayName =
    viewer?.nickname ||
    viewer?.username ||
    viewer?.email.split("@")[0] ||
    (zh ? "未登录" : "Not signed in");
  const role = viewer
    ? sidebarRoleLabels[viewer.role] || { zh: viewer.role, en: viewer.role }
    : { zh: "未登录", en: "Not signed in" };
  const preset = getAvatarPreset(viewer?.avatarUrl || "preset:robot");
  const avatarUrl = viewer?.avatarUrl && !preset ? viewer.avatarUrl : null;
  return (
    <button
      type="button"
      className="account account-sidebar-entry"
      onClick={onOpenSettings}
      aria-label={zh ? "打开我的设置" : "Open my settings"}
    >
      <span className="account-sidebar-avatar">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" />
        ) : (
          preset?.emoji || displayName.slice(0, 1).toUpperCase()
        )}
      </span>
      <span>
        <b>{displayName}</b>
        <small>{zh ? role.zh : role.en}</small>
      </span>
    </button>
  );
}
function RoleIcon({ index }: { index: number }) {
  const icon = index % 6;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icon === 0 && (
        <>
          <path d="M4 19V5M4 19h16" />
          <path d="m7 15 3-4 3 2 5-7" />
          <circle cx="7" cy="15" r="1" />
          <circle cx="10" cy="11" r="1" />
          <circle cx="13" cy="13" r="1" />
          <circle cx="18" cy="6" r="1" />
        </>
      )}
      {icon === 1 && (
        <>
          <circle cx="12" cy="5" r="2.2" />
          <circle cx="6" cy="16" r="2.2" />
          <circle cx="18" cy="16" r="2.2" />
          <path d="m10.7 6.8-3.4 7.3m6-7.3 3.4 7.3M8.2 16h7.6" />
        </>
      )}
      {icon === 2 && (
        <>
          <path d="M12 3 5.5 6v5.2c0 4.3 2.7 7.7 6.5 9.8 3.8-2.1 6.5-5.5 6.5-9.8V6L12 3Z" />
          <path d="m9 14 6-6m-6 0 6 6" />
        </>
      )}
      {icon === 3 && (
        <>
          <path d="M4.2 17a8 8 0 1 1 15.6 0" />
          <path d="m7.2 14-2-1m11.6 1 2-1M12 8V5" />
          <path d="m12 16 3.4-5.1" />
          <circle cx="12" cy="16" r="1.2" />
        </>
      )}
      {icon === 4 && (
        <>
          <path d="M5 7h13m0 0-3-3m3 3-3 3M19 17H6m0 0 3 3m-3-3 3-3" />
          <path d="M12 11v2" />
        </>
      )}
      {icon === 5 && (
        <>
          <path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z" />
          <path d="M9 4.2V3h6v1.2M8.5 9h7M8.5 13H12m-3.5 4 1.5 1.5 3-3" />
        </>
      )}
    </svg>
  );
}
type Lang = "zh-CN" | "zh-TW" | "en-US" | "ru-RU" | "es-ES" | "ja-JP" | "ko-KR";

const languageNames: Record<Lang, string> = {
  "en-US": "English",
  "ru-RU": "Русский",
  "es-ES": "Español",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
  "zh-CN": "中文",
  "zh-TW": "繁體中文",
};
const text: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    home: "首页",
    hall: "交易大厅",
    strategy: "策略广场",
    portfolio: "资产持仓",
    orders: "交易记录",
    trading: "交易中心",
    report: "收益报告",
    risk: "风险设置",
    security: "安全中心",
    connect: "连接交易所",
    login: "登录",
    hero: "一支为你工作的 AI 量化团队",
    sub: "多位专业 Agent 持续分析市场、生成策略、相互质疑并管理风险，在严格安全边界内执行自动交易。",
    enter: "进入交易大厅",
    demo: "查看策略方案",
    live: "7个 Agent 在线",
    market: "市场状态",
    mild: "温和趋势",
    decision: "当前决策",
    wait: "等待确认",
    guard: "安全边界正常",
    meeting: "决策会议",
    agent: "Agent 工作区",
    admin: "运营后台",
  },
  "zh-TW": {
    home: "首頁",
    hall: "交易大廳",
    strategy: "策略庫廣場",
    portfolio: "資產持倉",
    orders: "交易記錄",
    trading: "交易中心",
    report: "收益報告",
    risk: "風險設定",
    security: "安全中心",
    connect: "連接交易所",
    login: "登入",
    hero: "一支為你工作的 AI 量化團隊",
    sub: "多位專業 Agent 持續分析市場、生成策略、相互質疑並管理風險，在嚴格安全邊界內執行自動交易。",
    enter: "進入交易大廳",
    demo: "查看策略方案",
    live: "7個 Agent 在線",
    market: "市場狀態",
    mild: "溫和趨勢",
    decision: "當前決策",
    wait: "等待確認",
    guard: "安全邊界正常",
    meeting: "決策會議",
    agent: "Agent 工作區",
    admin: "營運後台",
  },
  "en-US": {
    home: "Home",
    hall: "Trading Hall",
    strategy: "AI Strategies",
    portfolio: "Portfolio",
    orders: "Orders",
    trading: "Trading Center",
    report: "Performance",
    risk: "Risk Settings",
    security: "Security",
    connect: "Connect Exchange",
    login: "Sign in",
    hero: "An AI quant team working for you",
    sub: "Specialized agents analyze markets, generate strategies, challenge each other, manage risk, and execute within strict safety limits.",
    enter: "Enter Trading Hall",
    demo: "Explore Strategies",
    live: "7 Agents online",
    market: "Market regime",
    mild: "Mild trend",
    decision: "Current decision",
    wait: "Awaiting confirmation",
    guard: "Safety limits normal",
    meeting: "Decision Meeting",
    agent: "Agent Workspace",
    admin: "Operations",
  },
  "ru-RU": {
    home: "Главная",
    hall: "Торговый зал",
    strategy: "Маркетплейс стратегий",
    portfolio: "Портфель",
    orders: "Сделки",
    report: "Результаты",
    risk: "Риски",
    security: "Безопасность",
    connect: "Подключить биржу",
    login: "Войти",
    hero: "Команда ИИ-квантов работает на вас",
    sub: "Специализированные агенты анализируют рынок, создают стратегии, спорят и управляют риском в строгих пределах безопасности.",
    enter: "Открыть торговый зал",
    demo: "Смотреть стратегии",
    live: "7 агентов онлайн",
    market: "Режим рынка",
    mild: "Умеренный тренд",
    decision: "Текущее решение",
    wait: "Ожидание подтверждения",
    guard: "Лимиты в норме",
    meeting: "Совещание",
    agent: "Рабочее место агента",
    admin: "Операции",
  },
  "es-ES": {
    home: "Inicio",
    hall: "Sala de trading",
    strategy: "Mercado de estrategias",
    portfolio: "Cartera",
    orders: "Órdenes",
    report: "Rendimiento",
    risk: "Riesgo",
    security: "Seguridad",
    connect: "Conectar exchange",
    login: "Acceder",
    hero: "Un equipo cuantitativo de IA trabajando para ti",
    sub: "Agentes especializados analizan mercados, generan estrategias, se cuestionan y gestionan el riesgo bajo límites estrictos.",
    enter: "Entrar a la sala",
    demo: "Ver estrategias",
    live: "7 agentes activos",
    market: "Régimen de mercado",
    mild: "Tendencia moderada",
    decision: "Decisión actual",
    wait: "Esperando confirmación",
    guard: "Límites normales",
    meeting: "Reunión de decisión",
    agent: "Área del agente",
    admin: "Operaciones",
  },
  "ja-JP": {
    home: "ホーム",
    hall: "トレーディングホール",
    strategy: "戦略マーケット",
    portfolio: "資産・ポジション",
    orders: "取引履歴",
    report: "運用レポート",
    risk: "リスク設定",
    security: "セキュリティ",
    connect: "取引所を接続",
    login: "ログイン",
    hero: "あなたのために働くAIクオンツチーム",
    sub: "専門Agentが市場を分析し、戦略を生成し、相互検証とリスク管理を行い、安全基準内で自動執行します。",
    enter: "ホールへ入る",
    demo: "戦略を見る",
    live: "7 Agent 稼働中",
    market: "市場状態",
    mild: "緩やかなトレンド",
    decision: "現在の判断",
    wait: "確認待ち",
    guard: "安全基準は正常",
    meeting: "意思決定会議",
    agent: "Agent ワークスペース",
    admin: "運用管理",
  },
  "ko-KR": {
    home: "홈",
    hall: "트레이딩 홀",
    strategy: "전략 마켓",
    portfolio: "자산·포지션",
    orders: "거래 기록",
    report: "수익 보고서",
    risk: "리스크 설정",
    security: "보안 센터",
    connect: "거래소 연결",
    login: "로그인",
    hero: "당신을 위해 일하는 AI 퀀트 팀",
    sub: "전문 Agent들이 시장을 분석하고 전략을 만들며 상호 검증과 위험 관리를 거쳐 안전 한도 내에서 자동 실행합니다.",
    enter: "트레이딩 홀 입장",
    demo: "전략 보기",
    live: "Agent 7명 온라인",
    market: "시장 상태",
    mild: "완만한 추세",
    decision: "현재 결정",
    wait: "확인 대기",
    guard: "안전 한도 정상",
    meeting: "의사결정 회의",
    agent: "Agent 작업 공간",
    admin: "운영 관리",
  },
};

const notificationLabels: Record<Lang, string> = {
  "zh-CN": "通知中心",
  "zh-TW": "通知中心",
  "en-US": "Notifications",
  "ru-RU": "Уведомления",
  "es-ES": "Notificaciones",
  "ja-JP": "通知センター",
  "ko-KR": "알림 센터",
};
for (const lang of Object.keys(notificationLabels) as Lang[])
  text[lang].security = notificationLabels[lang];

const extraText: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    marketNav: "行情中心",
    memberNav: "会员中心",
    settlementNav: "收益结算",
    memberOpen: "开通会员",
    tagline: "智能交易中枢",
    trust1: "API 非托管",
    trust2: "权限隔离",
    trust3: "多层风控",
    trust4: "全程审计",
    flow1: "连接交易所",
    flow1s: "资金留在你的账户",
    flow2: "选择风险偏好",
    flow2s: "设定不可突破的边界",
    flow3: "AI 团队协作",
    flow3s: "生成、质疑与审核方案",
    flow4: "自动执行管理",
    flow4s: "下单、监控、止盈止损",
    systemStatus: "实时系统状态",
    systemDesc:
      "市场分析、策略研究、反方审查、风险控制和执行审计正在同步运行。",
    watch: "观看工作现场",
    riskIndex: "AI 风险指数",
    accountStatus: "账户状态",
    teamTitle: "不是一个机器人，而是一支专业团队",
    teamSub:
      "每位 Agent 独立判断、交叉质疑，最终由风控与确定性规则共同决定是否执行。",
    working: "正在工作",
  },
  "zh-TW": {
    marketNav: "行情中心",
    memberNav: "會員中心",
    settlementNav: "收益結算",
    memberOpen: "開通會員",
    tagline: "智能交易中樞",
    trust1: "API 非託管",
    trust2: "權限隔離",
    trust3: "多層風控",
    trust4: "全程審計",
    flow1: "連接交易所",
    flow1s: "資金留在你的帳戶",
    flow2: "選擇風險偏好",
    flow2s: "設定不可突破的邊界",
    flow3: "AI 團隊協作",
    flow3s: "生成、質疑與審核方案",
    flow4: "自動執行管理",
    flow4s: "下單、監控、止盈止損",
    systemStatus: "即時系統狀態",
    systemDesc:
      "市場分析、策略研究、反方審查、風險控制與執行審計正在同步運行。",
    watch: "觀看工作現場",
    riskIndex: "AI 風險指數",
    accountStatus: "帳戶狀態",
    teamTitle: "不只是一個機器人，而是一支專業團隊",
    teamSub:
      "每位 Agent 獨立判斷並交叉質疑，最終由風控與確定性規則共同決定是否執行。",
    working: "正在工作",
  },
  "en-US": {
    marketNav: "Markets",
    memberNav: "Membership",
    settlementNav: "Settlement",
    memberOpen: "Join now",
    tagline: "Intelligent Trading Hub",
    trust1: "Non-custodial API",
    trust2: "Permission isolation",
    trust3: "Layered risk control",
    trust4: "Full audit trail",
    flow1: "Connect exchange",
    flow1s: "Funds remain in your account",
    flow2: "Choose risk profile",
    flow2s: "Set hard safety boundaries",
    flow3: "AI team collaboration",
    flow3s: "Generate, challenge and review",
    flow4: "Automated execution",
    flow4s: "Orders, monitoring and exits",
    systemStatus: "Live system status",
    systemDesc:
      "Market analysis, strategy research, adversarial review, risk control and execution audit are running together.",
    watch: "Watch the team at work",
    riskIndex: "AI risk index",
    accountStatus: "Account status",
    teamTitle: "Not one bot, but a professional team",
    teamSub:
      "Each Agent judges independently and challenges the others. Risk controls and deterministic rules decide whether execution is allowed.",
    working: "Working",
  },
  "ru-RU": {
    marketNav: "Рынки",
    memberNav: "Подписка",
    settlementNav: "Расчёты",
    memberOpen: "Оформить",
    tagline: "Интеллектуальный торговый центр",
    trust1: "API без хранения средств",
    trust2: "Изоляция прав",
    trust3: "Многоуровневый риск-контроль",
    trust4: "Полный аудит",
    flow1: "Подключить биржу",
    flow1s: "Средства остаются на счёте",
    flow2: "Выбрать профиль риска",
    flow2s: "Установить жёсткие границы",
    flow3: "Работа команды ИИ",
    flow3s: "Создание, критика и проверка",
    flow4: "Автоисполнение",
    flow4s: "Ордера, контроль и выход",
    systemStatus: "Состояние системы",
    systemDesc:
      "Анализ рынка, исследование стратегий, проверка, риск-контроль и аудит исполнения работают синхронно.",
    watch: "Смотреть работу команды",
    riskIndex: "Индекс риска ИИ",
    accountStatus: "Состояние счёта",
    teamTitle: "Не один бот, а профессиональная команда",
    teamSub:
      "Каждый агент принимает независимое решение и проверяет других; исполнение определяют риск-контроль и строгие правила.",
    working: "В работе",
  },
  "es-ES": {
    marketNav: "Mercados",
    memberNav: "Membresía",
    settlementNav: "Liquidación",
    memberOpen: "Suscribirse",
    tagline: "Centro de Trading Inteligente",
    trust1: "API sin custodia",
    trust2: "Permisos aislados",
    trust3: "Control de riesgo multicapa",
    trust4: "Auditoría completa",
    flow1: "Conectar exchange",
    flow1s: "Los fondos siguen en tu cuenta",
    flow2: "Elegir perfil de riesgo",
    flow2s: "Definir límites inviolables",
    flow3: "Colaboración del equipo IA",
    flow3s: "Generar, cuestionar y revisar",
    flow4: "Ejecución automática",
    flow4s: "Órdenes, control y salidas",
    systemStatus: "Estado del sistema",
    systemDesc:
      "El análisis, la investigación, la revisión adversarial, el riesgo y la auditoría operan de forma coordinada.",
    watch: "Ver al equipo trabajando",
    riskIndex: "Índice de riesgo IA",
    accountStatus: "Estado de la cuenta",
    teamTitle: "No es un bot, sino un equipo profesional",
    teamSub:
      "Cada Agent decide de forma independiente y cuestiona al resto; el riesgo y las reglas determinan la ejecución.",
    working: "Trabajando",
  },
  "ja-JP": {
    marketNav: "マーケット",
    memberNav: "メンバーシップ",
    settlementNav: "収益精算",
    memberOpen: "会員登録",
    tagline: "インテリジェント取引ハブ",
    trust1: "非カストディ型API",
    trust2: "権限を分離",
    trust3: "多層リスク管理",
    trust4: "完全監査",
    flow1: "取引所を接続",
    flow1s: "資金は口座に保持",
    flow2: "リスク設定",
    flow2s: "越えられない境界を設定",
    flow3: "AIチーム連携",
    flow3s: "生成・反証・審査",
    flow4: "自動執行管理",
    flow4s: "注文・監視・決済",
    systemStatus: "リアルタイム稼働状況",
    systemDesc:
      "市場分析、戦略研究、反証審査、リスク管理、執行監査が連携して稼働中です。",
    watch: "稼働現場を見る",
    riskIndex: "AIリスク指数",
    accountStatus: "口座状態",
    teamTitle: "一つのボットではなく、専門チーム",
    teamSub:
      "各Agentが独立判断し相互検証。リスク管理と確定ルールが執行可否を決定します。",
    working: "稼働中",
  },
  "ko-KR": {
    marketNav: "마켓",
    memberNav: "멤버십",
    settlementNav: "수익 정산",
    memberOpen: "회원 가입",
    tagline: "지능형 트레이딩 허브",
    trust1: "비수탁 API",
    trust2: "권한 분리",
    trust3: "다층 리스크 관리",
    trust4: "전체 감사",
    flow1: "거래소 연결",
    flow1s: "자금은 고객 계정에 유지",
    flow2: "위험 성향 선택",
    flow2s: "넘을 수 없는 한도 설정",
    flow3: "AI 팀 협업",
    flow3s: "생성·반론·검토",
    flow4: "자동 실행 관리",
    flow4s: "주문·감시·청산",
    systemStatus: "실시간 시스템 상태",
    systemDesc:
      "시장 분석, 전략 연구, 반론 검토, 위험 관리와 실행 감사가 함께 작동 중입니다.",
    watch: "작업 현장 보기",
    riskIndex: "AI 위험 지수",
    accountStatus: "계정 상태",
    teamTitle: "하나의 봇이 아닌 전문 팀",
    teamSub:
      "각 Agent가 독립적으로 판단하고 교차 검증하며, 위험 관리와 확정 규칙이 실행 여부를 결정합니다.",
    working: "작업 중",
  },
};

const landingMore: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    roles:
      "市|市场分析师|识别趋势、波动率与流动性;策|策略研究员|生成候选方案与资金分配;反|反方审查员|主动寻找漏洞与反向证据;险|首席风控官|审核仓位、杠杆与损失预算;执|交易执行员|验证授权并提交交易所订单;审|审计 Agent|对账、追踪和异常熔断",
    visibleTitle: "每一次决策，都看得见",
    visible:
      "实时协作|查看 Agent 的观点、异议、修正和最终决定。;动态风控|市场变化时自动降低仓位、杠杆或暂停策略。;完整审计|策略信号、风控批准、交易所订单和成交一一对应。",
    review: "风险复核中",
    enterHall: "进入实时交易大厅",
    safetyTitle: "AI负责适应，硬风控守住底线",
    safety:
      "非托管连接|资产始终保留在用户交易所账户。;权限隔离|交易执行与结算授权相互隔离，敏感权限由客户自主配置。;固定IP白名单|只有授权执行服务器可以使用密钥。;账户级熔断|达到日亏损或回撤限制立即停止开仓。;异常拒绝交易|数据延迟、模型超时或格式异常时不下单。;人工紧急控制|用户与管理员均可暂停、撤单或仅许平仓。",
    exchangeTitle: "连接你的交易账户",
    exchangeDesc:
      "支持八大主流交易所，先从模拟盘开始，验证稳定后再开放真实交易。",
    launch: "首发",
    access: "接入",
    planned: "规划",
    connectWays: "查看连接方式",
    faqTitle: "你可能关心的问题",
    faq: "资金会转入平台吗？|不会。资金留在用户自己的交易所账户。;AI会直接随意下单吗？|不会。所有交易必须经过独立风控和硬规则。;现在展示的收益真实吗？|当前均为演示数据，不代表真实或未来收益。;可以随时停止吗？|可以暂停开仓、仅允许平仓、撤单或停止自动交易。",
    ctaTitle: "进入AI量化团队的实时工作现场",
    ctaSub: "先体验产品流程和风险体系，再决定是否连接模拟账户。",
    browse: "浏览AI策略",
    footer: "AI量化交易平台产品原型 · 所有行情与绩效均为演示数据",
    legal: "风险披露　隐私政策　服务条款",
  },
  "zh-TW": {
    roles:
      "市|市場分析師|識別趨勢、波動率與流動性;策|策略研究員|生成候選方案與資金分配;反|反方審查員|主動尋找漏洞與反向證據;險|首席風控官|審核倉位、槓桿與損失預算;執|交易執行員|驗證授權並提交交易所訂單;審|審計 Agent|對帳、追蹤與異常熔斷",
    visibleTitle: "每一次決策，都看得見",
    visible:
      "即時協作|查看 Agent 的觀點、異議、修正與最終決定。;動態風控|市場變化時自動降低倉位、槓桿或暫停策略。;完整審計|策略訊號、風控批准、訂單與成交逐一對應。",
    review: "風險複核中",
    enterHall: "進入即時交易大廳",
    safetyTitle: "AI負責適應，硬風控守住底線",
    safety:
      "非託管連接|資產始終保留在用戶交易所帳戶。;權限隔離|交易執行與結算授權相互隔離，敏感權限由客戶自主設定。;固定IP白名單|只有授權伺服器可使用密鑰。;帳戶級熔斷|達到虧損或回撤限制立即停止開倉。;異常拒絕交易|資料延遲或模型異常時不下單。;人工緊急控制|用戶與管理員均可暫停、撤單或僅許平倉。",
    exchangeTitle: "連接你的交易帳戶",
    exchangeDesc: "支援八大主流交易所，先從模擬盤開始，穩定後再開放真實交易。",
    launch: "首發",
    access: "接入",
    planned: "規劃",
    connectWays: "查看連接方式",
    faqTitle: "你可能關心的問題",
    faq: "資金會轉入平台嗎？|不會。資金留在用戶自己的交易所帳戶。;AI會直接隨意下單嗎？|不會。所有交易必須通過獨立風控與硬規則。;現在展示的收益真實嗎？|目前均為演示資料，不代表真實或未來收益。;可以隨時停止嗎？|可以暫停開倉、僅許平倉、撤單或停止自動交易。",
    ctaTitle: "進入AI量化團隊的即時工作現場",
    ctaSub: "先體驗產品流程與風險體系，再決定是否連接模擬帳戶。",
    browse: "瀏覽AI策略",
    footer: "AI量化交易平台產品原型 · 所有行情與績效均為演示資料",
    legal: "風險披露　隱私政策　服務條款",
  },
  "en-US": {
    roles:
      "M|Market Analyst|Identifies trends, volatility and liquidity;S|Strategy Researcher|Builds candidates and capital allocation;C|Adversarial Reviewer|Finds flaws and contrary evidence;R|Chief Risk Officer|Reviews exposure, leverage and loss budgets;E|Execution Agent|Validates approval and submits orders;A|Audit Agent|Reconciliation, traceability and circuit breaking",
    visibleTitle: "Every decision is visible",
    visible:
      "Live collaboration|See Agent views, objections, revisions and final decisions.;Dynamic risk control|Reduce exposure, leverage or pause as markets change.;Complete audit|Match signals and approvals to every order and fill.",
    review: "Risk review in progress",
    enterHall: "Enter live Trading Hall",
    safetyTitle: "AI adapts. Hard controls protect the boundary.",
    safety:
      "Non-custodial connection|Assets always remain in your exchange account.;Permission isolation|Trading execution and settlement authorization are isolated; sensitive permissions remain user-controlled.;IP allowlist|Only authorized execution servers can use keys.;Account circuit breaker|Stop new positions at loss or drawdown limits.;Fail-safe rejection|No order on stale data, timeout or malformed output.;Human emergency control|Users and admins can pause, cancel or allow exits only.",
    exchangeTitle: "Connect your trading account",
    exchangeDesc:
      "Eight major exchanges supported. Start in demo mode, then enable live trading after validation.",
    launch: "Launch",
    access: "Available",
    planned: "Planned",
    connectWays: "Connection options",
    faqTitle: "Common questions",
    faq: "Will funds move to the platform?|No. Funds remain in your exchange account.;Can AI place arbitrary orders?|No. Every trade must pass independent risk controls and hard rules.;Are the returns shown real?|No. Current figures are demo data and are not future performance.;Can I stop at any time?|Yes. Pause entries, allow exits only, cancel orders or stop automation.",
    ctaTitle: "Enter the AI quant team’s live workspace",
    ctaSub:
      "Explore the workflow and risk system before connecting a demo account.",
    browse: "Browse AI strategies",
    footer:
      "AI quantitative trading product prototype · All market and performance data is illustrative",
    legal: "Risk Disclosure　Privacy　Terms",
  },
  "ru-RU": {
    roles:
      "Р|Рыночный аналитик|Тренды, волатильность и ликвидность;С|Исследователь стратегий|Сценарии и распределение капитала;О|Оппонент|Ищет ошибки и обратные доказательства;Р|Риск-директор|Позиции, плечо и лимиты убытка;И|Агент исполнения|Проверяет допуск и отправляет ордера;А|Аудит-агент|Сверка, трассировка и аварийная остановка",
    visibleTitle: "Каждое решение прозрачно",
    visible:
      "Совместная работа|Мнения, возражения, правки и итог агентов.;Динамический риск|Снижение позиции, плеча или остановка стратегии.;Полный аудит|Связь сигналов и одобрений с ордерами и сделками.",
    review: "Проверка риска",
    enterHall: "Открыть торговый зал",
    safetyTitle: "ИИ адаптируется, жёсткий контроль защищает",
    safety:
      "Без хранения средств|Активы остаются на биржевом счёте.;Изоляция прав|Исполнение сделок и расчётные полномочия разделены; чувствительные разрешения контролирует клиент.;Белый список IP|Ключи доступны только авторизованным серверам.;Стоп на уровне счёта|Новые позиции блокируются при достижении лимита.;Отказ при сбое|Нет ордера при задержке или ошибке модели.;Ручная остановка|Пользователь и администратор могут остановить работу.",
    exchangeTitle: "Подключите торговый счёт",
    exchangeDesc:
      "Поддержка восьми бирж: сначала демо, затем реальная торговля после проверки.",
    launch: "Запуск",
    access: "Доступно",
    planned: "План",
    connectWays: "Способы подключения",
    faqTitle: "Частые вопросы",
    faq: "Средства переходят платформе?|Нет, они остаются на вашем биржевом счёте.;ИИ может торговать произвольно?|Нет, каждая сделка проходит риск-контроль.;Доходность реальна?|Нет, сейчас это демонстрационные данные.;Можно остановить работу?|Да, можно запретить входы, отменить ордера или остановить автоматизацию.",
    ctaTitle: "Откройте рабочее пространство ИИ-команды",
    ctaSub: "Изучите процесс и риски перед подключением демо-счёта.",
    browse: "Стратегии ИИ",
    footer: "Прототип ИИ-платформы · Все данные демонстрационные",
    legal: "Риски　Конфиденциальность　Условия",
  },
  "es-ES": {
    roles:
      "M|Analista de mercado|Tendencias, volatilidad y liquidez;E|Investigador de estrategias|Candidatos y asignación de capital;C|Revisor adversarial|Busca fallos y evidencia contraria;R|Director de riesgo|Exposición, apalancamiento y pérdidas;E|Agente de ejecución|Valida permisos y envía órdenes;A|Agente de auditoría|Conciliación, trazabilidad y bloqueo",
    visibleTitle: "Cada decisión es visible",
    visible:
      "Colaboración en vivo|Consulta opiniones, objeciones, cambios y decisiones.;Riesgo dinámico|Reduce posición, apalancamiento o pausa estrategias.;Auditoría completa|Vincula señales y aprobaciones con órdenes y ejecuciones.",
    review: "Revisión de riesgo",
    enterHall: "Entrar a la sala en vivo",
    safetyTitle: "La IA se adapta; los controles protegen",
    safety:
      "Conexión sin custodia|Los activos permanecen en tu exchange.;Permisos aislados|La ejecución y la liquidación están separadas; el cliente controla los permisos sensibles.;Lista blanca de IP|Solo servidores autorizados usan las claves.;Cortacircuitos de cuenta|Bloquea nuevas posiciones al alcanzar límites.;Rechazo seguro|No opera con datos atrasados o errores del modelo.;Control de emergencia|Usuario y administrador pueden pausar o cancelar.",
    exchangeTitle: "Conecta tu cuenta de trading",
    exchangeDesc:
      "Compatible con ocho exchanges. Empieza en demo y activa real tras validar.",
    launch: "Inicial",
    access: "Disponible",
    planned: "Planificado",
    connectWays: "Ver conexiones",
    faqTitle: "Preguntas frecuentes",
    faq: "¿Los fondos pasan a la plataforma?|No, permanecen en tu cuenta del exchange.;¿La IA opera libremente?|No, cada operación pasa controles independientes.;¿Los rendimientos son reales?|No, son datos de demostración.;¿Puedo detenerlo?|Sí, puedes pausar entradas, cancelar órdenes o parar la automatización.",
    ctaTitle: "Entra al espacio de trabajo del equipo IA",
    ctaSub: "Conoce el flujo y el riesgo antes de conectar una cuenta demo.",
    browse: "Ver estrategias IA",
    footer: "Prototipo de trading cuantitativo IA · Datos ilustrativos",
    legal: "Riesgos　Privacidad　Términos",
  },
  "ja-JP": {
    roles:
      "市|市場アナリスト|トレンド・変動率・流動性を分析;策|戦略研究員|候補戦略と資金配分を作成;反|反証審査員|欠陥と反対証拠を探索;リ|最高リスク責任者|ポジション・レバレッジ・損失を審査;執|執行Agent|承認確認後に注文を送信;監|監査Agent|照合・追跡・異常停止",
    visibleTitle: "すべての意思決定を可視化",
    visible:
      "リアルタイム連携|Agentの見解・異議・修正・最終判断を表示。;動的リスク管理|市場変化に応じてポジションやレバレッジを削減。;完全監査|シグナル・承認・注文・約定を一対一で追跡。",
    review: "リスク審査中",
    enterHall: "リアルタイム取引ホールへ",
    safetyTitle: "AIが適応し、ハード制御が守る",
    safety:
      "非カストディ接続|資産は常に取引所口座に保持。;権限分離|取引執行と決済権限を分離し、機密権限はユーザーが管理します。;固定IP許可リスト|認可サーバーのみ鍵を使用。;口座サーキットブレーカー|損失限度到達時に新規建てを停止。;異常時は取引拒否|遅延やモデル異常時は注文しません。;緊急手動制御|ユーザーと管理者が停止・取消可能。",
    exchangeTitle: "取引口座を接続",
    exchangeDesc: "主要8取引所に対応。デモ検証後に実取引を有効化します。",
    launch: "初期",
    access: "対応",
    planned: "予定",
    connectWays: "接続方法を見る",
    faqTitle: "よくある質問",
    faq: "資金はプラットフォームへ移りますか？|いいえ、取引所口座に残ります。;AIは自由に注文しますか？|いいえ、全取引が独立リスク審査を通過します。;表示収益は実績ですか？|いいえ、現在はすべてデモデータです。;いつでも停止できますか？|はい、新規建て停止・注文取消・自動化停止が可能です。",
    ctaTitle: "AIクオンツチームの現場へ",
    ctaSub: "デモ口座接続前に製品フローとリスク体系を体験。",
    browse: "AI戦略を見る",
    footer: "AI量化取引プラットフォーム試作 · すべてデモデータ",
    legal: "リスク開示　プライバシー　利用規約",
  },
  "ko-KR": {
    roles:
      "시|시장 분석가|추세·변동성·유동성 식별;전|전략 연구원|후보 전략과 자금 배분 생성;반|반론 검토자|허점과 반대 증거 탐색;리|최고 리스크 책임자|포지션·레버리지·손실 한도 검토;실|거래 실행 Agent|권한 확인 후 주문 제출;감|감사 Agent|대사·추적·이상 차단",
    visibleTitle: "모든 의사결정을 투명하게",
    visible:
      "실시간 협업|Agent 의견·이의·수정·최종 결정을 확인합니다.;동적 위험 관리|시장 변화 시 포지션과 레버리지를 축소합니다.;완전한 감사|신호·승인·주문·체결을 일대일로 추적합니다.",
    review: "리스크 재검토 중",
    enterHall: "실시간 트레이딩 홀 입장",
    safetyTitle: "AI는 적응하고, 하드 리스크는 지킵니다",
    safety:
      "비수탁 연결|자산은 항상 거래소 계정에 보관됩니다.;권한 분리|거래 실행과 정산 권한을 분리하며 민감한 권한은 고객이 직접 관리합니다.;고정 IP 허용 목록|승인 서버만 키를 사용합니다.;계정 차단 장치|손실 한도 도달 시 신규 진입을 중지합니다.;이상 거래 거부|데이터 지연이나 모델 오류 시 주문하지 않습니다.;긴급 수동 제어|사용자와 관리자가 중지·취소할 수 있습니다.",
    exchangeTitle: "거래 계정 연결",
    exchangeDesc: "8대 거래소 지원. 데모 검증 후 실거래를 활성화합니다.",
    launch: "우선",
    access: "지원",
    planned: "예정",
    connectWays: "연결 방법 보기",
    faqTitle: "자주 묻는 질문",
    faq: "자금이 플랫폼으로 이동하나요?|아니요, 고객 거래소 계정에 남습니다.;AI가 임의로 주문하나요?|아니요, 모든 거래는 독립 위험 심사를 통과합니다.;표시 수익은 실제인가요?|아니요, 현재는 모두 데모 데이터입니다.;언제든 중지할 수 있나요?|네, 신규 진입·주문·자동 거래를 중지할 수 있습니다.",
    ctaTitle: "AI 퀀트 팀의 실시간 작업 현장",
    ctaSub: "데모 계정 연결 전에 제품 흐름과 위험 체계를 체험하세요.",
    browse: "AI 전략 보기",
    footer: "AI 퀀트 거래 플랫폼 프로토타입 · 모든 데이터는 데모입니다",
    legal: "위험 고지　개인정보　이용약관",
  },
};

const nav: [Page, string, string][] = [
  ["home", "home", "⌂"],
  ["hall", "hall", "◉"],
  ["agent", "agent", "◎"],
  ["market", "marketNav", "⌁"],
  ["strategies", "strategy", "◇"],
  ["trading", "trading", "⇄"],
  ["membership", "memberNav", "♢"],
  ["security", "security", "⊙"],
];
const membershipRenewalLabels: Record<Lang, string> = {
  "zh-CN": "会员续费",
  "zh-TW": "會員續費",
  "en-US": "Renew membership",
  "ru-RU": "Продлить подписку",
  "es-ES": "Renovar membresía",
  "ja-JP": "会員更新",
  "ko-KR": "멤버십 갱신",
};
function membershipAction(
  t: Record<string, string>,
  membership: AccountViewer["membership"],
) {
  if (
    !membership ||
    membership.planCode === "trial_monthly_equivalent" ||
    membership.status === "pending"
  )
    return { label: t.memberOpen, renewal: false };
  if (!membership.expiresAt)
    return membership.status === "active"
      ? null
      : { label: t.memberOpen, renewal: false };
  const expiresAt = Date.parse(membership.expiresAt);
  if (!Number.isFinite(expiresAt))
    return { label: t.memberOpen, renewal: false };
  return expiresAt - Date.now() <= 7 * 24 * 60 * 60 * 1000
    ? {
        label: membershipRenewalLabels[t._lang as Lang] || "Renew membership",
        renewal: true,
      }
    : null;
}

export default function Home() {
  const [page, setPage] = useState<Page>(() => {
    if (typeof window === "undefined") return "home";
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("page");
    if (requested === "market") return "market";
    if (
      requested === "login" ||
      params.has("invite") ||
      params.has("invitationCode") ||
      params.has("code") ||
      /\/(?:invite|register)\/[^/?#]+/i.test(window.location.pathname)
    )
      return "login";
    return "home";
  });
  const [lang, setLang] = useState<Lang>("zh-CN");
  const [selectedAgent, setSelectedAgent] = useState("Chief Risk Officer");
  const [viewer, setViewer] = useState<AccountViewer | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const t: Record<string, string> = useMemo(
    () =>
      Object.fromEntries(
        Object.entries({ ...text[lang], ...extraText[lang], _lang: lang }).map(
          ([key, value]) => [key, dedupeAdjacentEnglish(value)],
        ),
      ),
    [lang],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    const root = document.querySelector<HTMLElement>("[data-app-shell]");
    if (!root || lang === "zh-CN" || lang === "zh-TW") return;
    let busy = false;
    const clean = () => {
      if (busy) return;
      busy = true;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (
          parent &&
          ![
            "INPUT",
            "TEXTAREA",
            "SELECT",
            "OPTION",
            "SCRIPT",
            "STYLE",
            "CODE",
            "PRE",
          ].includes(parent.tagName)
        )
          nodes.push(node as Text);
      }
      for (const textNode of nodes) {
        const current = textNode.nodeValue || "";
        const next = scrubNonChineseText(current);
        if (next !== current) textNode.nodeValue = next;
      }
      busy = false;
    };
    clean();
    const observer = new MutationObserver(clean);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [lang]);
  useEffect(() => {
    if (lang === "zh-CN" || lang === "zh-TW") return;
    const root = document.querySelector<HTMLElement>("[data-app-shell]");
    if (!root) return;
    let busy = false;
    const cleanAttributes = () => {
      if (busy) return;
      busy = true;
      for (const element of Array.from(
        root.querySelectorAll<HTMLElement>("*"),
      )) {
        for (const attribute of ["aria-label", "placeholder", "title", "alt"]) {
          const current = element.getAttribute(attribute);
          if (!current) continue;
          const next = scrubNonChineseText(current);
          if (next !== current) element.setAttribute(attribute, next);
        }
      }
      busy = false;
    };
    cleanAttributes();
    const observer = new MutationObserver(cleanAttributes);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "placeholder", "title", "alt"],
    });
    return () => observer.disconnect();
  }, [lang]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      fetch("/api/auth/me", { cache: "no-store" })
        .then(async (response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (active) setViewer(payload?.user || null);
        })
        .catch(() => {
          if (active) setViewer(null);
        })
        .finally(() => {
          if (active) setAuthResolved(true);
        });
    refresh();
    window.addEventListener("agentnovas-auth-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("agentnovas-auth-changed", refresh);
    };
  }, [page]);
  const navigate = (p: Page) => {
    const allowPostLoginTransition = page === "login" && p === "hall";
    if (p !== "home" && p !== "login" && !viewer && !allowPostLoginTransition) {
      setPage("login");
      return;
    }
    setPage(p);
  };
  const go = (p: Page) => () => navigate(p);
  const openMembership = () => {
    navigate("membership");
    window.setTimeout(
      () =>
        document
          .getElementById("membership-payment")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };
  const memberButton = membershipAction(t, viewer?.membership);
  const visiblePage: Page = !authResolved
    ? "home"
    : page !== "home" && page !== "login" && !viewer
      ? "login"
      : page;
  return (
    <main className="app-shell" data-app-shell>
      <header className="topbar">
        <button className="logo" onClick={go("home")}>
          <span>A</span>
          <b>
            AgentNovas<small>{t.tagline}</small>
          </b>
        </button>
        <div className="top-actions">
          {memberButton && (
            <button
              className={`outline ${memberButton.renewal ? "membership-renewal" : ""}`}
              onClick={openMembership}
            >
              {memberButton.label}
            </button>
          )}
          {!viewer && (
            <button className="top-login" onClick={go("login")}>
              {t.login}
            </button>
          )}
          <select
            data-locale-static
            aria-label="Language"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
          >
            {Object.entries(languageNames).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <NotificationCenter />
          {viewer ? (
            <AccountSettings
              viewer={viewer}
              onUpdated={setViewer}
              open={accountSettingsOpen}
              onOpenChange={setAccountSettingsOpen}
              onLogout={() => {
                setAccountSettingsOpen(false);
                setViewer(null);
                setPage("home");
              }}
            />
          ) : (
            <button className="top-user-guest" onClick={go("login")}>
              用户
            </button>
          )}
        </div>
      </header>
      {visiblePage === "home" ? (
        <Landing key={lang} t={t} go={navigate} />
      ) : visiblePage === "login" ? (
        <Login key={lang} go={navigate} t={t} />
      ) : (
        <Dashboard
          key={`${visiblePage}-${lang}`}
          page={visiblePage}
          t={t}
          go={navigate}
          viewer={viewer}
          selectedAgent={selectedAgent}
          setSelectedAgent={setSelectedAgent}
          onOpenSettings={() => setAccountSettingsOpen(true)}
        />
      )}
      <SupportFloating lang={lang} />
    </main>
  );
}

function Landing({
  t,
  go,
}: {
  t: Record<string, string>;
  go: (p: Page) => void;
}) {
  const m = landingMore[t._lang as Lang];
  const roles = m.roles.split(";").map((x) => x.split("|"));
  const visible = m.visible.split(";").map((x) => x.split("|"));
  const safety = m.safety.split(";").map((x) => x.split("|"));
  const faq = m.faq.split(";").map((x) => x.split("|"));
  const riskNotice: { label: string; body: string } = {
    "zh-CN": {
      label: "风险提示",
      body: "加密资产及自动化交易具有较高风险，历史收益、回测结果和演示数据不代表未来表现。AI 输出仅供信息参考，不构成投资建议，请根据自身风险承受能力谨慎决策。",
    },
    "zh-TW": {
      label: "風險提示",
      body: "加密資產及自動化交易具有較高風險，歷史收益、回測結果與演示數據不代表未來表現。AI 輸出僅供資訊參考，不構成投資建議，請依自身風險承受能力謹慎決策。",
    },
    "en-US": {
      label: "Risk disclosure",
      body: "Crypto assets and automated trading involve substantial risk. Historical returns, backtests and demonstration data do not predict future results. AI output is informational only and is not investment advice.",
    },
    "ru-RU": {
      label: "Предупреждение о рисках",
      body: "Криптоактивы и автоматическая торговля связаны с высоким риском. Прошлая доходность, бэктесты и демонстрационные данные не гарантируют будущий результат.",
    },
    "es-ES": {
      label: "Aviso de riesgo",
      body: "Los criptoactivos y el trading automatizado implican un riesgo elevado. Los resultados históricos, backtests y datos de demostración no garantizan resultados futuros.",
    },
    "ja-JP": {
      label: "リスク開示",
      body: "暗号資産と自動取引には高いリスクがあります。過去の収益、バックテスト、デモデータは将来の結果を保証しません。",
    },
    "ko-KR": {
      label: "위험 고지",
      body: "암호자산과 자동 거래에는 높은 위험이 따릅니다. 과거 수익률, 백테스트 및 데모 데이터는 미래 결과를 보장하지 않습니다.",
    },
  }[t._lang as Lang] || {
    label: "风险提示",
    body: "加密资产及自动化交易具有较高风险，请谨慎决策。",
  };
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <i /> MULTI-AGENT QUANT SYSTEM
          </div>
          <h1>{t.hero}</h1>
          <p>{t.sub}</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => go("hall")}>
              {t.enter} →
            </button>
            <button className="ghost" onClick={() => go("strategies")}>
              {t.demo}
            </button>
          </div>
          <div className="trust">
            <span>✓ {t.trust1}</span>
            <span>✓ {t.trust2}</span>
            <span>✓ {t.trust3}</span>
            <span>✓ {t.trust4}</span>
          </div>
        </div>
        <div className="orbital">
          <div className="orbit o1">
            <i />
          </div>
          <div className="orbit o2">
            <i />
            <i />
          </div>
          <div className="core">
            AI
            <div>
              DECISION
              <br />
              CORE
            </div>
          </div>
          <div className="agent-tag a1">
            MARKET
            <br />
            <b>{t.market}</b>
          </div>
          <div className="agent-tag a2">
            RISK
            <br />
            <b>{t.risk}</b>
          </div>
          <div className="agent-tag a3">
            STRATEGY
            <br />
            <b>{t.strategy}</b>
          </div>
          <div className="agent-tag a4">
            AUDIT
            <br />
            <b>{t.report}</b>
          </div>
        </div>
      </section>
      <section className="flow">
        <div>
          <small>01</small>
          <b>{t.flow1}</b>
          <span>{t.flow1s}</span>
        </div>
        <em>→</em>
        <div>
          <small>02</small>
          <b>{t.flow2}</b>
          <span>{t.flow2s}</span>
        </div>
        <em>→</em>
        <div>
          <small>03</small>
          <b>{t.flow3}</b>
          <span>{t.flow3s}</span>
        </div>
        <em>→</em>
        <div>
          <small>04</small>
          <b>{t.flow4}</b>
          <span>{t.flow4s}</span>
        </div>
      </section>
      <section className="home-grid">
        <div className="panel">
          <label>{t.systemStatus}</label>
          <h2>{t.live}</h2>
          <p>{t.systemDesc}</p>
          <button onClick={() => go("hall")}>{t.watch} →</button>
        </div>
        <div className="panel metric-panel">
          <div>
            <small>{t.market}</small>
            <strong>{t.mild}</strong>
          </div>
          <div>
            <small>{t.riskIndex}</small>
            <strong>
              38<em>/100</em>
            </strong>
          </div>
          <div>
            <small>{t.decision}</small>
            <strong>{t.wait}</strong>
          </div>
          <div>
            <small>{t.accountStatus}</small>
            <strong className="green">{t.guard}</strong>
          </div>
        </div>
      </section>
      <section className="home-ticker">
        {[
          ["BTC", "$118,462", "+1.82%"],
          ["ETH", "$4,286", "+2.14%"],
          ["SOL", "$184.72", "-0.38%"],
          ["BNB", "$812.36", "+0.74%"],
          ["XRP", "$3.21", "+4.06%"],
        ].map((x) => (
          <button key={x[0]} onClick={() => go("market")}>
            <b>{x[0]}/USDT</b>
            <span>{x[1]}</span>
            <em className={x[2][0] === "-" ? "down" : ""}>{x[2]}</em>
          </button>
        ))}
      </section>
      <section className="landing-section">
        <div className="section-title">
          <small>AI QUANT TEAM</small>
          <h2>{t.teamTitle}</h2>
          <p>{t.teamSub}</p>
        </div>
        <div className="role-grid">
          {roles.map((x, i) => (
            <article key={x[1]}>
              <i>
                <RoleIcon index={i} />
              </i>
              <h3>{x[1]}</h3>
              <p>{x[2]}</p>
              <span>{t.working} · ●</span>
            </article>
          ))}
        </div>
      </section>
      <section className="feature-split">
        <div className="scene-preview">
          <img
            src="/trading-hall.png"
            alt="AI quantitative trading operations center"
          />
          <div>
            <span>
              <i />
              {t.live}
            </span>
            <b>{m.review}</b>
          </div>
          <button onClick={() => go("hall")}>{m.enterHall} →</button>
        </div>
        <div className="capabilities">
          <small>VISIBLE INTELLIGENCE</small>
          <h2>{m.visibleTitle}</h2>
          {visible.map((x, i) => (
            <div key={x[0]}>
              <i>0{i + 1}</i>
              <span>
                <b>{x[0]}</b>
                <p>{x[1]}</p>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="safety-section">
        <div className="section-title">
          <small>SECURITY BY DESIGN</small>
          <h2>{m.safetyTitle}</h2>
        </div>
        <div className="safety-grid">
          {safety.map((x, i) => (
            <article key={x[0]}>
              <span>0{i + 1}</span>
              <h3>{x[0]}</h3>
              <p>{x[1]}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="exchange-band">
        <div>
          <small>SUPPORTED EXCHANGES</small>
          <h2>{m.exchangeTitle}</h2>
          <p>{m.exchangeDesc}</p>
        </div>
        <div className="exchange-logos">
          {[
            "OKX",
            "BINANCE",
            "BYBIT",
            "BITGET",
            "GATE.IO",
            "KUCOIN",
            "COINBASE",
            "KRAKEN",
            "CRYPTO.COM",
            "METAMASK",
            "ROBINHOOD",
            "HTX",
          ].map((name) => (
            <div className="exchange-logo-card" key={name}>
              <ExchangeLogo name={name} />
              <b>{name}</b>
            </div>
          ))}
        </div>
        <button
          className="exchange-connect-button"
          onClick={() => go("trading")}
        >
          <span>{m.connectWays}</span>
          <i aria-hidden="true">→</i>
        </button>
      </section>
      <section className="faq">
        <div className="section-title">
          <small>COMMON QUESTIONS</small>
          <h2>{m.faqTitle}</h2>
        </div>
        {faq.map((x) => (
          <details key={x[0]}>
            <summary>
              {x[0]}
              <span>＋</span>
            </summary>
            <p>{x[1]}</p>
          </details>
        ))}
      </section>
      <section className="final-cta">
        <small>MULTI-AGENT QUANT PLATFORM</small>
        <h2>{m.ctaTitle}</h2>
        <p>{m.ctaSub}</p>
        <div>
          <button className="primary" onClick={() => go("hall")}>
            {t.enter}
          </button>
          <button className="ghost" onClick={() => go("strategies")}>
            {m.browse}
          </button>
        </div>
      </section>
      <footer>
        <div className="landing-footer-main">
          <b className="landing-footer-mark">AgentNovas</b>
          <span>{m.footer}</span>
          <div>{m.legal}</div>
        </div>
        <div className="landing-risk-notice">
          <strong>{riskNotice.label}</strong>
          <span>{riskNotice.body}</span>
        </div>
      </footer>
    </div>
  );
}

function Dashboard({
  page,
  t,
  go,
  viewer,
  selectedAgent,
  setSelectedAgent,
  onOpenSettings,
}: {
  page: Page;
  t: Record<string, string>;
  go: (p: Page) => void;
  viewer: AccountViewer | null;
  selectedAgent: string;
  setSelectedAgent: (s: string) => void;
  onOpenSettings: () => void;
}) {
  const tradingLabel =
    t._lang === "en-US"
      ? "Trading Center"
      : t._lang === "ru-RU"
        ? "Торговый центр"
        : t._lang === "es-ES"
          ? "Centro de trading"
          : t._lang === "ja-JP"
            ? "取引センター"
            : t._lang === "ko-KR"
              ? "거래 센터"
              : "交易中心";
  return (
    <div className="dash">
      <aside>
        <SidebarAccount viewer={viewer} t={t} onOpenSettings={onOpenSettings} />
        {nav.slice(1).map(([p, k, icon]) => (
          <button
            key={p}
            className={page === p ? "active" : ""}
            onClick={() => go(p)}
          >
            <i>{icon}</i>
            {p === "trading"
              ? tradingLabel
              : p === "agent"
                ? t._lang === "zh-CN" || t._lang === "zh-TW"
                  ? "Agent 对话"
                  : t.agent
                : t[k] || k}
          </button>
        ))}
        <hr />
        <button
          className={page === "admin" ? "active" : ""}
          onClick={() => go("admin")}
        >
          <i>⚙</i>
          {t.admin}
        </button>
        <div className="aside-bottom">
          <span>
            <i />
            交易系统正常
          </span>
          <small>数据延迟 86ms</small>
        </div>
      </aside>
      <section className="content">
        {renderPage(page, t, go, selectedAgent, setSelectedAgent)}
      </section>
    </div>
  );
}

function renderPage(
  page: Page,
  t: Record<string, string>,
  go: (p: Page) => void,
  selected: string,
  setSelected: (s: string) => void,
) {
  switch (page) {
    case "hall":
      return <Hall t={t} go={go} setSelected={setSelected} />;
    case "market":
      return <LiveMarket locale={t._lang} onLogin={() => go("login")} />;
    case "strategies":
      return <Strategies />;
    case "membership":
      return <MembershipCenter />;
    case "agent":
      return (
        <PersistentAgentChat
          title={
            t._lang === "zh-CN" || t._lang === "zh-TW" ? "Agent 对话" : t.agent
          }
          onOpenStrategies={() => go("strategies")}
        />
      );
    case "meeting":
      return <Meeting />;
    case "connect":
      return <ConnectLive />;
    case "trading":
      return <TradingCenterV2 go={go} />;
    case "security":
      return <Security t={t} />;
    case "admin":
      return <AdminWithPolicy />;
    default:
      return <Hall t={t} go={go} setSelected={setSelected} />;
  }
}

const agents = [
  {
    n: "市场分析师",
    s: "分析中",
    m: "4H 趋势保持上行",
    p: "72%",
    x: 14,
    y: 35,
  },
  { n: "技术分析师", s: "建模中", m: "突破确认度 64%", p: "64%", x: 74, y: 35 },
  {
    n: "策略研究员",
    s: "拟案中",
    m: "提交候选策略 V3",
    p: "54%",
    x: 13,
    y: 63,
  },
  { n: "反方审查员", s: "质疑中", m: "我发现量价背离", p: "82%", x: 75, y: 63 },
  {
    n: "首席风控官",
    s: "审核中",
    m: "建议仓位降至 3%",
    p: "38%",
    x: 44,
    y: 26,
  },
  { n: "交易执行员", s: "待命", m: "等待风控最终授权", p: "20%", x: 44, y: 74 },
];
function Hall({
  t,
  go,
  setSelected,
}: {
  t: Record<string, string>;
  go: (p: Page) => void;
  setSelected: (s: string) => void;
}) {
  const [liveTalks, setLiveTalks] = useState<string[][]>([]),
    [hallStrategies, setHallStrategies] = useState<HallStrategy[]>([]),
    [agentActions, setAgentActions] = useState<Record<string, AgentAction>>({});
  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/trading-hall", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (active) {
            if (Array.isArray(d?.agentTalks))
              setLiveTalks(
                d.agentTalks.map(
                  (x: {
                    agent: string;
                    message: string;
                    strategyName?: string;
                    explanation?: { summary?: string } | null;
                  }) => [
                    x.agent,
                    x.strategyName
                      ? `【${x.strategyName}】${x.message}${x.explanation?.summary ? `；模型解释：${x.explanation.summary}` : ""}`
                      : `${x.message}${x.explanation?.summary ? `；模型解释：${x.explanation.summary}` : ""}`,
                  ],
                ),
              );
            if (Array.isArray(d?.strategies)) setHallStrategies(d.strategies);
          }
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let actionTimer: ReturnType<typeof setTimeout> | undefined;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      actionTimer = setTimeout(
        () => {
          if (stopped) return;
          const person = agents[Math.floor(Math.random() * agents.length)];
          const roll = Math.random();
          const action: AgentAction =
            roll < 0.05
              ? "walking"
              : roll < 0.2
                ? "waving"
                : roll < 0.38
                  ? "stretching"
                  : roll < 0.56
                    ? "standing"
                    : "typing";
          setAgentActions((previous) => ({ ...previous, [person.n]: action }));
          resetTimer = setTimeout(
            () => {
              setAgentActions((previous) => ({
                ...previous,
                [person.n]: "idle",
              }));
              schedule();
            },
            action === "walking" ? 7600 : action === "typing" ? 4400 : 3000,
          );
        },
        5500 + Math.random() * 6000,
      );
    };
    schedule();
    return () => {
      stopped = true;
      if (actionTimer) clearTimeout(actionTimer);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, []);
  const talkFor = (agentName: string) =>
    liveTalks.find(([speaker]) => speaker === agentName)?.[1] ||
    "等待三台 AI 策略真实任务";
  const meetingTalk =
    liveTalks.find(([speaker]) => speaker === "策略工作流")?.[1] ||
    liveTalks[0]?.[1] ||
    "等待三台 AI 策略真实任务";
  return (
    <>
      <PageHead
        title={t.hall}
        sub="三台 AI 策略真实任务流 · 每 5 秒同步"
        actions={
          <>
            <button className="soft" onClick={() => go("meeting")}>
              进入会议室
            </button>
            <button className="danger">紧急停止</button>
          </>
        }
      />
      <div className="hall-stats">
        <span>
          <i className="pulse" />
          {t.live}
        </span>
        <span>
          BTC/USDT <b>$118,462.40</b> <em>+1.82%</em>
        </span>
        <span>
          市场风险 <b>38/100</b>
        </span>
        <span>
          交易所 <b>OKX DEMO</b>
        </span>
      </div>
      <div className="compact-hall">
        <div className="hall-left">
          <div className="scene compact">
            <img
              src="/trading-hall-base.png"
              alt="AI quantitative trading operations center"
            />
            {agents.map((a, index) => (
              <button
                key={a.n}
                className={`hotspot action-${agentActions[a.n] || "idle"} walk-path-${index % 3}`}
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                onClick={() => {
                  setSelected(a.n);
                  go("agent");
                }}
              >
                <span className="hall-operator" aria-hidden="true" />
                <i />
                <b>{a.n}</b>
                <small>{a.s}</small>
                <span className="speech">
                  {talkFor(a.n)}
                  <em>•••</em>
                </span>
              </button>
            ))}
            <button className="meeting-hotspot" onClick={() => go("meeting")}>
              <span>AI 决策官</span>
              <small>正在发言</small>
              <b className="meeting-speech">
                {meetingTalk}
                <em>•••</em>
              </b>
            </button>
          </div>
          <StrategyMonitorTicker strategies={hallStrategies} />
        </div>
        <aside className="hall-right">
          <AgentDialoguePanel talks={liveTalks} />
        </aside>
      </div>
    </>
  );
}

function StrategyMonitorTicker({
  strategies = [],
}: {
  strategies?: HallStrategy[];
}) {
  const fallback = [
      ["AI 稳健型 · V2", "ETH 现货 · 2.0%", "+$12.48", "等待复核"],
      ["AI 平衡型 · V3", "BTC 多 · 3.0%", "+$36.92", "等待复核"],
      ["AI 激进型 · V2", "SOL 多 · 4.5%", "-$8.16", "等待复核"],
    ],
    rows =
      strategies.length === 3
        ? strategies.map((x) => [
            `${x.name}${x.version ? ` · ${x.version}` : ""}`,
            `${x.latestDecision?.symbol || "暂无持仓"} · ${x.openPositions} 笔`,
            `${x.unrealizedReferenceUsdt >= 0 ? "+" : ""}$${x.unrealizedReferenceUsdt.toFixed(2)}`,
            x.lastUpdatedAt
              ? new Date(x.lastUpdatedAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "等待复核",
          ])
        : fallback;
  return (
    <div className="strategy-monitor-ticker" aria-label="三套AI策略实时监控">
      <div className="strategy-monitor-track">
        {rows.map((x, i) => (
          <article key={x[0]}>
            <span className={`strategy-monitor-dot s${i}`} />
            <div>
              <small>运行策略</small>
              <b>{x[0]}</b>
            </div>
            <div>
              <small>当前仓位</small>
              <b>{x[1]}</b>
            </div>
            <div>
              <small>未实现盈亏</small>
              <b className={x[2][0] === "-" ? "down" : "green"}>{x[2]}</b>
            </div>
            <div>
              <small>最新复核</small>
              <b>{x[3]}</b>
            </div>
          </article>
        ))}
      </div>
      <div className="strategy-monitor-pages">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
function PageHead({
  title,
  sub,
  actions,
  className,
}: {
  title: string;
  sub: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-head${className ? ` ${className}` : ""}`}>
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div>
        {title === "会员中心" && <CustomLlmButton />}
        {actions}
      </div>
    </div>
  );
}
function Strategies() {
  const [mine, setMine] = useState(false),
    [detail, setDetail] = useState<StrategyDetailData | null>(null),
    [createRequest, setCreateRequest] = useState(0);
  if (detail)
    return <StrategyDetail strategy={detail} onBack={() => setDetail(null)} />;
  const toggleMine = () => {
    if (mine) {
      setMine(false);
      setCreateRequest(0);
    } else setMine(true);
  };
  return (
    <>
      <PageHead
        className={mine ? "my-strategy-page-head" : undefined}
        title={mine ? "我的策略" : "策略广场"}
        sub={
          mine
            ? "AI沟通生成 · 历史回测 · 模拟测试 · 提交审核"
            : "平台AI策略与用户创作策略的审核合作市场"
        }
        actions={
          <>
            {mine && (
              <button
                className="strategy-create-top"
                onClick={() => setCreateRequest((value) => value + 1)}
              >
                创建策略
              </button>
            )}
            <button
              className={`strategy-list-toggle ${mine ? "soft" : "primary"}`}
              onClick={toggleMine}
            >
              {mine ? "返回策略广场" : "我的策略"}
            </button>
          </>
        }
      />
      {mine ? (
        <CommunityStrategyCenter
          key={createRequest}
          view="mine"
          onOpenStrategy={setDetail}
          createRequest={createRequest}
        />
      ) : (
        <>
          <PlatformStrategies onOpen={setDetail} />
          <CommunityStrategyCenter onOpenStrategy={setDetail} />
        </>
      )}
    </>
  );
}
const platformStrategyDetails: StrategyDetailData[] = [
  {
    id: "ai-stable",
    name: "AI 稳健型",
    summary: "现货 / 低频趋势",
    riskLevel: "low",
    symbols: ["BTC/USDT", "ETH/USDT"],
    version: 3,
    rankingScore: 0,
    activeFollowers: 0,
    source: "platform",
    authorName: "AgentNovas AI Core",
    authorRole: "平台 AI 策略团队",
  },
  {
    id: "ai-balanced",
    name: "AI 平衡型",
    summary: "趋势 + 震荡自适应",
    riskLevel: "medium",
    symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    version: 4,
    rankingScore: 0,
    activeFollowers: 0,
    source: "platform",
    authorName: "AgentNovas AI Core",
    authorRole: "平台 AI 策略团队",
  },
  {
    id: "ai-aggressive",
    name: "AI 激进型",
    summary: "现货 / 突破动量",
    riskLevel: "high",
    symbols: ["BTC/USDT", "SOL/USDT"],
    version: 2,
    rankingScore: 0,
    activeFollowers: 0,
    source: "platform",
    authorName: "AgentNovas AI Core",
    authorRole: "平台 AI 策略团队",
  },
];
function PlatformStrategies({
  onOpen,
}: {
  onOpen: (strategy: StrategyDetailData) => void;
}) {
  const [tip, setTip] = useState<number | null>(null);
  const risk = { low: "低风险", medium: "中风险", high: "高风险" };
  const monthlyFloor = { low: 5, medium: 10, high: 20 };
  const riskBudget = { low: "≤1%", medium: "≤3%", high: "≤5%" };
  return (
    <section className="platform-ai-section">
      <div className="platform-strategy-layout">
        <aside className="strategy-side-panel strategy-side-left">
          <small>MARKET PULSE</small>
          <h3>市场脉搏</h3>
          <p>三套 AI 策略根据波动与趋势状态动态调整观察重点。</p>
          <div className="strategy-side-stat">
            <span>趋势强度</span>
            <b>62/100</b>
            <i>
              <em style={{ width: "62%" }} />
            </i>
          </div>
          <div className="strategy-side-stat">
            <span>整体风险</span>
            <b>38/100</b>
            <i>
              <em style={{ width: "38%" }} />
            </i>
          </div>
          <div className="strategy-pulse-readout">
            <div>
              <span>趋势判断</span>
              <b>温和偏强</b>
              <small>62/100 · 保持观察</small>
            </div>
            <div>
              <span>风险状态</span>
              <b>可控</b>
              <small>38/100 · 未触发预警</small>
            </div>
          </div>
        </aside>
        <div className="cards">
          {platformStrategyDetails.map((x, i) => {
            const actualMonthly = x.projectedMonthlyPct;
            return (
              <article className="strategy-card" key={x.id}>
                <div className={`strategy-icon s${i}`}>AI</div>
                <span className="badge">{risk[x.riskLevel]}</span>
                <h2>{x.name}</h2>
                <p>{x.summary}</p>
                <div className="fake-chart">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <dl className="strategy-metrics">
                  <div className="monthly-target-metric">
                    <dt>
                      预计月化（目标）{" "}
                      <button
                        className="metric-help"
                        aria-label="查看预计月化说明"
                        onClick={() => setTip(tip === i ? null : i)}
                      >
                        i
                      </button>
                    </dt>
                    <dd>≥{monthlyFloor[x.riskLevel]}%</dd>
                    {tip === i && (
                      <span className="metric-tip">
                        目标下限用于策略筛选，不代表收益保证；实际月化以已实现记录为准。
                      </span>
                    )}
                  </div>
                  <div className="actual-monthly-metric">
                    <dt>近期月化记录</dt>
                    <dd
                      className={
                        actualMonthly != null && actualMonthly < 0
                          ? "negative"
                          : "positive"
                      }
                    >
                      {actualMonthly == null
                        ? "样本不足"
                        : `${actualMonthly > 0 ? "+" : ""}${actualMonthly}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>最大回撤</dt>
                    <dd>
                      {x.maxDrawdownPct == null
                        ? "待实绩"
                        : `${x.maxDrawdownPct}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>今日收益</dt>
                    <dd>
                      {x.todayReturnPct == null
                        ? "待实绩"
                        : `${Number(x.todayReturnPct) > 0 ? "+" : ""}${x.todayReturnPct}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>昨日收益</dt>
                    <dd
                      className={
                        Number(x.yesterdayReturnPct) < 0 ? "negative" : ""
                      }
                    >
                      {x.yesterdayReturnPct == null
                        ? "待实绩"
                        : `${Number(x.yesterdayReturnPct) > 0 ? "+" : ""}${x.yesterdayReturnPct}%`}
                    </dd>
                  </div>
                  <div className="risk-budget-metric">
                    <dt>风险预算</dt>
                    <dd className="green">{riskBudget[x.riskLevel]}</dd>
                  </div>
                </dl>
                <button
                  className="strategy-follow-cta"
                  aria-label={`跟随${x.name}`}
                  onClick={() => onOpen(x)}
                >
                  跟随
                </button>
              </article>
            );
          })}
        </div>
        <aside className="strategy-side-panel strategy-side-right">
          <small>SELECTION GUIDE</small>
          <h3>选择建议</h3>
          <p>根据趋势强度、风险承受能力和仓位纪律选择适合自己的策略。</p>
          <div className="strategy-side-choice">
            <b>低风险</b>
            <span>适合稳健观察和现货配置</span>
          </div>
          <div className="strategy-side-choice">
            <b>中风险</b>
            <span>适合趋势与震荡切换</span>
          </div>
          <div className="strategy-side-choice">
            <b>高风险</b>
            <span>波动更大，需严格控制仓位</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
function Meeting() {
  const [auditOpen, setAuditOpen] = useState(false);
  return (
    <>
      <PageHead
        title="AI 决策会议室"
        sub="会议 #BTC-20260812-1031 · 风险复核阶段"
        actions={
          <button
            className="soft"
            onClick={() => setAuditOpen((open) => !open)}
            aria-expanded={auditOpen}
          >
            {auditOpen ? "收起审计记录" : "查看审计记录"}
          </button>
        }
      />
      <div className="meeting-grid">
        <section className="roundtable">
          <div className="table-core">
            <b>BTC</b>
            <span>等待决策</span>
          </div>
          {[
            "市场分析师",
            "策略研究员",
            "反方审查员",
            "首席风控官",
            "组合经理",
          ].map((x, i) => (
            <div className={`seat seat${i}`} key={x}>
              <i>{i + 1}</i>
              <b>{x}</b>
              <small>{["支持", "支持", "反对", "有条件", "数据不足"][i]}</small>
            </div>
          ))}
        </section>
        <section className="transcript">
          <h3>
            结构化会议记录 <span>LIVE</span>
          </h3>
          {[
            ["市场分析师", "趋势结构完整，建议研究多头机会。"],
            ["策略研究员", "提出8%仓位、分两次入场。"],
            ["反方审查员", "异议：量能不足，可能是假突破。"],
            ["首席风控官", "将仓位降至3%，禁止使用杠杆。"],
            ["AI决策官", "暂缓执行，15分钟后重新评估。"],
          ].map((x, i) => (
            <div className="line" key={x[0]}>
              <i className={i > 1 ? "warn" : ""} />
              <div>
                <b>
                  {x[0]}{" "}
                  <time>
                    10:3{1 + i}:0{i}
                  </time>
                </b>
                <p>{x[1]}</p>
              </div>
            </div>
          ))}
        </section>
      </div>
      {auditOpen && (
        <section className="meeting-audit-panel">
          <header>
            <div>
              <small>AUDIT TRAIL</small>
              <h3>会议审计详情</h3>
            </div>
            <span>已记录 5 项</span>
          </header>
          <div className="meeting-audit-grid">
            <div>
              <b>会议时间</b>
              <span>2026-08-12 10:31</span>
            </div>
            <div>
              <b>风险阶段</b>
              <span>风险复核中</span>
            </div>
            <div>
              <b>参与 Agent</b>
              <span>5 个决策节点</span>
            </div>
            <div>
              <b>授权状态</b>
              <span>未执行交易</span>
            </div>
          </div>
          <ol>
            <li>
              <b>市场分析师</b>
              <span>完成趋势结构分析并提交多头机会建议</span>
            </li>
            <li>
              <b>首席风控官</b>
              <span>将仓位上限调整至 3%，禁止使用杠杆</span>
            </li>
            <li>
              <b>AI 决策官</b>
              <span>暂缓执行，等待 15 分钟成交量确认</span>
            </li>
          </ol>
        </section>
      )}
      <section className="final-card">
        <div>
          <small>最终决策</small>
          <h2>暂不交易 BTC</h2>
        </div>
        <dl>
          <div>
            <dt>支持</dt>
            <dd>2票</dd>
          </div>
          <div>
            <dt>反对</dt>
            <dd>1票</dd>
          </div>
          <div>
            <dt>综合置信度</dt>
            <dd>61%</dd>
          </div>
          <div>
            <dt>账户影响</dt>
            <dd className="green">无新增风险</dd>
          </div>
        </dl>
        <p>等待成交量确认后重新评估。风控否决优先于普通多数表决。</p>
      </section>
    </>
  );
}
function Security({ t }: { t: Record<string, string> }) {
  return (
    <div className="security-center-page">
      <PageHead title={t.security} sub="设置通知渠道与接收偏好" />
      <NotificationSettingsPanel />
    </div>
  );
}
async function readApiResult(response: Response) {
  const raw = await response.text();
  if (!raw.trim())
    throw new Error(`服务器未返回结果（HTTP ${response.status}）。请稍后重试`);
  try {
    return JSON.parse(raw) as { error?: string; message?: string };
  } catch {
    throw new Error(
      `服务器返回了无效结果（HTTP ${response.status}）。请稍后重试`,
    );
  }
}
type AuthCopy = {
  loginTitle: string;
  loginLead: string;
  registerTitle: string;
  registerLead: string;
  formLoginTitle: string;
  formLoginLead: string;
  formRegisterTitle: string;
  formRegisterLead: string;
  account: string;
  accountPlaceholder: string;
  phone: string;
  phonePlaceholder: string;
  email: string;
  emailPlaceholder: string;
  password: string;
  passwordPlaceholder: string;
  invitation: string;
  invitationPlaceholder: string;
  inviteFilled: string;
  login: string;
  register: string;
  busy: string;
  noAccount: string;
  hasAccount: string;
  useInvite: string;
  backLogin: string;
  forgot: string;
  access: string;
  create: string;
  secure: string;
  private: string;
  audited: string;
  success: string;
};
const authCopy: Record<Lang, AuthCopy> = {
  "zh-CN": {
    loginTitle: "欢迎回来",
    loginLead: "登录你的 AI 量化团队控制中心",
    registerTitle: "创建账户",
    registerLead: "使用邀请码加入 AgentNovas 智能交易平台",
    formLoginTitle: "账户登录",
    formLoginLead: "请输入你的账户信息，继续进入交易控制中心。",
    formRegisterTitle: "邀请码注册",
    formRegisterLead: "设置账户信息后即可加入你的专属团队。",
    account: "账号",
    accountPlaceholder: "手机号 / 邮箱 / 用户名",
    phone: "手机号（必填）",
    phonePlaceholder: "请输入手机号（可含国际区号）",
    email: "邮箱（选填）",
    emailPlaceholder: "用于找回密码和接收通知",
    password: "密码",
    passwordPlaceholder: "至少 10 位字符",
    invitation: "邀请码",
    invitationPlaceholder: "请输入邀请码或咨询客服",
    inviteFilled: "已从邀请链接自动填入",
    login: "安全登录",
    register: "立即注册",
    busy: "正在处理…",
    noAccount: "还没有账户？",
    hasAccount: "已有账户？",
    useInvite: "使用邀请码注册",
    backLogin: "返回登录",
    forgot: "忘记密码？",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "安全访问",
    private: "隐私隔离",
    audited: "操作可审计",
    success: "注册成功",
  },
  "zh-TW": {
    loginTitle: "歡迎回來",
    loginLead: "登入你的 AI 量化團隊控制中心",
    registerTitle: "建立帳戶",
    registerLead: "使用邀請碼加入 AgentNovas 智能交易平台",
    formLoginTitle: "帳戶登入",
    formLoginLead: "請輸入你的帳戶資訊，繼續進入交易控制中心。",
    formRegisterTitle: "邀請碼註冊",
    formRegisterLead: "設定帳戶資訊後即可加入你的專屬團隊。",
    account: "帳戶",
    accountPlaceholder: "手機號碼 / 電子郵件 / 使用者名稱",
    phone: "手機號碼（必填）",
    phonePlaceholder: "請輸入手機號碼（可含國際區碼）",
    email: "電子郵件（選填）",
    emailPlaceholder: "用於找回密碼和接收通知",
    password: "密碼",
    passwordPlaceholder: "至少 10 個字元",
    invitation: "邀請碼",
    invitationPlaceholder: "請輸入邀請碼或諮詢客服",
    inviteFilled: "已從邀請連結自動填入",
    login: "安全登入",
    register: "立即註冊",
    busy: "處理中…",
    noAccount: "還沒有帳戶？",
    hasAccount: "已有帳戶？",
    useInvite: "使用邀請碼註冊",
    backLogin: "返回登入",
    forgot: "忘記密碼？",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "安全存取",
    private: "隱私隔離",
    audited: "操作可稽核",
    success: "註冊成功",
  },
  "en-US": {
    loginTitle: "Welcome back",
    loginLead: "Sign in to your AI quant team control center",
    registerTitle: "Create your account",
    registerLead: "Join AgentNovas with your invitation code",
    formLoginTitle: "Account sign in",
    formLoginLead:
      "Enter your account details to continue to the trading control center.",
    formRegisterTitle: "Invitation registration",
    formRegisterLead: "Set up your account to join your dedicated AI team.",
    account: "Account",
    accountPlaceholder: "Phone / email / username",
    phone: "Phone number (required)",
    phonePlaceholder: "Include country code when needed",
    email: "Email (optional)",
    emailPlaceholder: "For recovery and notifications",
    password: "Password",
    passwordPlaceholder: "At least 10 characters",
    invitation: "Invitation code",
    invitationPlaceholder: "Enter your code or contact support",
    inviteFilled: "Filled from your invitation link",
    login: "Secure sign in",
    register: "Create account",
    busy: "Processing…",
    noAccount: "New to AgentNovas?",
    hasAccount: "Already have an account?",
    useInvite: "Register with an invite",
    backLogin: "Back to sign in",
    forgot: "Forgot password?",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "Secure access",
    private: "Private by design",
    audited: "Fully auditable",
    success: "Registration successful",
  },
  "ru-RU": {
    loginTitle: "С возвращением",
    loginLead: "Войдите в центр управления вашей ИИ-командой",
    registerTitle: "Создайте аккаунт",
    registerLead: "Присоединитесь к AgentNovas по коду приглашения",
    formLoginTitle: "Вход в аккаунт",
    formLoginLead: "Введите данные аккаунта, чтобы перейти в торговый центр.",
    formRegisterTitle: "Регистрация по приглашению",
    formRegisterLead: "Настройте аккаунт и присоединитесь к своей ИИ-команде.",
    account: "Аккаунт",
    accountPlaceholder: "Телефон / почта / имя пользователя",
    phone: "Номер телефона (обязательно)",
    phonePlaceholder: "При необходимости укажите код страны",
    email: "Эл. почта (необязательно)",
    emailPlaceholder: "Для восстановления и уведомлений",
    password: "Пароль",
    passwordPlaceholder: "Не менее 10 символов",
    invitation: "Код приглашения",
    invitationPlaceholder: "Введите код или обратитесь в поддержку",
    inviteFilled: "Заполнено из ссылки-приглашения",
    login: "Безопасный вход",
    register: "Создать аккаунт",
    busy: "Обработка…",
    noAccount: "Нет аккаунта?",
    hasAccount: "Уже есть аккаунт?",
    useInvite: "Регистрация по приглашению",
    backLogin: "Вернуться ко входу",
    forgot: "Забыли пароль?",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "Безопасный доступ",
    private: "Защита данных",
    audited: "Полный аудит",
    success: "Регистрация завершена",
  },
  "es-ES": {
    loginTitle: "Te damos la bienvenida",
    loginLead: "Accede al centro de control de tu equipo cuantitativo de IA",
    registerTitle: "Crea tu cuenta",
    registerLead: "Únete a AgentNovas con tu código de invitación",
    formLoginTitle: "Acceso a la cuenta",
    formLoginLead: "Introduce tus datos para continuar al centro de trading.",
    formRegisterTitle: "Registro con invitación",
    formRegisterLead: "Configura tu cuenta para unirte a tu equipo de IA.",
    account: "Cuenta",
    accountPlaceholder: "Teléfono / email / usuario",
    phone: "Número de teléfono (obligatorio)",
    phonePlaceholder: "Incluye el prefijo internacional si procede",
    email: "Email (opcional)",
    emailPlaceholder: "Para recuperación y notificaciones",
    password: "Contraseña",
    passwordPlaceholder: "Al menos 10 caracteres",
    invitation: "Código de invitación",
    invitationPlaceholder: "Introduce el código o contacta con soporte",
    inviteFilled: "Completado desde el enlace de invitación",
    login: "Acceso seguro",
    register: "Crear cuenta",
    busy: "Procesando…",
    noAccount: "¿Aún no tienes cuenta?",
    hasAccount: "¿Ya tienes una cuenta?",
    useInvite: "Registrarse con invitación",
    backLogin: "Volver al acceso",
    forgot: "¿Olvidaste la contraseña?",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "Acceso seguro",
    private: "Privacidad protegida",
    audited: "Totalmente auditable",
    success: "Registro completado",
  },
  "ja-JP": {
    loginTitle: "おかえりなさい",
    loginLead: "AIクオンツチームの管理センターにログイン",
    registerTitle: "アカウントを作成",
    registerLead: "招待コードでAgentNovasに参加",
    formLoginTitle: "アカウントログイン",
    formLoginLead: "アカウント情報を入力して取引管理センターへ進みます。",
    formRegisterTitle: "招待登録",
    formRegisterLead: "アカウントを設定して専属AIチームに参加します。",
    account: "アカウント",
    accountPlaceholder: "電話番号 / メール / ユーザー名",
    phone: "電話番号（必須）",
    phonePlaceholder: "必要に応じて国番号を入力",
    email: "メール（任意）",
    emailPlaceholder: "パスワード再設定と通知に使用",
    password: "パスワード",
    passwordPlaceholder: "10文字以上",
    invitation: "招待コード",
    invitationPlaceholder: "招待コードを入力、またはサポートへ連絡",
    inviteFilled: "招待リンクから自動入力済み",
    login: "安全にログイン",
    register: "アカウント作成",
    busy: "処理中…",
    noAccount: "初めての方",
    hasAccount: "アカウントをお持ちですか？",
    useInvite: "招待コードで登録",
    backLogin: "ログインに戻る",
    forgot: "パスワードを忘れた場合",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "安全なアクセス",
    private: "プライバシー保護",
    audited: "操作を完全記録",
    success: "登録が完了しました",
  },
  "ko-KR": {
    loginTitle: "다시 만나 반갑습니다",
    loginLead: "AI 퀀트 팀 관리 센터에 로그인하세요",
    registerTitle: "계정 만들기",
    registerLead: "초대 코드로 AgentNovas에 참여하세요",
    formLoginTitle: "계정 로그인",
    formLoginLead: "계정 정보를 입력하고 트레이딩 관리 센터로 이동하세요.",
    formRegisterTitle: "초대 등록",
    formRegisterLead: "계정을 설정하고 전담 AI 팀에 참여하세요.",
    account: "계정",
    accountPlaceholder: "전화번호 / 이메일 / 사용자명",
    phone: "전화번호(필수)",
    phonePlaceholder: "필요한 경우 국가 번호 포함",
    email: "이메일(선택)",
    emailPlaceholder: "비밀번호 복구 및 알림용",
    password: "비밀번호",
    passwordPlaceholder: "10자 이상",
    invitation: "초대 코드",
    invitationPlaceholder: "초대 코드를 입력하거나 고객지원 문의",
    inviteFilled: "초대 링크에서 자동 입력됨",
    login: "안전하게 로그인",
    register: "계정 만들기",
    busy: "처리 중…",
    noAccount: "계정이 없으신가요?",
    hasAccount: "이미 계정이 있으신가요?",
    useInvite: "초대 코드로 가입",
    backLogin: "로그인으로 돌아가기",
    forgot: "비밀번호를 잊으셨나요?",
    access: "ACCOUNT ACCESS",
    create: "CREATE ACCOUNT",
    secure: "안전한 접근",
    private: "개인정보 보호",
    audited: "전체 감사 기록",
    success: "가입이 완료되었습니다",
  },
};
function invitationCodeFromLocation() {
  const current = new URL(window.location.href);
  const hashParams = new URLSearchParams(current.hash.replace(/^#\??/, ""));
  const direct =
    current.searchParams.get("invite") ||
    current.searchParams.get("invitationCode") ||
    current.searchParams.get("code") ||
    hashParams.get("invite") ||
    hashParams.get("invitationCode") ||
    hashParams.get("code") ||
    "";
  const pathMatch = current.pathname.match(/\/(?:invite|register)\/([^/?#]+)/i);
  const raw = direct || pathMatch?.[1] || "";
  try {
    return decodeURIComponent(raw).trim().toUpperCase();
  } catch {
    return raw.trim().toUpperCase();
  }
}
function Login({
  go,
  t,
}: {
  go: (p: Page) => void;
  t: Record<string, string>;
}) {
  const copy = authCopy[t._lang as Lang] || authCopy["zh-CN"];
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [invitePrefilled, setInvitePrefilled] = useState(false);

  useEffect(() => {
    const invite = invitationCodeFromLocation();
    if (!invite) return;
    const frame = window.requestAnimationFrame(() => {
      setInviteCode(invite);
      setInvitePrefilled(true);
      setRegister(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const data = new FormData(e.currentTarget);
    try {
      const response = await fetch(
        register ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            identifier: data.get("identifier"),
            phone: data.get("phone"),
            email: data.get("email"),
            password: data.get("password"),
            invitationCode: data.get("invitationCode"),
          }),
        },
      );
      const result = await readApiResult(response);
      if (!response.ok) throw new Error(result.error || "操作失败");
      if (register) setMessage(result.message || copy.success);
      else go("hall");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className={`auth auth-${register ? "register" : "login"}`}>
        <section className="auth-brand">
          <div className="auth-brand-lockup">
            <span className="auth-brand-mark" aria-hidden="true">
              A
            </span>
            <div>
              <b>AgentNovas</b>
              <small>{t.tagline}</small>
            </div>
          </div>
          <div className="auth-brand-copy">
            <small>{register ? copy.create : copy.access}</small>
            <h1>{register ? copy.registerTitle : copy.loginTitle}</h1>
            <p>{register ? copy.registerLead : copy.loginLead}</p>
          </div>
          <div className="auth-brand-points">
            <span>
              <i>✓</i>
              {copy.secure}
            </span>
            <span>
              <i>✓</i>
              {copy.private}
            </span>
            <span>
              <i>✓</i>
              {copy.audited}
            </span>
          </div>
        </section>
        <form onSubmit={submit} aria-labelledby="auth-form-title">
          <header className="auth-form-heading">
            <small>{register ? copy.create : copy.access}</small>
            <h2 id="auth-form-title">
              {register ? copy.formRegisterTitle : copy.formLoginTitle}
            </h2>
            <p>{register ? copy.formRegisterLead : copy.formLoginLead}</p>
          </header>
          <div className="auth-fields">
            {register ? (
              <label>
                <span>{copy.phone}</span>
                <input
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  aria-required="true"
                  placeholder={copy.phonePlaceholder}
                />
              </label>
            ) : (
              <label>
                <span>{copy.account}</span>
                <input
                  name="identifier"
                  type="text"
                  autoComplete="username"
                  required
                  placeholder={copy.accountPlaceholder}
                />
              </label>
            )}
            {register && (
              <label>
                <span>{copy.email}</span>
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={copy.emailPlaceholder}
                />
              </label>
            )}
            <label>
              <span>{copy.password}</span>
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={10}
                required
                placeholder={copy.passwordPlaceholder}
              />
            </label>
            {register && (
              <label>
                <span className="auth-label-row">
                  <span>{copy.invitation}</span>
                  {invitePrefilled && (
                    <small>
                      <i>✓</i>
                      {copy.inviteFilled}
                    </small>
                  )}
                </span>
                <input
                  className="invitation-code-input"
                  name="invitationCode"
                  value={inviteCode}
                  onChange={(e) => {
                    setInviteCode(e.target.value.toUpperCase());
                    setInvitePrefilled(false);
                  }}
                  required
                  placeholder={copy.invitationPlaceholder}
                />
              </label>
            )}
          </div>
          {message && (
            <div className="auth-message" role="status">
              {message}
            </div>
          )}
          <button className="primary auth-submit" disabled={busy}>
            {busy ? copy.busy : register ? copy.register : copy.login}
          </button>
          <div className="auth-switch">
            <p>
              {register ? copy.hasAccount : copy.noAccount}{" "}
              <button
                type="button"
                onClick={() => {
                  setRegister(!register);
                  setMessage("");
                }}
              >
                {register ? copy.backLogin : copy.useInvite}
              </button>
            </p>
            {!register && (
              <button type="button" className="auth-link">
                {copy.forgot}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
function Admin() {
  const [tab, setTab] = useState("overview");
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [notice, setNotice] = useState("");
  async function load(next = tab, urlOverride?: string) {
    setTab(next);
    setNotice("");
    const map: Record<string, string> = {
      data: "/api/data-center",
      tasks: "/api/employee/tasks",
      targets: "/api/team/monthly-targets",
      customers: "/api/organization/customers",
      approvals: "/api/approvals",
      members: "/api/organization/members",
      invites: "/api/invitations",
      settlements: "/api/finance/settlements",
      collections: "/api/finance/collections",
      payouts: "/api/finance/payout-profiles",
    };
    if (!map[next]) {
      setRows([]);
      return;
    }
    const res = await fetch(urlOverride || map[next]);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      setNotice(String(data.error || "请使用相应管理账户登录"));
      setRows([]);
      return;
    }
    if (next === "data" || next === "tasks" || next === "targets") {
      setRows([data]);
      return;
    }
    setRows(
      (data.customers ||
        data.requests ||
        data.members ||
        data.invitations ||
        data.settlements ||
        data.collections ||
        data.profiles ||
        []) as Array<Record<string, unknown>>,
    );
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load("overview"), 0);
    return () => window.clearTimeout(timer);
  }, []);
  async function createInvite(kind: string) {
    const res = await fetch("/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const data = (await res.json()) as {
      error?: string;
      invitation?: { code: string };
    };
    setNotice(
      data.invitation
        ? `新邀请码：${data.invitation.code}（请立即保存）`
        : data.error || "生成失败",
    );
    if (res.ok) void load("invites");
  }
  const done = (m: string, next?: string) => {
    setNotice(m);
    if (next) void load(next);
  };
  const memberTreeRefreshKey = rows
    .map((row) => `${String(row.id || "")}:${String(row.status || "")}`)
    .join("|");
  return (
    <div className="operations-admin">
      <PageHead
        title="组织与运营后台"
        sub="组织权限、客户归因、双人审批与收入结算"
        actions={<button className="danger">全局紧急停止</button>}
      />
      <div className="admin-tabs">
        {[
          ["overview", "运营概览"],
          ["data", "总数据中心"],
          ["tasks", "团队客户任务"],
          ["targets", "月度任务指标"],
          ["members", "组织成员"],
          ["customers", "客户管理"],
          ["invites", "邀请码"],
          ["approvals", "待审批"],
          ["revenue", "月度分红"],
          ["settlements", "结算付款"],
          ["collections", "逾期应收款"],
          ["payouts", "收款地址"],
          ["adjustment", "收入调整"],
          ["integrations", "行情新闻 API"],
        ].map((x) => (
          <button
            key={x[0]}
            className={tab === x[0] ? "active" : ""}
            onClick={() => void load(x[0])}
          >
            {x[1]}
          </button>
        ))}
      </div>
      {notice && <div className="admin-notice">{notice}</div>}
      {tab === "overview" && (
        <>
          <div className="kpis">
            <Kpi n="组织架构" v="5级" s="逐级权限" />
            <Kpi n="客户归因" v="实时" s="不追溯历史" />
            <Kpi n="审批机制" v="双人" s="申请人不得自审" />
            <Kpi n="月度结算" v="每月5日" s="USDT人工结算" />
          </div>
          <div className="admin-grid">
            <section className="wide-panel">
              <h2>后台模块状态</h2>
              {[
                "邮箱账户与验证",
                "永久/一次性邀请码",
                "组织向下权限",
                "公海客户归因",
                "双人审批",
                "收入与分红账本",
              ].map((x) => (
                <div className="service" key={x}>
                  <span>
                    <i />
                    {x}
                  </span>
                  <b>已接入</b>
                  <small>服务端校验</small>
                </div>
              ))}
            </section>
            <section className="wide-panel collection-control">
              <h2>规则控制</h2>
              <p>
                公海归因前收入100%归总公司；归因生效后按10% / 80% / 10%分配。
              </p>
              <div>
                <span>盈利费率</span>
                <b>18% / 20%</b>
              </div>
              <div>
                <span>高水位线</span>
                <b>仅新增已实现净利润</b>
              </div>
              <small>所有资金与归因操作均保留审计记录。</small>
            </section>
          </div>
        </>
      )}
      {tab === "data" && <DataCenter data={rows[0]} />}
      {tab === "tasks" && <EmployeeTasks data={rows[0]} />}{" "}
      {tab === "targets" && (
        <MonthlyTargets
          data={rows[0]}
          onDone={(m) => done(m, "targets")}
          onMonth={(month) =>
            void load("targets", "/api/team/monthly-targets?month=" + month)
          }
        />
      )}{" "}
      {tab === "members" && (
        <>
          <MemberCreate onDone={(m) => done(m, "members")} />
          <ReportingLineChange onDone={(m) => done(m, "members")} />
          <OrganizationRelationshipTree refreshKey={memberTreeRefreshKey} />
        </>
      )}{" "}
      {tab === "customers" && (
        <>
          <AttributionCreate onDone={(m) => done(m)} />
          <section className="customer-management-guide">
            <h2>客户管理怎么用</h2>
            <p>
              这里展示当前组织权限范围内的直客与下属客户。你可以查看归属链、交易与结算状态，并在需要交接时补充备注。
            </p>
            <div className="customer-guide-grid">
              <article>
                <b>查看范围</b>
                <span>上级只能看到自己组织下属的汇总与客户明细。</span>
              </article>
              <article>
                <b>编辑与冻结</b>
                <span>
                  编辑资料、冻结交易或恢复权限都不会删除订单和审计历史。
                </span>
              </article>
              <article>
                <b>归属与交接</b>
                <span>
                  客户转移由分公司审批，历史收入不追溯；交接备注会保留在客户档案。
                </span>
              </article>
            </div>
          </section>
          <CustomerManagement
            rows={rows}
            onDone={(m) => done(m, "customers")}
          />
        </>
      )}{" "}
      {tab === "invites" && (
        <div className="admin-actions">
          <button
            className="primary"
            onClick={() => void createInvite("employee_reusable")}
          >
            生成员工永久邀请码
          </button>
          <button onClick={() => void createInvite("public_pool_single_use")}>
            生成客服一次性邀请码
          </button>
        </div>
      )}
      {tab === "revenue" && <MonthlyRevenue />}
      {tab === "settlements" && (
        <>
          <SettlementOverview rows={rows} />
          <SettlementForm onDone={(m) => done(m, "settlements")} />
        </>
      )}{" "}
      {tab === "payouts" && <PayoutForm onDone={(m) => done(m, "payouts")} />}{" "}
      {tab === "adjustment" && <AdjustmentForm onDone={(m) => done(m)} />}{" "}
      {tab === "integrations" && <MarketNewsSettings />}{" "}
      {tab === "approvals" ? (
        <ApprovalRows rows={rows} onDone={(m) => done(m, "approvals")} />
      ) : tab === "collections" ? (
        <CollectionRows rows={rows} onDone={(m) => done(m, "collections")} />
      ) : (
        ![
          "overview",
          "data",
          "tasks",
          "targets",
          "revenue",
          "adjustment",
          "integrations",
        ].includes(tab) && (
          <AdminRows rows={rows} empty="暂无数据，或当前账户没有该模块权限" />
        )
      )}
    </div>
  );
}
function DataCenter({ data }: { data?: Record<string, unknown> }) {
  const [selected, setSelected] = useState<Record<string, unknown> | null>(
    null,
  );
  if (!data)
    return <div className="admin-empty">请登录组织账户查看数据中心</div>;
  const s = (data.summary || {}) as Record<string, number>,
    trend = (data.trend || []) as Array<Record<string, unknown>>,
    customers = (data.customers || []) as Array<Record<string, unknown>>,
    max = Math.max(
      1,
      ...trend.flatMap((x) => [
        Math.abs(Number(x.pnl || 0)),
        Number(x.trades || 0),
        Number(x.registered || 0),
      ]),
    );
  return (
    <div className="data-center">
      <div className="kpis">
        <Kpi
          n="所属客户"
          v={String(s.customers || 0)}
          s={`${s.connectedCustomers || 0}人已连接交易所`}
        />
        <Kpi
          n="策略跟随客户"
          v={String(s.followingCustomers || 0)}
          s="权限范围内"
        />
        <Kpi
          n="持仓本金"
          v={`$${Number(s.principal || 0).toLocaleString()}`}
          s={`${s.openPositions || 0}个未平仓`}
        />
        <Kpi
          n="已实现盈利"
          v={`$${Number(s.realizedPnl || 0).toLocaleString()}`}
          s={`整体胜率 ${Number(s.winRate || 0).toFixed(1)}%`}
        />
      </div>
      <section className="data-trends">
        <header>
          <div>
            <small>ORGANIZATION ANALYTICS</small>
            <h2>近六个月客户与交易趋势</h2>
          </div>
          <span>仅统计当前层级可见客户</span>
        </header>
        <div className="trend-chart">
          {trend.map((x) => (
            <div key={String(x.month)}>
              <div className="trend-bars">
                <i
                  style={{
                    height: `${Math.max(4, (Number(x.registered || 0) / max) * 100)}%`,
                  }}
                />
                <i
                  className="trade"
                  style={{
                    height: `${Math.max(4, (Number(x.trades || 0) / max) * 100)}%`,
                  }}
                />
                <i
                  className="pnl"
                  style={{
                    height: `${Math.max(4, (Math.abs(Number(x.pnl || 0)) / max) * 100)}%`,
                  }}
                />
              </div>
              <b>{String(x.month).slice(5)}月</b>
              <small>{String(x.activeCustomers || 0)}活跃</small>
            </div>
          ))}
        </div>
      </section>
      <section className="customer-analytics">
        <div className="widget-head">
          <b>客户详细数据</b>
          <span>点击客户查看完整资料</span>
        </div>
        <div className="analytics-table">
          <table>
            <thead>
              <tr>
                <th>客户</th>
                <th>交易所</th>
                <th>持仓本金</th>
                <th>已实现盈利</th>
                <th>交易/胜率</th>
                <th>最大回撤</th>
                <th>跟随策略</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((row) => {
                const m = row.metrics as Record<string, number>,
                  ex = row.exchanges as Array<Record<string, unknown>>,
                  f = row.following as Array<Record<string, unknown>>;
                return (
                  <tr
                    key={String(row.customerId)}
                    onClick={() => setSelected(row)}
                  >
                    <td>
                      <b>{String(row.displayName || row.email)}</b>
                      <small>{String(row.email)}</small>
                    </td>
                    <td>
                      {ex.map((x) => String(x.name)).join(" · ") || "未连接"}
                    </td>
                    <td>${Number(m.principal || 0).toLocaleString()}</td>
                    <td
                      className={
                        Number(m.realizedPnl || 0) >= 0 ? "green" : "down"
                      }
                    >
                      ${Number(m.realizedPnl || 0).toLocaleString()}
                    </td>
                    <td>
                      {m.totalTrades || 0} / {Number(m.winRate || 0).toFixed(1)}
                      %
                    </td>
                    <td>${Number(m.maxDrawdown || 0).toLocaleString()}</td>
                    <td>
                      {f.map((x) => String(x.name)).join(" · ") || "暂无"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {selected && (
        <CustomerDataDrawer row={selected} close={() => setSelected(null)} />
      )}
    </div>
  );
}
function CustomerDataDrawer({
  row,
  close,
}: {
  row: Record<string, unknown>;
  close: () => void;
}) {
  const m = row.metrics as Record<string, number>,
    ex = row.exchanges as Array<Record<string, unknown>>,
    f = row.following as Array<Record<string, unknown>>;
  return (
    <div className="customer-data-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
      <aside>
        <header>
          <div>
            <small>CUSTOMER 360°</small>
            <h2>{String(row.displayName || row.email)}</h2>
            <p>{String(row.email)}</p>
          </div>
          <button onClick={close}>×</button>
        </header>
        <div className="customer-detail-kpis">
          <span>
            <small>持仓本金</small>
            <b>${Number(m.principal || 0).toLocaleString()}</b>
          </span>
          <span>
            <small>已实现盈利</small>
            <b>${Number(m.realizedPnl || 0).toLocaleString()}</b>
          </span>
          <span>
            <small>胜率</small>
            <b>{Number(m.winRate || 0).toFixed(1)}%</b>
          </span>
          <span>
            <small>最大回撤</small>
            <b>${Number(m.maxDrawdown || 0).toLocaleString()}</b>
          </span>
        </div>
        <section>
          <h3>注册与账户</h3>
          <dl>
            {[
              ["注册IP", row.registrationIp],
              ["注册时间", row.registeredAt],
              ["邮箱验证", row.emailVerifiedAt ? "已验证" : "未验证"],
              ["最后活跃", row.lastActiveAt || "暂无"],
              ["语言/时区", `${row.locale} · ${row.timezone}`],
              ["客户备注", row.contactNote || "暂无"],
            ].map((x) => (
              <div key={String(x[0])}>
                <dt>{String(x[0])}</dt>
                <dd>{String(x[1])}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3>跟单交易所</h3>
          {ex.length ? (
            ex.map((x) => (
              <article key={String(x.id)}>
                <b>
                  {String(x.name)} · {String(x.label)}
                </b>
                <span>
                  {String(x.environment)} · {String(x.status)}
                </span>
              </article>
            ))
          ) : (
            <p>暂无连接</p>
          )}
        </section>
        <section>
          <h3>跟随策略</h3>
          {f.length ? (
            f.map((x) => (
              <article key={String(x.id)}>
                <b>{String(x.name)}</b>
                <span>{String(x.status)}</span>
              </article>
            ))
          ) : (
            <p>暂无跟随</p>
          )}
        </section>
        <section>
          <h3>交易统计</h3>
          <dl>
            {[
              ["总交易", `${m.totalTrades || 0}笔`],
              ["已平仓", `${m.closedTrades || 0}笔`],
              ["未平仓", `${m.openPositions || 0}笔`],
              ["手续费和资金费", `$${Number(m.fees || 0).toLocaleString()}`],
            ].map((x) => (
              <div key={String(x[0])}>
                <dt>{String(x[0])}</dt>
                <dd>{String(x[1])}</dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>
    </div>
  );
}
function MemberCreate({ onDone }: { onDone: (m: string) => void }) {
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await fetch("/api/organization/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.get("email"), name: f.get("name") }),
    });
    const d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  return (
    <form className="admin-inline-form" onSubmit={submit}>
      <label>
        成员邮箱
        <input
          name="email"
          type="email"
          required
          placeholder="member@example.com"
        />
      </label>
      <label>
        组织/团队名称
        <input name="name" placeholder="创建分公司时必填" />
      </label>
      <button className="primary">创建下一级成员</button>
    </form>
  );
}
function ReportingLineChange({ onDone }: { onDone: (m: string) => void }) {
  const [members, setMembers] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    void fetch("/api/organization/members")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setMembers((d?.members || []) as Array<Record<string, unknown>>),
      )
      .catch(() => setMembers([]));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)),
      r = await fetch("/api/organization/members", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(f),
      }),
      d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  return (
    <form className="admin-inline-form" onSubmit={submit}>
      <label>
        调整成员
        <select name="memberId" required>
          <option value="">请选择成员</option>
          {members.map((m) => (
            <option key={String(m.id)} value={String(m.id)}>
              {String(m.email)} · {String(m.role)}
            </option>
          ))}
        </select>
      </label>
      <label>
        新的直属上级
        <select name="newReportsToUserId" required>
          <option value="">请选择上级</option>
          {members.map((m) => (
            <option key={String(m.id)} value={String(m.id)}>
              {String(m.email)} · {String(m.role)}
            </option>
          ))}
        </select>
      </label>
      <label>
        职位
        <select name="newRole" defaultValue="">
          <option value="">保持原职位</option>
          <option value="branch_admin">分公司管理员</option>
          <option value="manager">经理</option>
          <option value="supervisor">主管</option>
          <option value="employee">员工</option>
        </select>
      </label>
      <label>
        调整原因
        <input name="reason" required />
      </label>
      <button>提交双人审批</button>
    </form>
  );
}
function AttributionCreate({ onDone }: { onDone: (m: string) => void }) {
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = await fetch("/api/attributions/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f),
    });
    const d = (await r.json()) as { error?: string; requestId?: string };
    onDone(
      d.requestId
        ? `归因申请已提交：${d.requestId}，等待两人审批`
        : d.error || "提交失败",
    );
  }
  return (
    <form className="admin-inline-form attribution" onSubmit={submit}>
      <label>
        归因记录ID
        <input name="attributionId" required />
      </label>
      <label>
        分公司ID
        <input name="branchId" required />
      </label>
      <label>
        经理ID
        <input name="managerId" required />
      </label>
      <label>
        主管ID
        <input name="supervisorId" />
      </label>
      <label>
        员工ID
        <input name="employeeId" />
      </label>
      <label>
        生效时间
        <input name="effectiveAt" type="datetime-local" />
      </label>
      <label>
        归因依据
        <input name="reason" required />
      </label>
      <button className="primary">提交双人审批</button>
    </form>
  );
}
function ApprovalRows({
  rows,
  onDone,
}: {
  rows: Array<Record<string, unknown>>;
  onDone: (m: string) => void;
}) {
  async function decide(id: string, decision: string) {
    const note =
      window.prompt(
        decision === "approve" ? "填写审批意见（可选）" : "填写驳回原因",
      ) || "";
    const r = await fetch(`/api/approvals/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note }),
    });
    const d = (await r.json()) as {
      error?: string;
      status?: string;
      approvals?: number;
    };
    onDone(
      d.error ||
        `审批状态：${d.status}${d.approvals ? `（${d.approvals}/2）` : ""}`,
    );
  }
  if (!rows.length) return <div className="admin-empty">暂无待审批事项</div>;
  return (
    <div className="approval-list">
      {rows.map((r) => (
        <article key={String(r.id)}>
          <div>
            <small>{String(r.type)}</small>
            <b>
              {String(r.subjectType)} · {String(r.subjectId)}
            </b>
            <p>
              当前通过 {String(r.approvals)}/2 · 申请时间{" "}
              {String(r.requestedAt)}
            </p>
          </div>
          <span>
            <button
              className="danger"
              onClick={() => void decide(String(r.id), "reject")}
            >
              驳回
            </button>
            <button
              className="primary"
              onClick={() => void decide(String(r.id), "approve")}
            >
              通过
            </button>
          </span>
        </article>
      ))}
    </div>
  );
}
function AdminRows({
  rows,
  empty,
}: {
  rows: Array<Record<string, unknown>>;
  empty: string;
}) {
  const [memberRows, setMemberRows] = useState(rows),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setMemberRows(rows), 0);
    return () => window.clearTimeout(timer);
  }, [rows]);
  if (!rows.length) return <div className="admin-empty">{empty}</div>;
  const memberAccounts = memberRows.filter(
    (row) => row.role === "branch_admin",
  );
  if (memberAccounts.length)
    return (
      <section className="wide-panel member-admin-panel">
        <h2>组织成员账户</h2>
        <div className="table-wrap admin-data">
          <table>
            <thead>
              <tr>
                <th>邮箱</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {memberAccounts.map((row) => {
                const closed = row.status === "closed";
                return (
                  <tr key={String(row.id)}>
                    <td>{String(row.email || "—")}</td>
                    <td>{String(row.role || "—")}</td>
                    <td>{closed ? "已删除" : String(row.status || "—")}</td>
                    <td>{String(row.createdAt || "—")}</td>
                    <td>
                      <button
                        className="danger"
                        disabled={closed}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `确定删除成员账户 ${String(row.email || "")}？删除后该账户不能登录，但历史记录会保留。`,
                            )
                          )
                            return;
                          const response = await fetch(
                            "/api/organization/members",
                            {
                              method: "DELETE",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ memberId: row.id }),
                            },
                          );
                          const data = (await response.json()) as {
                            message?: string;
                            error?: string;
                          };
                          setNotice(data.message || data.error || "操作完成");
                          if (response.ok)
                            setMemberRows((previous) =>
                              previous.map((item) =>
                                item.id === row.id
                                  ? { ...item, status: "closed" }
                                  : item,
                              ),
                            );
                        }}
                      >
                        删除账户
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {notice && <div className="admin-notice">{notice}</div>}
      </section>
    );
  const keys = Object.keys(rows[0]).slice(0, 7);
  return (
    <div className="table-wrap admin-data">
      <table>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k}>
                  {typeof row[k] === "object"
                    ? JSON.stringify(row[k])
                    : String(row[k] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function CustomerManagement({
  rows,
  onDone,
}: {
  rows: Array<Record<string, unknown>>;
  onDone: (m: string) => void;
}) {
  async function action(row: Record<string, unknown>, type: string) {
    let body: Record<string, unknown> = {
      customerId: row.customerId,
      action: type,
    };
    if (type === "edit")
      body = {
        ...body,
        displayName:
          window.prompt("客户显示名称", String(row.displayName || "")) || "",
        contactNote:
          window.prompt("客户详情摘要", String(row.contactNote || "")) || "",
      };
    if (
      type === "archive" &&
      !window.confirm("确定归档该客户？交易、财务和审计历史会保留。")
    )
      return;
    const r = await fetch("/api/organization/customers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  async function note(row: Record<string, unknown>) {
    const content = window.prompt("填写客户交接备注") || "";
    if (!content.trim()) return;
    const r = await fetch(
        `/api/organization/customers/${String(row.customerId)}/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
      ),
      d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  return (
    <div className="customer-manage-grid">
      {rows.map((row) => (
        <article key={String(row.customerId)}>
          <header>
            <div>
              <b>{String(row.displayName || row.email)}</b>
              <small>
                {String(row.email)} · {String(row.status)}
              </small>
            </div>
            <em>
              {row.archivedAt
                ? "已归档"
                : row.status === "frozen"
                  ? "已冻结"
                  : "正常"}
            </em>
          </header>
          <p>{String(row.contactNote || "暂无客户详情摘要")}</p>
          <div className="customer-chain">
            <span>经理 {String(row.managerId || "—")}</span>
            <span>主管 {String(row.supervisorId || "—")}</span>
            <span>员工 {String(row.employeeId || "—")}</span>
          </div>
          <section>
            {((row.notes || []) as Array<Record<string, unknown>>)
              .slice(0, 3)
              .map((n) => (
                <small key={String(n.id)}>
                  {String(n.createdAt)} · {String(n.content)}
                </small>
              ))}
          </section>
          <footer>
            <button onClick={() => void note(row)}>交接备注</button>
            <button onClick={() => void action(row, "edit")}>编辑</button>
            {row.status === "frozen" ? (
              <button onClick={() => void action(row, "restore")}>恢复</button>
            ) : (
              <button onClick={() => void action(row, "freeze")}>冻结</button>
            )}
            <button
              className="danger"
              onClick={() => void action(row, "archive")}
            >
              归档
            </button>
          </footer>
        </article>
      ))}
    </div>
  );
}
function MonthlyRevenue() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports/monthly?month=${month}`);
      setData((await res.json()) as Record<string, unknown>);
    } finally {
      setLoading(false);
    }
  }
  const root = (data || {}) as Record<string, unknown>;
  const asRecord = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const summary = asRecord(root.summary || root);
  const amount = (...keys: string[]) => {
    for (const key of keys) {
      const value = summary[key];
      if (typeof value === "number") return value;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };
  const revenue = Array.isArray(root.revenue)
    ? (root.revenue as Array<Record<string, unknown>>)
    : [];
  const allocations = Array.isArray(root.allocations)
    ? (root.allocations as Array<Record<string, unknown>>)
    : [];
  const totalRevenue =
    revenue.reduce(
      (sum, row) => sum + Number(row.amount || row.amountUsdt || 0),
      0,
    ) || amount("totalRevenue", "revenueTotal", "total");
  const totalAllocated =
    allocations.reduce(
      (sum, row) => sum + Number(row.amount || row.amountUsdt || 0),
      0,
    ) || amount("totalAllocated", "allocatedTotal");
  const paid = amount("paid", "paidAmount", "settled", "settledAmount");
  const pending = amount("pending", "pendingAmount", "unpaid", "unpaidAmount");
  const totalForShare = totalAllocated || totalRevenue;
  const split = [
    {
      label: "总公司",
      value:
        amount("hq", "headOffice", "company", "hqAmount") ||
        totalForShare * 0.1,
      ratio: 10,
      kind: "hq",
    },
    {
      label: "分公司",
      value:
        amount("branch", "branchAmount", "branches") || totalForShare * 0.8,
      ratio: 80,
      kind: "branch",
    },
    {
      label: "员工奖励",
      value:
        amount("employee", "staff", "employeeAmount", "staffAmount") ||
        totalForShare * 0.1,
      ratio: 10,
      kind: "staff",
    },
  ];
  const rawTrend = Array.isArray(root.monthlyTrend)
    ? root.monthlyTrend
    : Array.isArray(root.trend)
      ? root.trend
      : [];
  const trend = rawTrend.map((item, index) => {
    const row = asRecord(item);
    const value = Number(
      row.amount || row.amountUsdt || row.value || row.total || row.profit || 0,
    );
    return {
      label: String(row.month || row.label || index + 1),
      value: Number.isFinite(value) ? value : 0,
    };
  });
  const trendMax = Math.max(1, ...trend.map((item) => item.value));
  return (
    <section className="monthly-report">
      <div className="monthly-report-head">
        <div>
          <small>MONTHLY DIVIDEND CONTROL</small>
          <h2>月度分红看板</h2>
          <p>
            按实际到账、客户归因与组织账本汇总，帮助财务快速核对本月可分配收入。
          </p>
        </div>
        <div className="monthly-report-tools">
          <label>
            结算月份
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <button
            className="primary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "读取中…" : "生成月度汇总"}
          </button>
        </div>
      </div>
      <div className="monthly-report-kpis">
        <article>
          <small>已确认收入</small>
          <strong>
            {totalRevenue.toFixed(2)} <em>USDT</em>
          </strong>
          <span>本月已确认的实际到账</span>
        </article>
        <article>
          <small>已分配金额</small>
          <strong>
            {totalAllocated.toFixed(2)} <em>USDT</em>
          </strong>
          <span>按组织规则生成的分配</span>
        </article>
        <article>
          <small>已结算付款</small>
          <strong>
            {paid.toFixed(2)} <em>USDT</em>
          </strong>
          <span>财务已完成付款</span>
        </article>
        <article>
          <small>待处理金额</small>
          <strong>
            {pending.toFixed(2)} <em>USDT</em>
          </strong>
          <span>等待复核或人工结算</span>
        </article>
      </div>
      <div className="monthly-report-grid">
        <article className="monthly-chart-card">
          <div className="monthly-chart-title">
            <div>
              <small>ALLOCATION MIX</small>
              <h3>组织分配结构</h3>
            </div>
            <span>当前规则 10 / 80 / 10</span>
          </div>
          <div className="allocation-chart">
            <div
              className="allocation-donut"
              style={{
                background:
                  "conic-gradient(#4d9dff 0 10%,#31c48d 10% 90%,#f3b657 90% 100%)",
              }}
            >
              <b>
                100%<small>分配结构</small>
              </b>
            </div>
            <div className="allocation-legend">
              {split.map((item) => (
                <div className="allocation-row" key={item.kind}>
                  <span>
                    <i className={`allocation-dot ${item.kind}`} />
                    {item.label}
                  </span>
                  <b>
                    {item.ratio}% <em>{item.value.toFixed(2)} USDT</em>
                  </b>
                  <div>
                    <i style={{ width: `${item.ratio}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </article>
        <article className="monthly-chart-card">
          <div className="monthly-chart-title">
            <div>
              <small>MONTHLY TREND</small>
              <h3>月度分红趋势</h3>
            </div>
            <span>{trend.length ? "实际账本数据" : "等待月度汇总"}</span>
          </div>
          {trend.length ? (
            <div className="monthly-trend-bars">
              {trend.map((item) => (
                <div className="monthly-trend-column" key={item.label}>
                  <b
                    style={{
                      height: `${Math.max(4, (item.value / trendMax) * 100)}%`,
                    }}
                  />
                  <span>{item.label}</span>
                  <em>{item.value.toFixed(2)}</em>
                </div>
              ))}
            </div>
          ) : (
            <div className="monthly-chart-empty">
              <strong>暂无可展示的趋势数据</strong>
              <span>生成月度汇总后，这里会按真实账本绘制月度分红变化。</span>
            </div>
          )}
        </article>
      </div>
      {data && (
        <details className="monthly-report-details">
          <summary>查看本月接口明细</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
function SettlementOverview({
  rows,
}: {
  rows: Array<Record<string, unknown>>;
}) {
  const total = rows.reduce((n, r) => n + Number(r.amountUsdt || 0), 0),
    paid = rows
      .filter((r) => r.status === "paid")
      .reduce((n, r) => n + Number(r.amountUsdt || 0), 0),
    approved = rows
      .filter((r) => r.status === "approved")
      .reduce((n, r) => n + Number(r.amountUsdt || 0), 0),
    pending = rows
      .filter((r) => !["paid", "approved"].includes(String(r.status)))
      .reduce((n, r) => n + Number(r.amountUsdt || 0), 0),
    max = Math.max(total, 1);
  return (
    <section className="settlement-overview">
      <div className="settlement-overview-head">
        <div>
          <small>SETTLEMENT CONTROL</small>
          <h2>结算付款看板</h2>
          <p>
            用于快速查看本组织结算单的金额、审批和付款状态。创建结算单只是提交一笔待核对的付款申请，必须双人审批后才能进入人工付款，不会自动转账。
          </p>
        </div>
        <span>{rows.length} 笔记录</span>
      </div>
      <div className="settlement-chart-grid">
        <article>
          <b>金额总览</b>
          <strong>
            {total.toFixed(2)} <small>USDT</small>
          </strong>
          <div className="chart-bar">
            <i style={{ width: `${Math.min(100, (total / max) * 100)}%` }} />
          </div>
          <span>全部待处理与历史结算</span>
        </article>
        <article>
          <b>已付款</b>
          <strong>
            {paid.toFixed(2)} <small>USDT</small>
          </strong>
          <div className="chart-bar paid">
            <i style={{ width: `${Math.min(100, (paid / max) * 100)}%` }} />
          </div>
          <span>完成财务双人审批并已付款</span>
        </article>
        <article>
          <b>审批中</b>
          <strong>
            {pending.toFixed(2)} <small>USDT</small>
          </strong>
          <div className="chart-bar pending">
            <i style={{ width: `${Math.min(100, (pending / max) * 100)}%` }} />
          </div>
          <span>等待复核、批准或补充材料</span>
        </article>
        <article>
          <b>已批准未付款</b>
          <strong>
            {approved.toFixed(2)} <small>USDT</small>
          </strong>
          <div className="chart-bar approved">
            <i style={{ width: `${Math.min(100, (approved / max) * 100)}%` }} />
          </div>
          <span>可进入人工付款队列</span>
        </article>
      </div>
    </section>
  );
}
function SettlementForm({ onDone }: { onDone: (m: string) => void }) {
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = await fetch("/api/finance/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f, amountUsdt: Number(f.amountUsdt) }),
    });
    const d = (await r.json()) as { error?: string; settlementId?: string };
    onDone(
      d.settlementId
        ? `结算单 ${d.settlementId} 已进入双人审批`
        : d.error || "创建失败",
    );
  }
  return (
    <form className="admin-inline-form finance-form" onSubmit={submit}>
      <label>
        期间开始
        <input name="periodStart" type="date" required />
      </label>
      <label>
        期间结束
        <input name="periodEnd" type="date" required />
      </label>
      <label>
        收款方ID
        <input name="beneficiaryId" required />
      </label>
      <label>
        金额 USDT
        <input
          name="amountUsdt"
          type="number"
          min="0.01"
          step="0.01"
          required
        />
      </label>
      <label>
        网络
        <select name="network">
          <option>TRC20</option>
          <option>ERC20</option>
          <option>BEP20</option>
        </select>
      </label>
      <button className="primary">创建结算单</button>
    </form>
  );
}
function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (file.size > 2_000_000) {
      reject(new Error("图片不能超过 2MB"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
function PayoutForm({ onDone }: { onDone: (m: string) => void }) {
  const [qrCode, setQrCode] = useState("");
  const [uploadError, setUploadError] = useState("");
  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      setUploadError("");
      setQrCode(await fileToDataUrl(file));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "图片读取失败");
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = await fetch("/api/finance/payout-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f, qrCode }),
    });
    const d = (await r.json()) as { error?: string; profileId?: string };
    onDone(
      d.profileId ? "收款地址与二维码已提交双人审批" : d.error || "提交失败",
    );
  }
  return (
    <form className="admin-inline-form" onSubmit={submit}>
      <label>
        网络
        <select name="network">
          <option>TRC20</option>
          <option>ERC20</option>
          <option>BEP20</option>
        </select>
      </label>
      <label>
        USDT收款地址
        <input name="address" required />
      </label>
      <label>
        收款二维码
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {qrCode && (
          <img className="upload-preview" src={qrCode} alt="收款二维码预览" />
        )}
        {uploadError && <small className="upload-error">{uploadError}</small>}
      </label>
      <button className="primary">提交地址变更</button>
    </form>
  );
}
function AdjustmentForm({ onDone }: { onDone: (m: string) => void }) {
  const [evidenceImage, setEvidenceImage] = useState("");
  const [uploadError, setUploadError] = useState("");
  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      setUploadError("");
      setEvidenceImage(await fileToDataUrl(file));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "图片读取失败");
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = await fetch("/api/finance/adjustments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...f,
        amountUsdt: Number(f.amountUsdt),
        evidenceImage,
      }),
    });
    const d = (await r.json()) as { error?: string; requestId?: string };
    onDone(d.requestId ? "人工调整单已提交双人审批" : d.error || "提交失败");
  }
  return (
    <form className="admin-inline-form finance-form" onSubmit={submit}>
      <label>
        客户ID
        <input name="customerId" required />
      </label>
      <label>
        关联订单/收入ID
        <input name="sourceId" required />
      </label>
      <label>
        调整金额
        <input name="amountUsdt" type="number" step="0.01" required />
      </label>
      <label>
        原因
        <input name="reason" required />
      </label>
      <label>
        证据说明
        <input name="evidence" />
      </label>
      <label>
        证据图片
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {evidenceImage && (
          <img
            className="upload-preview"
            src={evidenceImage}
            alt="证据图片预览"
          />
        )}
        {uploadError && <small className="upload-error">{uploadError}</small>}
      </label>
      <button className="primary">提交调整单</button>
    </form>
  );
}
function CollectionRows({
  rows,
  onDone,
}: {
  rows: Array<Record<string, unknown>>;
  onDone: (m: string) => void;
}) {
  async function confirm(id: string) {
    const note = window.prompt("填写收款凭证或备注") || "";
    const r = await fetch(`/api/finance/collections/${id}/confirm-paid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const d = (await r.json()) as { error?: string; approvalId?: string };
    onDone(d.approvalId ? "确认收款已进入双人审批" : d.error || "操作失败");
  }
  if (!rows.length) return <div className="admin-empty">暂无逾期应收款</div>;
  return (
    <div className="approval-list collection-list">
      {rows.map((r) => (
        <article key={String(r.id)}>
          <div>
            <small>
              {String(r.status)} ·{" "}
              {r.newEntriesAllowed ? "允许开仓" : "已停止新开仓"}
            </small>
            <b>
              {String(r.email)} · {String(r.amountUsdt)} USDT
            </b>
            <p>
              到期 {String(r.dueAt)} · 宽限结束 {String(r.graceEndsAt)} · 已提醒{" "}
              {String(r.remindersSent)} 次
            </p>
          </div>
          <button
            className="primary"
            disabled={r.status === "paid"}
            onClick={() => void confirm(String(r.id))}
          >
            确认已收款
          </button>
        </article>
      ))}
    </div>
  );
}
function EmployeeTasks({ data }: { data?: Record<string, unknown> }) {
  if (!data)
    return (
      <div className="admin-empty">
        请使用员工、主管、经理或分公司账户登录查看团队任务
      </div>
    );
  const s = data.summary as Record<string, number>;
  const collections = (data.collectionTasks || []) as Array<
      Record<string, unknown>
    >,
    memberships = (data.membershipTasks || []) as Array<
      Record<string, unknown>
    >,
    trades = (data.tradeSummary || []) as Array<Record<string, unknown>>;
  return (
    <div className="employee-tasks">
      <DailyTeamBrief />
      <CurrentMonthProgress />
      <div className="kpis">
        <Kpi n="可见客户" v={String(s.customers || 0)} s="当前权限范围" />
        <Kpi n="今日催收" v={String(s.collection || 0)} s="待跟进" />
        <Kpi n="未平仓交易" v={String(s.openTrades || 0)} s="实时跟踪" />
        <Kpi n="即将到期" v={String(s.expiring || 0)} s="未来7天" />
      </div>
      <div className="task-columns">
        <section>
          <div className="widget-head">
            <b>佣金催收任务</b>
            <span>每日更新</span>
          </div>
          {collections.length ? (
            collections.map((x) => (
              <div
                key={String(x.taskId)}
                className={x.status === "trading_stopped" ? "urgent" : ""}
              >
                <span>
                  <b>{String(x.email)}</b>
                  <small>
                    {String(x.amountUsdt)} USDT · 已提醒{" "}
                    {String(x.remindersSent)} 次
                  </small>
                </span>
                <em>
                  {x.status === "trading_stopped"
                    ? "已停止开仓"
                    : x.status === "grace"
                      ? "宽限期"
                      : "待催收"}
                </em>
                <time>{String(x.dueAt)}</time>
              </div>
            ))
          ) : (
            <p className="task-empty">今天没有催收任务</p>
          )}
        </section>
        <section>
          <div className="widget-head">
            <b>会员到期提醒</b>
            <span>未来7天</span>
          </div>
          {memberships.length ? (
            memberships.map((x) => (
              <article key={String(x.taskId)}>
                <span>
                  <b>{String(x.email)}</b>
                  <small>
                    {String(x.planCode)} · {String(x.status)}
                  </small>
                </span>
                <em>{x.status === "active" ? "即将到期" : "已到期/宽限"}</em>
                <time>{String(x.expiresAt)}</time>
              </article>
            ))
          ) : (
            <p className="task-empty">近期没有到期客户</p>
          )}
        </section>
      </div>
      <section className="wide-panel">
        <div className="widget-head">
          <b>客户交易信息</b>
          <span>仅显示权限范围内客户</span>
        </div>
        {trades.length ? (
          <div className="admin-table">
            <table>
              <thead>
                <tr>
                  <th>交易对</th>
                  <th>方向</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>已实现净收益</th>
                  <th>开仓时间</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((x) => (
                  <tr key={String(x.id)}>
                    <td>{String(x.symbol)}</td>
                    <td>{String(x.side)}</td>
                    <td>{x.origin === "platform" ? "平台" : "客户手动"}</td>
                    <td>{String(x.status)}</td>
                    <td>{String(x.realizedNetPnlUsdt || "—")} USDT</td>
                    <td>{String(x.openedAt || "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="task-empty">当前没有可显示的交易记录</p>
        )}
      </section>
      <div className="admin-notice">
        主管可查看自己的直客及下属员工客户；经理和分公司可查看其完整下属范围。客户消息由邮件、Telegram、WhatsApp和客服系统发送，员工后台不提供直接聊天功能。
      </div>
    </div>
  );
}
function MonthlyTargets({
  data,
  onDone,
  onMonth,
}: {
  data?: Record<string, unknown>;
  onDone: (m: string) => void;
  onMonth: (month: string) => void;
}) {
  if (!data) return <div className="admin-empty">正在加载月度任务</div>;
  const staff = (data.staff || []) as Array<Record<string, unknown>>,
    summary = (data.summary || {}) as Record<string, number>,
    canAssign = Boolean(data.canAssign),
    month = String(data.month || "");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = await fetch("/api/team/monthly-targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...f,
        newCustomersTarget: Number(f.newCustomersTarget),
        monthlyCardsTarget: Number(f.monthlyCardsTarget),
        quarterlyCardsTarget: Number(f.quarterlyCardsTarget),
        annualCardsTarget: Number(f.annualCardsTarget),
      }),
    });
    const d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  return (
    <div className="monthly-targets">
      <div className="widget-head">
        <b>{month} 团队月度任务</b>
        <div className="month-tools">
          <a href={"/api/team/monthly-targets/export?month=" + month}>
            导出 CSV
          </a>
          <label className="month-switch">
            历史月份{" "}
            <input
              type="month"
              value={month}
              onChange={(e) => onMonth(e.target.value)}
            />
          </label>
        </div>
      </div>
      <TeamTargetSummary summary={summary} count={staff.length} />
      <TargetAlerts
        month={month}
        alerts={(data.alerts || []) as Array<Record<string, unknown>>}
        onDone={onDone}
      />
      <FollowUpHistory month={month} onDone={onDone} />
      {canAssign && (
        <form className="target-form" onSubmit={submit}>
          <input name="month" type="month" defaultValue={month} required />
          <select name="assigneeUserId" required>
            <option value="">选择主管或员工</option>
            {staff
              .filter((x) =>
                ["supervisor", "employee"].includes(String(x.role)),
              )
              .map((x) => (
                <option key={String(x.userId)} value={String(x.userId)}>
                  {String(x.email)} ·{" "}
                  {x.role === "supervisor" ? "主管" : "员工"}
                </option>
              ))}
          </select>
          <input
            name="newCustomersTarget"
            type="number"
            min="0"
            placeholder="新增客户目标"
            required
          />
          <input
            name="monthlyCardsTarget"
            type="number"
            min="0"
            placeholder="月卡目标"
            required
          />
          <input
            name="quarterlyCardsTarget"
            type="number"
            min="0"
            placeholder="季卡目标"
            required
          />
          <input
            name="annualCardsTarget"
            type="number"
            min="0"
            placeholder="年卡目标"
            required
          />
          <input name="note" placeholder="任务说明（可选）" />
          <button className="primary">下发/更新任务</button>
        </form>
      )}
      {staff.length ? (
        <div className="target-grid">
          {staff.map((x) => {
            const actual = x.actual as Record<string, number>,
              goals = x.goals as Record<string, number>,
              progress = x.progress as Record<string, number>;
            return (
              <article key={String(x.userId)}>
                <header>
                  <span>
                    <b>{String(x.email)}</b>
                    <small>
                      {x.role === "manager"
                        ? "经理"
                        : x.role === "supervisor"
                          ? "主管"
                          : "员工"}
                    </small>
                  </span>
                  <em>
                    {x.assigned
                      ? "第 " +
                        String(x.rank) +
                        " 名 · " +
                        String(x.overallProgress) +
                        "%"
                      : "未设置目标"}
                  </em>
                </header>
                {[
                  ["新增客户", "newCustomers"],
                  ["月卡开通", "monthlyCards"],
                  ["季卡开通", "quarterlyCards"],
                  ["年卡开通", "annualCards"],
                ].map(([label, key]) => (
                  <div className="target-line" key={key}>
                    <span>
                      {label}
                      <b>
                        {actual[key]}/{goals[key]}
                      </b>
                    </span>
                    <div>
                      <i style={{ width: `${progress[key]}%` }} />
                    </div>
                    <small>{progress[key]}%</small>
                  </div>
                ))}
                {Boolean(x.note) && <p>{String(x.note)}</p>}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="admin-empty">当前权限范围内暂无团队成员或月度数据</div>
      )}
      <div className="admin-notice">
        经理可以给自己团队的主管、员工分配指标；主管查看自己及下属员工进度；分公司查看全分公司完成情况。上级只能查看自己的下属范围。
      </div>
    </div>
  );
}
function TeamTargetSummary({
  summary,
  count,
}: {
  summary: Record<string, number>;
  count: number;
}) {
  return (
    <div className="kpis target-summary">
      <Kpi
        n="团队成员"
        v={String(summary.visibleStaff || count)}
        s="当前可见范围"
      />
      <Kpi
        n="本月新增客户"
        v={String(summary.newCustomers || 0)}
        s="按注册时间"
      />
      <Kpi
        n="月卡 / 季卡"
        v={`${String(summary.monthlyCards || 0)} / ${String(summary.quarterlyCards || 0)}`}
        s="实际开通"
      />
      <Kpi n="年卡开通" v={String(summary.annualCards || 0)} s="实际开通" />
    </div>
  );
}
function CurrentMonthProgress() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    fetch("/api/team/monthly-targets")
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => setData(x as Record<string, unknown> | null))
      .catch(() => setData(null));
  }, []);
  if (!data) return null;
  const month = String(data.month || ""),
    summary = (data.summary || {}) as Record<string, number>,
    staff = (data.staff || []) as Array<Record<string, unknown>>,
    days = new Date(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0,
    ).getDate(),
    elapsed = Math.min(100, Math.round((new Date().getDate() / days) * 100)),
    assigned = staff.filter((x) => Boolean(x.assigned)),
    behind = assigned.filter(
      (x) => Number(x.overallProgress || 0) + 10 < elapsed,
    ).length;
  return (
    <section className="month-focus">
      <div className="widget-head">
        <b>{month} 月度任务进度</b>
        <span>时间进度 {elapsed}%</span>
      </div>
      <div className="focus-metrics">
        <span>
          <small>本月新增客户</small>
          <b>{String(summary.newCustomers || 0)}</b>
        </span>
        <span>
          <small>会员卡开通</small>
          <b>
            {String(
              (summary.monthlyCards || 0) +
                (summary.quarterlyCards || 0) +
                (summary.annualCards || 0),
            )}
          </b>
        </span>
        <span>
          <small>已设置目标</small>
          <b>{String(summary.assignedStaff || 0)}</b>
        </span>
        <span className={behind ? "warn" : ""}>
          <small>进度落后人员</small>
          <b>{String(behind)}</b>
        </span>
      </div>
      {behind > 0 && (
        <p>
          有 {behind}{" "}
          名成员的综合完成率低于本月时间进度10个百分点，建议经理或主管优先跟进。
        </p>
      )}
    </section>
  );
}
function TargetAlerts({
  month,
  alerts,
  onDone,
}: {
  month: string;
  alerts: Array<Record<string, unknown>>;
  onDone: (m: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  if (!alerts.length)
    return (
      <section className="target-alerts clear">
        <div>
          <b>待管理事项</b>
          <small>本月没有需要重点跟进的团队指标</small>
        </div>
        <em>正常</em>
      </section>
    );
  async function resolve(x: Record<string, unknown>) {
    const note = window.prompt("填写本次跟进情况") || "";
    if (!note.trim()) return;
    const r = await fetch("/api/team/monthly-targets/follow-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        month,
        subjectUserId: x.userId,
        alertType: x.type,
        note,
      }),
    });
    const d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
  }
  const visible = alerts.filter((x) => filter === "all" || x.type === filter);
  return (
    <section className="target-alerts">
      <div className="widget-head">
        <b>待管理事项 · {alerts.length}</b>
        <div className="alert-filters">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          <button
            className={filter === "target_missing" ? "active" : ""}
            onClick={() => setFilter("target_missing")}
          >
            未设目标
          </button>
          <button
            className={filter === "behind_schedule" ? "active" : ""}
            onClick={() => setFilter("behind_schedule")}
          >
            进度落后
          </button>
        </div>
      </div>
      {visible.map((x) => (
        <article key={`${String(x.userId)}-${String(x.type)}`}>
          <span>
            <b>{String(x.email)}</b>
            <small>{String(x.message)}</small>
          </span>
          <div className="alert-action">
            <em className={x.type === "target_missing" ? "missing" : "behind"}>
              {x.type === "target_missing" ? "待分配" : "需跟进"}
            </em>
            <button onClick={() => void resolve(x)}>记录跟进</button>
          </div>
        </article>
      ))}
    </section>
  );
}
function FollowUpHistory({
  month,
  onDone,
}: {
  month: string;
  onDone: (m: string) => void;
}) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]),
    [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/team/monthly-targets/follow-up?month=" + month)
      .then((r) => (r.ok ? r.json() : { followUps: [] }))
      .then((d) =>
        setRows((d.followUps || []) as Array<Record<string, unknown>>),
      )
      .catch(() => setRows([]));
  }, [month]);
  async function reopen(row: Record<string, unknown>) {
    const note = window.prompt("填写重新打开的原因") || "";
    if (!note.trim()) return;
    const r = await fetch("/api/team/monthly-targets/follow-up", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, note }),
    });
    const d = (await r.json()) as { error?: string; message?: string };
    onDone(d.message || d.error || "操作完成");
    if (r.ok)
      setRows(
        rows.map((x) => (x.id === row.id ? { ...x, status: "reopened" } : x)),
      );
  }
  return (
    <section className="follow-history">
      <button className="history-toggle" onClick={() => setOpen(!open)}>
        <span>
          跟进历史 <b>{rows.length}</b>
        </span>
        <em>{open ? "收起" : "展开"}</em>
      </button>
      {open &&
        (rows.length ? (
          <div>
            {rows.map((row) => (
              <article key={String(row.id)}>
                <span>
                  <b>{String(row.subjectEmail)}</b>
                  <small>
                    {row.alertType === "target_missing"
                      ? "未设置目标"
                      : "进度落后"}{" "}
                    · 处理人 {String(row.handledByEmail)}
                  </small>
                  <p>{String(row.note)}</p>
                </span>
                <div>
                  <time>{String(row.handledAt)}</time>
                  <em>{row.status === "resolved" ? "已处理" : "已重新打开"}</em>
                  {row.status === "resolved" && (
                    <button onClick={() => void reopen(row)}>重新打开</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="task-empty">本月暂无跟进历史</p>
        ))}
    </section>
  );
}
function DailyTeamBrief() {
  const [brief, setBrief] = useState<Record<string, unknown> | null>(null),
    [message, setMessage] = useState(""),
    [history, setHistory] = useState<Array<Record<string, unknown>>>([]),
    [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/team/daily-brief")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBrief(d as Record<string, unknown> | null))
      .catch(() => setBrief(null));
  }, []);
  async function queue() {
    const r = await fetch("/api/team/daily-brief", { method: "POST" }),
      d = (await r.json()) as { message?: string };
    setMessage(d.message || "生成失败");
  }
  async function historyLoad() {
    setOpen(!open);
    if (!open && !history.length) {
      const r = await fetch("/api/team/daily-brief", { method: "PUT" }),
        d = (await r.json()) as { deliveries?: Array<Record<string, unknown>> };
      setHistory(d.deliveries || []);
    }
  }
  if (!brief) return null;
  const s = (brief.summary || {}) as Record<string, number>;
  return (
    <section className="daily-brief">
      <div className="widget-head">
        <b>{String(brief.date)} 内部运营日报</b>
        <div>
          <button onClick={() => void historyLoad()}>
            {open ? "收起记录" : "发送记录"}
          </button>
          <button className="primary" onClick={() => void queue()}>
            生成今日日报
          </button>
        </div>
      </div>
      <div className="brief-items">
        <span>
          <small>催收</small>
          <b>{String(s.collections || 0)}</b>
        </span>
        <span>
          <small>停开仓</small>
          <b>{String(s.stopped || 0)}</b>
        </span>
        <span>
          <small>会员到期</small>
          <b>{String(s.expiring || 0)}</b>
        </span>
        <span>
          <small>未设目标</small>
          <b>{String(s.targetMissing || 0)}</b>
        </span>
        <span>
          <small>未平仓</small>
          <b>{String(s.openTrades || 0)}</b>
        </span>
      </div>
      {message && <p>{message}</p>}
      {open && (
        <div className="brief-history">
          {history.length ? (
            history.map((row) => (
              <span key={String(row.id)}>
                <b>{String(row.channel)}</b>
                <small>
                  {String(row.status)} · {String(row.createdAt)}
                </small>
              </span>
            ))
          ) : (
            <small>最近30天暂无发送记录</small>
          )}
        </div>
      )}
    </section>
  );
}
function NotificationCenter() {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Array<Record<string, unknown>>>([]),
    [unread, setUnread] = useState(0);
  async function load() {
    const r = await fetch("/api/notifications/inbox");
    if (!r.ok) return;
    const d = (await r.json()) as {
      unread?: number;
      notifications?: Array<Record<string, unknown>>;
    };
    setUnread(d.unread || 0);
    setRows(d.notifications || []);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  async function read(id?: string, all = false) {
    const r = await fetch("/api/notifications/inbox", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(all ? { all: true } : { id }),
    });
    if (r.ok) void load();
  }
  function title(row: Record<string, unknown>) {
    if (row.category === "team_daily_brief") return "内部运营日报";
    if (String(row.category).includes("collection")) return "账单催收提醒";
    if (String(row.category).includes("membership")) return "会员到期提醒";
    if (String(row.category).includes("security")) return "安全提醒";
    return "系统通知";
  }
  return (
    <div className="notification-center">
      <button
        className="bell"
        aria-label="通知中心"
        onClick={() => setOpen(!open)}
      >
        ◎{unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
      </button>
      {open && (
        <section>
          <header>
            <b>通知中心</b>
            <button
              disabled={!unread}
              onClick={() => void read(undefined, true)}
            >
              全部已读
            </button>
          </header>
          {rows.length ? (
            rows.map((row) => (
              <div
                className={`notification-row ${row.readAt ? "read" : ""}`}
                key={String(row.id)}
                role="button"
                tabIndex={0}
                onClick={() => !row.readAt && void read(String(row.id))}
                onKeyDown={(event) => {
                  if (!row.readAt && (event.key === "Enter" || event.key === " ")) void read(String(row.id));
                }}
              >
                <i />
                <div>
                  <b>{title(row)}</b>
                  <p>
                    {row.category === "team_daily_brief"
                      ? "今日团队运营数据已汇总，可进入运营后台查看详情。"
                      : String(row.templateKey).replaceAll("_", " ")}
                  </p>
                  <time>{String(row.createdAt)}</time>
                </div>
              </div>
            ))
          ) : (
            <p className="empty-notifications">暂无站内通知</p>
          )}
        </section>
      )}
    </div>
  );
}
function Kpi({ n, v, s }: { n: string; v: string; s: string }) {
  return (
    <div className="kpi">
      <small>{n}</small>
      <b>{v}</b>
      <span>{s}</span>
    </div>
  );
}
