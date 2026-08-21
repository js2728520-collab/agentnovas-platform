"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import type { AccountViewer } from "./account-settings";
import SupportFloating from "./support-floating";
import { dedupeAdjacentEnglish, scrubNonChineseText } from "./i18n-runtime";
import {
  tradingHallEnvironmentLabel,
  tradingHallStrategyPresentation,
} from "./trading-hall-status";
import { getAvatarPreset } from "@/lib/avatar-presets";
import {
  tradingHallAgentCatalog,
  type TradingHallPayload,
  type TradingHallStrategy,
} from "@/packages/contracts/src/trading-hall";

const pageModuleLoading = () => <div className="notice" role="status" aria-live="polite">正在加载工作区…</div>;
const AccountSettings = dynamic(() => import("./account-settings"), { loading: pageModuleLoading });
const LiveMarket = dynamic(() => import("./live-market"), { loading: pageModuleLoading });
const ClientNotificationSettings = dynamic(() => import("@/apps/client/ui/client-notification-settings"), { loading: pageModuleLoading });
const TradingCenterV2 = dynamic(() => import("./trading-center"), { loading: pageModuleLoading });
const MembershipCenter = dynamic(() => import("./membership-center"), { loading: pageModuleLoading });
const PersistentAgentChat = dynamic(() => import("./agent-chat"), { loading: pageModuleLoading });

type Page =
  | "home"
  | "login"
  | "trading"
  | "membership"
  | "hall"
  | "market"
  | "agent"
  | "meeting"
  | "security";
type ClientPlatformSettings = {
  system: {
    siteName: string;
    supportEmail: string;
    telegramSupportUrl: string;
    maintenanceBanner: string;
  };
};
const defaultClientPlatformSettings: ClientPlatformSettings = {
  system: {
    siteName: "Riverton Capital",
    supportEmail: "",
    telegramSupportUrl: "",
    maintenanceBanner: "",
  },
};
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
      className="market-widget agent-dialogue-widget"
      aria-label="Agent 工作记录"
    >
      <div className="widget-head">
        <b>Agent 工作记录</b>
        <span>DECISION LOG</span>
      </div>
      <div className="agent-dialogue-viewport">
        <div className="agent-dialogue-track">
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
          <Image src={avatarUrl} alt="" width={40} height={40} unoptimized />
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
    sub: "多位专业 Agent 分析市场、生成策略、相互质疑并管理风险；交易执行阶段目前仅生成影子或模拟回执，真实订单关闭。",
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
    sub: "多位專業 Agent 分析市場、生成策略、相互質疑並管理風險；交易執行階段目前僅生成影子或模擬回執，真實訂單關閉。",
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
    sub: "Specialized agents analyze markets, challenge proposals, and manage risk. Execution currently produces shadow or paper receipts only; real orders are off.",
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
    sub: "Агенты анализируют рынок, проверяют стратегии и управляют риском. Исполнение сейчас только теневое или симулированное; реальные ордера отключены.",
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
    sub: "Los agentes analizan el mercado, revisan estrategias y gestionan el riesgo. La ejecución es solo sombra o simulada; las órdenes reales están desactivadas.",
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
    sub: "専門Agentが市場分析、戦略生成、相互検証、リスク管理を行います。執行は現在シャドーまたは模擬回执のみで、実注文は無効です。",
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
    sub: "전문 Agent가 시장 분석, 전략 검증, 위험 관리를 수행합니다. 실행은 현재 섀도 또는 모의 영수증만 생성하며 실주문은 꺼져 있습니다.",
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
    trust1: "无需客户密钥",
    trust2: "权限隔离",
    trust3: "多层风控",
    trust4: "全程审计",
    flow1: "启动官方 paper 组合",
    flow1s: "客户无需上传交易所密钥",
    flow2: "选择风险偏好",
    flow2s: "设定不可突破的边界",
    flow3: "AI 团队协作",
    flow3s: "生成、质疑与审核方案",
    flow4: "生成模拟执行证据",
    flow4s: "Paper 回执与平台 Demo 分开记录",
    systemStatus: "Beta 执行边界",
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
    trust1: "無需客戶金鑰",
    trust2: "權限隔離",
    trust3: "多層風控",
    trust4: "全程審計",
    flow1: "啟動官方 paper 組合",
    flow1s: "客戶無需上傳交易所金鑰",
    flow2: "選擇風險偏好",
    flow2s: "設定不可突破的邊界",
    flow3: "AI 團隊協作",
    flow3s: "生成、質疑與審核方案",
    flow4: "生成模擬執行證據",
    flow4s: "Paper 回執與平台 Demo 分開記錄",
    systemStatus: "Beta 執行邊界",
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
    trust1: "No customer credentials",
    trust2: "Permission isolation",
    trust3: "Layered risk control",
    trust4: "Full audit trail",
    flow1: "Start an official paper portfolio",
    flow1s: "No customer exchange credentials required",
    flow2: "Choose risk profile",
    flow2s: "Set hard safety boundaries",
    flow3: "AI team collaboration",
    flow3s: "Generate, challenge and review",
    flow4: "Produce simulation evidence",
    flow4s: "Paper and platform Demo receipts stay separate",
    systemStatus: "Beta execution boundary",
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
    trust1: "Без ключей клиента",
    trust2: "Изоляция прав",
    trust3: "Многоуровневый риск-контроль",
    trust4: "Полный аудит",
    flow1: "Запустить официальный paper-портфель",
    flow1s: "Ключи биржи клиента не требуются",
    flow2: "Выбрать профиль риска",
    flow2s: "Установить жёсткие границы",
    flow3: "Работа команды ИИ",
    flow3s: "Создание, критика и проверка",
    flow4: "Сформировать доказательство симуляции",
    flow4s: "Paper и Demo платформы записываются отдельно",
    systemStatus: "Граница исполнения Beta",
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
    trust1: "Sin credenciales del cliente",
    trust2: "Permisos aislados",
    trust3: "Control de riesgo multicapa",
    trust4: "Auditoría completa",
    flow1: "Iniciar un portafolio paper oficial",
    flow1s: "No se requieren claves del exchange del cliente",
    flow2: "Elegir perfil de riesgo",
    flow2s: "Definir límites inviolables",
    flow3: "Colaboración del equipo IA",
    flow3s: "Generar, cuestionar y revisar",
    flow4: "Generar evidencia simulada",
    flow4s: "Paper y Demo de plataforma se registran por separado",
    systemStatus: "Límite de ejecución Beta",
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
    trust1: "顧客キー不要",
    trust2: "権限を分離",
    trust3: "多層リスク管理",
    trust4: "完全監査",
    flow1: "公式 paper ポートフォリオを開始",
    flow1s: "顧客の取引所キーは不要",
    flow2: "リスク設定",
    flow2s: "越えられない境界を設定",
    flow3: "AIチーム連携",
    flow3s: "生成・反証・審査",
    flow4: "模擬執行証跡を生成",
    flow4s: "Paper とプラットフォーム Demo を分離記録",
    systemStatus: "Beta 執行境界",
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
    trust1: "고객 거래소 키 불필요",
    trust2: "권한 분리",
    trust3: "다층 리스크 관리",
    trust4: "전체 감사",
    flow1: "공식 paper 포트폴리오 시작",
    flow1s: "고객 거래소 키 불필요",
    flow2: "위험 성향 선택",
    flow2s: "넘을 수 없는 한도 설정",
    flow3: "AI 팀 협업",
    flow3s: "생성·반론·검토",
    flow4: "모의 실행 증거 생성",
    flow4s: "Paper와 플랫폼 Demo를 분리 기록",
    systemStatus: "Beta 실행 경계",
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
      "市|市场分析师|识别当前市场状态;技|技术分析师|验证具体交易信号;策|策略研究员|生成候选策略方案;反|反方审查员|寻找漏洞与反向证据;险|首席风控官|执行硬风险审批;决|AI 决策官|形成最终决策单;执|交易执行员|生成影子或模拟执行回执",
    visibleTitle: "每一次决策，都看得见",
    visible:
      "实时协作|查看 Agent 的观点、异议、修正和最终决定。;动态风控|市场变化时自动降低 paper 仓位或暂停策略。;完整审计|策略信号、风控批准、paper 回执和平台 Demo 证据分开记录。",
    review: "风险复核中",
    enterHall: "进入实时交易大厅",
    safetyTitle: "AI负责适应，硬风控守住底线",
    safety:
      "无需客户密钥|Beta 使用公共行情和服务端 paper 组合。;本金隔离|每张官方策略拥有独立的 10,000 USDT 模拟本金。;现货边界|仅 BTC、ETH、SOL 的 USDT 现货模拟，无杠杆和做空。;组合级熔断|达到日亏损或回撤限制立即停止新开仓。;异常安全|数据延迟、模型超时或格式异常时不生成 paper 成交。;证据隔离|平台 Demo 回执不影响客户 paper 收益或结算。",
    exchangeTitle: "平台测试环境验证",
    exchangeDesc:
      "OKX Demo、Binance Spot Testnet 与 Bybit Demo 仅验证平台策略信号；客户无需连接账户，也不会产生真实成交。",
    launch: "首发",
    access: "接入",
    planned: "规划",
    connectWays: "查看 paper 组合",
    faqTitle: "你可能关心的问题",
    faq: "需要连接交易所吗？|不需要。Beta 不接收客户交易所密钥。;AI会发送真实订单吗？|不会。客户侧仅生成受风控约束的 paper 回执。;现在展示的收益真实吗？|不是。paper 收益不代表真实或未来收益。;平台 Demo 回执是什么？|它只证明信号可在隔离测试环境验证，不影响客户组合。",
    ctaTitle: "进入AI量化团队的实时工作现场",
    ctaSub: "从三张官方现货策略开始体验 10,000 USDT 独立 paper 组合。",
    browse: "浏览AI策略",
    footer: "受邀 Beta · 客户 paper 与平台测试证据不代表真实或未来收益",
    legal: "风险披露　隐私政策　服务条款",
  },
  "zh-TW": {
    roles:
      "市|市場分析師|識別當前市場狀態;技|技術分析師|驗證具體交易訊號;策|策略研究員|生成候選策略方案;反|反方審查員|尋找漏洞與反向證據;險|首席風控官|執行硬風險審批;決|AI 決策官|形成最終決策單;執|交易執行員|生成影子或模擬執行回執",
    visibleTitle: "每一次決策，都看得見",
    visible:
      "即時協作|查看 Agent 的觀點、異議、修正與最終決定。;動態風控|市場變化時降低 paper 倉位或暫停策略。;完整審計|策略訊號、paper 回執與平台 Demo 證據分開記錄。",
    review: "風險複核中",
    enterHall: "進入即時交易大廳",
    safetyTitle: "AI負責適應，硬風控守住底線",
    safety:
      "無需客戶金鑰|Beta 使用公共行情與服務端 paper 組合。;本金隔離|每張官方策略有獨立 10,000 USDT 模擬本金。;現貨邊界|僅 BTC、ETH、SOL 的 USDT 現貨模擬，無槓桿與做空。;組合級熔斷|達到虧損或回撤限制即停止新開倉。;異常安全|資料延遲或模型異常時不生成 paper 成交。;證據隔離|平台 Demo 回執不影響客戶 paper 收益或結算。",
    exchangeTitle: "平台測試環境驗證",
    exchangeDesc: "三個平台測試環境僅驗證策略訊號；客戶無需連接帳戶，也不會產生真實成交。",
    launch: "首發",
    access: "接入",
    planned: "規劃",
    connectWays: "查看 paper 組合",
    faqTitle: "你可能關心的問題",
    faq: "需要連接交易所嗎？|不需要。Beta 不接收客戶交易所金鑰。;AI會發送真實訂單嗎？|不會。客戶側僅生成 paper 回執。;收益是真實的嗎？|不是。paper 收益不代表真實或未來收益。;平台 Demo 回執是什麼？|只證明訊號可在隔離測試環境驗證。",
    ctaTitle: "進入AI量化團隊的即時工作現場",
    ctaSub: "從三張官方現貨策略開始體驗獨立 paper 組合。",
    browse: "瀏覽AI策略",
    footer: "受邀 Beta · 客戶 paper 與平台測試證據不代表真實或未來收益",
    legal: "風險披露　隱私政策　服務條款",
  },
  "en-US": {
    roles:
      "M|Market Analyst|Classifies the current market;T|Technical Analyst|Validates concrete signals;S|Strategy Researcher|Builds a candidate plan;C|Adversarial Reviewer|Finds flaws and contrary evidence;R|Chief Risk Officer|Applies hard risk approval;D|AI Decision Officer|Issues the final decision;E|Execution Agent|Produces a shadow or paper receipt",
    visibleTitle: "Every decision is visible",
    visible:
      "Live collaboration|See Agent views, objections, revisions and final decisions.;Dynamic risk control|Reduce paper exposure or pause as markets change.;Complete audit|Keep paper receipts separate from platform Demo evidence.",
    review: "Risk review in progress",
    enterHall: "Enter live Trading Hall",
    safetyTitle: "AI adapts. Hard controls protect the boundary.",
    safety:
      "No customer credentials|Beta uses public market data and server-managed paper portfolios.;Isolated principal|Each official card receives a separate 10,000 USDT paper balance.;Spot only|BTC, ETH and SOL against USDT, with no leverage or shorting.;Portfolio circuit breaker|Stop new entries at loss or drawdown limits.;Fail safe|No paper fill on stale data, timeout or malformed output.;Separated evidence|Platform Demo receipts never change customer paper performance or settlement.",
    exchangeTitle: "Platform test-environment evidence",
    exchangeDesc:
      "OKX Demo, Binance Spot Testnet and Bybit Demo validate platform signals only. Customers do not connect accounts and no live trade is placed.",
    launch: "Launch",
    access: "Available",
    planned: "Planned",
    connectWays: "View paper portfolios",
    faqTitle: "Common questions",
    faq: "Must I connect an exchange?|No. Beta does not accept customer exchange credentials.;Will AI place live orders?|No. Customer activity is limited to risk-controlled paper receipts.;Are the returns real?|No. Paper performance is not actual or future performance.;What is a platform Demo receipt?|It only proves a signal was tested in an isolated provider environment.",
    ctaTitle: "Enter the AI quant team’s live workspace",
    ctaSub:
      "Explore three official spot strategies through isolated paper portfolios.",
    browse: "Browse AI strategies",
    footer:
      "Invite-only Beta · Customer paper and platform test evidence are not actual or future returns",
    legal: "Risk Disclosure　Privacy　Terms",
  },
  "ru-RU": {
    roles:
      "Р|Рыночный аналитик|Определяет состояние рынка;Т|Технический аналитик|Проверяет конкретные сигналы;С|Исследователь стратегий|Формирует кандидатный план;О|Оппонент|Ищет ошибки и обратные доказательства;Р|Риск-директор|Применяет жёсткие лимиты;Д|AI-директор решений|Принимает итоговое решение;И|Агент исполнения|Формирует квитанцию симуляции",
    visibleTitle: "Каждое решение прозрачно",
    visible:
      "Совместная работа|Мнения, возражения, правки и итог агентов.;Динамический риск|Снижение paper-позиции или остановка стратегии.;Полный аудит|Paper-квитанции отделены от доказательств платформы Demo.",
    review: "Проверка риска",
    enterHall: "Открыть торговый зал",
    safetyTitle: "ИИ адаптируется, жёсткий контроль защищает",
    safety:
      "Без ключей клиента|Beta использует публичный рынок и серверные paper-портфели.;Раздельный капитал|Каждая стратегия получает 10 000 USDT paper.;Только spot|BTC, ETH и SOL без плеча и шорта.;Автостоп|Новые входы блокируются при лимите потерь.;Безопасный отказ|При ошибке paper-сделка не создаётся.;Раздельные доказательства|Demo платформы не меняет доходность клиента.",
    exchangeTitle: "Проверка в тестовой среде платформы",
    exchangeDesc:
      "Три тестовые среды проверяют только сигналы платформы; клиент не подключает счёт, реальных сделок нет.",
    launch: "Запуск",
    access: "Доступно",
    planned: "План",
    connectWays: "Paper-портфели",
    faqTitle: "Частые вопросы",
    faq: "Нужно подключать биржу?|Нет, Beta не принимает ключи клиентов.;Есть реальные ордера?|Нет, только paper-квитанции.;Доходность реальна?|Нет, paper-результат не является фактическим или будущим.;Что такое Demo-квитанция?|Это отдельное доказательство тестирования сигнала платформой.",
    ctaTitle: "Откройте рабочее пространство ИИ-команды",
    ctaSub: "Изучите три официальные spot-стратегии в paper-портфелях.",
    browse: "Стратегии ИИ",
    footer: "Закрытая Beta · Paper и тестовые доказательства не являются фактической или будущей доходностью",
    legal: "Риски　Конфиденциальность　Условия",
  },
  "es-ES": {
    roles:
      "M|Analista de mercado|Clasifica el estado del mercado;T|Analista técnico|Valida señales concretas;E|Investigador de estrategias|Formula un plan candidato;C|Revisor adversarial|Busca fallos y evidencia contraria;R|Director de riesgo|Aplica límites estrictos;D|Director de decisión IA|Emite la decisión final;E|Agente de ejecución|Genera un recibo simulado",
    visibleTitle: "Cada decisión es visible",
    visible:
      "Colaboración en vivo|Consulta opiniones, objeciones, cambios y decisiones.;Riesgo dinámico|Reduce exposición paper o pausa estrategias.;Auditoría completa|Separa recibos paper de la evidencia Demo de la plataforma.",
    review: "Revisión de riesgo",
    enterHall: "Entrar a la sala en vivo",
    safetyTitle: "La IA se adapta; los controles protegen",
    safety:
      "Sin credenciales del cliente|Beta usa mercado público y portafolios paper del servidor.;Capital aislado|Cada estrategia recibe 10.000 USDT paper.;Solo spot|BTC, ETH y SOL sin apalancamiento ni cortos.;Cortacircuitos|Detiene nuevas entradas al alcanzar límites.;Fallo seguro|No genera fills paper ante errores.;Evidencia separada|Demo de plataforma no cambia el rendimiento del cliente.",
    exchangeTitle: "Evidencia en entornos de prueba",
    exchangeDesc:
      "Tres entornos de prueba validan señales de la plataforma; el cliente no conecta cuentas ni genera operaciones reales.",
    launch: "Inicial",
    access: "Disponible",
    planned: "Planificado",
    connectWays: "Ver portafolios paper",
    faqTitle: "Preguntas frecuentes",
    faq: "¿Debo conectar un exchange?|No, Beta no acepta claves del cliente.;¿Hay órdenes reales?|No, solo recibos paper con control de riesgo.;¿El rendimiento es real?|No, paper no representa resultados reales o futuros.;¿Qué prueba Demo?|Solo valida una señal en un entorno aislado.",
    ctaTitle: "Entra al espacio de trabajo del equipo IA",
    ctaSub: "Explora tres estrategias spot oficiales con portafolios paper aislados.",
    browse: "Ver estrategias IA",
    footer: "Beta por invitación · Paper y pruebas de plataforma no son rendimientos reales ni futuros",
    legal: "Riesgos　Privacidad　Términos",
  },
  "ja-JP": {
    roles:
      "市|市場アナリスト|現在の市場状態を分類;技|テクニカルアナリスト|具体的なシグナルを検証;策|戦略研究員|候補戦略を作成;反|反証審査員|欠陥と反対証拠を探索;リ|最高リスク責任者|ハードリスクを審査;決|AI意思決定官|最終判断を作成;執|執行Agent|シャドーまたは模擬回执を生成",
    visibleTitle: "すべての意思決定を可視化",
    visible:
      "リアルタイム連携|Agentの見解・異議・修正・最終判断を表示。;動的リスク管理|市場変化に応じて paper ポジションを削減。;完全監査|paper 回执とプラットフォーム Demo 証跡を分離。",
    review: "リスク審査中",
    enterHall: "リアルタイム取引ホールへ",
    safetyTitle: "AIが適応し、ハード制御が守る",
    safety:
      "顧客キー不要|Beta は公開市場データとサーバー paper を使用。;元本分離|公式戦略ごとに 10,000 USDT paper。;現物のみ|BTC・ETH・SOL、レバレッジとショートなし。;サーキットブレーカー|損失限度で新規建て停止。;安全な失敗|異常時は paper 約定を生成しない。;証跡分離|平台 Demo は顧客損益に影響しない。",
    exchangeTitle: "プラットフォーム試験環境の証跡",
    exchangeDesc: "3つの試験環境は平台シグナルのみ検証し、顧客口座接続や実取引はありません。",
    launch: "初期",
    access: "対応",
    planned: "予定",
    connectWays: "paper ポートフォリオ",
    faqTitle: "よくある質問",
    faq: "取引所接続は必要ですか？|いいえ、Beta は顧客キーを受け取りません。;実注文はありますか？|いいえ、paper 回执のみです。;収益は実績ですか？|いいえ、実績や将来収益を示しません。;Demo 証跡とは？|分離された試験環境でのシグナル検証です。",
    ctaTitle: "AIクオンツチームの現場へ",
    ctaSub: "3つの公式現物戦略を独立 paper で体験。",
    browse: "AI戦略を見る",
    footer: "招待制 Beta · Paper とプラットフォーム試験証跡は実績や将来収益ではありません",
    legal: "リスク開示　プライバシー　利用規約",
  },
  "ko-KR": {
    roles:
      "시|시장 분석가|현재 시장 상태 분류;기|기술 분석가|구체적 신호 검증;전|전략 연구원|후보 전략 수립;반|반론 검토자|허점과 반대 증거 탐색;리|최고 리스크 책임자|하드 리스크 승인;결|AI 의사결정관|최종 결정 작성;실|거래 실행 Agent|섀도 또는 모의 실행 영수증 생성",
    visibleTitle: "모든 의사결정을 투명하게",
    visible:
      "실시간 협업|Agent 의견·이의·수정·최종 결정을 확인합니다.;동적 위험 관리|시장 변화 시 paper 포지션을 축소합니다.;완전한 감사|paper 영수증과 플랫폼 Demo 증거를 분리합니다.",
    review: "리스크 재검토 중",
    enterHall: "실시간 트레이딩 홀 입장",
    safetyTitle: "AI는 적응하고, 하드 리스크는 지킵니다",
    safety:
      "고객 키 불필요|Beta는 공개 시세와 서버 paper를 사용합니다.;원금 분리|공식 전략마다 10,000 USDT paper.;현물 전용|BTC·ETH·SOL, 레버리지와 공매도 없음.;포트폴리오 차단|손실 한도 시 신규 진입 중지.;안전한 실패|오류 시 paper 체결을 만들지 않음.;증거 분리|플랫폼 Demo는 고객 수익에 영향 없음.",
    exchangeTitle: "플랫폼 테스트 환경 증거",
    exchangeDesc: "세 테스트 환경은 플랫폼 신호만 검증하며 고객 계정 연결이나 실거래는 없습니다.",
    launch: "우선",
    access: "지원",
    planned: "예정",
    connectWays: "paper 포트폴리오 보기",
    faqTitle: "자주 묻는 질문",
    faq: "거래소 연결이 필요한가요?|아니요, Beta는 고객 키를 받지 않습니다.;실제 주문이 있나요?|아니요, 위험 통제된 paper 영수증만 있습니다.;수익이 실제인가요?|아니요, 실제 또는 미래 수익을 의미하지 않습니다.;Demo 증거란?|격리된 테스트 환경의 신호 검증입니다.",
    ctaTitle: "AI 퀀트 팀의 실시간 작업 현장",
    ctaSub: "세 가지 공식 현물 전략을 독립 paper 포트폴리오로 체험하세요.",
    browse: "AI 전략 보기",
    footer: "초대 전용 Beta · Paper와 플랫폼 테스트 증거는 실제 또는 미래 수익이 아닙니다",
    legal: "위험 고지　개인정보　이용약관",
  },
};

const nav: [Page, string, string][] = [
  ["home", "home", "⌂"],
  ["hall", "hall", "◉"],
  ["agent", "agent", "◎"],
  ["market", "marketNav", "⌁"],
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

export default function Home({ canViewMembership = true }: { canViewMembership?: boolean }) {
  const [page, setPage] = useState<Page>(() => {
    if (typeof window === "undefined") return "hall";
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
    return "hall";
  });
  const [lang, setLang] = useState<Lang>("zh-CN");
  const [selectedAgent, setSelectedAgent] = useState("Chief Risk Officer");
  const [viewer, setViewer] = useState<AccountViewer | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [platformSettings, setPlatformSettings] = useState<ClientPlatformSettings>(defaultClientPlatformSettings);
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
    let active = true;
    fetch("/api/platform/settings", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload: ClientPlatformSettings | null) => {
        if (active && payload?.system) setPlatformSettings(payload);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
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
    if (p === "membership" && !canViewMembership) return;
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
  const memberButton = canViewMembership ? membershipAction(t, viewer?.membership) : null;
  const visiblePage: Page = !authResolved
    ? "home"
    : page !== "home" && page !== "login" && !viewer
      ? "login"
      : page;
  return (
    <main className="app-shell client-app-shell" data-app-shell>
      <header className="topbar">
        <Link className="logo" href="/" aria-label="返回客户工作台">
          <span>A</span>
          <b>
            {platformSettings.system.siteName || "Riverton Capital"}<small>{t.tagline}</small>
          </b>
        </Link>
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
      {platformSettings.system.maintenanceBanner && <div className="platform-maintenance-banner" role="status" aria-live="polite">{platformSettings.system.maintenanceBanner}</div>}
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
          canViewMembership={canViewMembership}
          onOpenSettings={() => setAccountSettingsOpen(true)}
        />
      )}
      <SupportFloating lang={lang} telegramUrl={platformSettings.system.telegramSupportUrl} supportEmail={platformSettings.system.supportEmail} />
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
            <button className="ghost" onClick={() => go("hall")}>
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
            DECISION
            <br />
            <b>AI FINAL</b>
          </div>
        </div>
      </section>
      {/* This named scroll region must be keyboard-focusable at narrow widths; axe verifies the behavior. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <section className="flow" tabIndex={0} aria-label="四阶段产品流程，可横向滚动">
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
          <h2>7 AGENT DECISION CHAIN</h2>
          <p>BTC / ETH / SOL · USDT SPOT TARGET · REAL ORDERS OFF</p>
          <button onClick={() => go("hall")}>{t.watch} →</button>
        </div>
        <div className="panel metric-panel">
          <div>
            <small>{t.market}</small>
            <strong>BTC / ETH / SOL</strong>
          </div>
          <div>
            <small>{t.riskIndex}</small>
            <strong>HARD LIMITS</strong>
          </div>
          <div>
            <small>{t.decision}</small>
            <strong>SIMULATION ONLY</strong>
          </div>
          <div>
            <small>{t.accountStatus}</small>
            <strong className="green">NON-CUSTODIAL</strong>
          </div>
        </div>
      </section>
      <section className="home-ticker">
        {["BTC", "ETH", "SOL"].map((symbol) => (
          <button key={symbol} onClick={() => go("market")}>
            <b>{symbol}/USDT</b>
            <span>SPOT TARGET</span>
            <em>NO STATIC QUOTE</em>
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
              <span>ROLE CONTRACT · 0{i + 1}</span>
            </article>
          ))}
        </div>
      </section>
      <section className="feature-split">
        <div className="scene-preview">
          <Image
            src="/trading-hall.webp"
            width={1672}
            height={941}
            sizes="(max-width: 768px) 100vw, 55vw"
            alt="AI quantitative trading operations center"
          />
          <div>
            <span>
              <i />
              PRODUCT PREVIEW
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
          <small>PLATFORM DEMO EVIDENCE</small>
          <h2>{m.exchangeTitle}</h2>
          <p>{m.exchangeDesc}</p>
        </div>
        <div className="exchange-logos" aria-label="平台隔离的测试环境">
          {["OKX Demo", "Binance Spot Testnet", "Bybit Demo"].map((name) => (
            <div className="exchange-logo-card" key={name}><b>{name}</b><small>平台测试账户</small></div>
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
          <button className="ghost" onClick={() => go("hall")}>
            {m.browse}
          </button>
        </div>
      </section>
      <footer>
        <div className="landing-footer-main">
          <b className="landing-footer-mark">Riverton Capital</b>
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
  canViewMembership,
  onOpenSettings,
}: {
  page: Page;
  t: Record<string, string>;
  go: (p: Page) => void;
  viewer: AccountViewer | null;
  selectedAgent: string;
  setSelectedAgent: (s: string) => void;
  canViewMembership: boolean;
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
        {nav.slice(1).filter(([p]) => p !== "membership" || canViewMembership).map(([p, k, icon]) => (
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
        <Link className="client-stable-link" href="/wallet"><i>◫</i><span>{t._lang === "zh-CN" || t._lang === "zh-TW" ? "钱包与账本" : "Wallet"}</span></Link>
        <Link className="client-stable-link" href="/notifications"><i>◌</i><span>{t._lang === "zh-CN" || t._lang === "zh-TW" ? "通知中心" : "Notifications"}</span></Link>
        <div className="aside-bottom">
          <span>
            <i />
            真实订单关闭
          </span>
          <small>状态以交易大厅真实记录为准</small>
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
    case "membership":
      return <MembershipCenter />;
    case "agent":
      return (
        <PersistentAgentChat
          title={
            t._lang === "zh-CN" || t._lang === "zh-TW" ? "Agent 对话" : t.agent
          }
          onOpenStrategies={() => go("hall")}
        />
      );
    case "meeting":
      return <Meeting go={go} />;
    case "trading":
      return <TradingCenterV2 go={go} />;
    case "security":
      return <Security t={t} />;
    default:
      return <Hall t={t} go={go} setSelected={setSelected} />;
  }
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
function Hall({
  t,
  go,
  setSelected,
}: {
  t: Record<string, string>;
  go: (p: Page) => void;
  setSelected: (s: string) => void;
}) {
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
        title={t.hall}
        sub="七角色顺序决策链 · 三张官方策略卡 · 每 5 秒同步"
        actions={
          <>
            <button className="soft" onClick={() => go("meeting")}>
              进入会议室
            </button>
            <button className="soft" onClick={() => go("trading")}>
              风险与交易控制
            </button>
          </>
        }
      />
      <div className="hall-stats" aria-label="交易大厅产品边界">
        <span>
          <i className="pulse" />
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
      <div className="hall-load-state" aria-live="polite">
        {loading && !data && <span>正在读取交易大厅真实记录…</span>}
        {error && <span role="alert">{error} <button type="button" onClick={retry}>重试</button></span>}
        {!loading && !error && data && data.decisionRounds.length === 0 && <span>当前没有决策轮记录；系统不会用演示数据填充。</span>}
        {data && data.legacyAuditRecords > 0 && <span>检测到 {data.legacyAuditRecords} 条旧周期审计记录；旧记录缺少独立 AI 最终决策阶段，已明确标记。</span>}
      </div>
      <p className="hall-role-illustration-note" role="note">
        角色位置仅为界面示意，不代表智能体正在运行；状态以服务端策略与决策记录为准。
      </p>
      <div className="compact-hall">
        <div className="hall-left">
          <div className="scene compact">
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
                className="hotspot hall-role-static"
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                onClick={() => {
                  setSelected(a.n);
                  go("agent");
                }}
              >
                <span className="hall-operator" aria-hidden="true" />
                <i />
                <b>{a.n}</b>
                <small>{statusFor(a.n)}</small>
                <span className="speech">
                  {talkFor(a.n)}
                  <em>•••</em>
                </span>
              </button>
            ))}
            <button className="meeting-hotspot hall-role-static" onClick={() => go("meeting")}>
              <span>AI 决策官</span>
              <small>{data?.agents.find((agent) => agent.key === "final_decision")?.status === "reported" ? "已提交决策" : "等待记录"}</small>
              <b className="meeting-speech">
                {meetingTalk}
                <em>•••</em>
              </b>
            </button>
          </div>
          <StrategyMonitorTicker strategies={data?.strategies || []} loading={loading} />
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
  loading = false,
}: {
  strategies?: TradingHallStrategy[];
  loading?: boolean;
}) {
  const [paused, setPaused] = useState(false);
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
    <div className={`strategy-monitor-ticker${paused ? " paused" : ""}`} aria-label="三套AI策略服务端状态">
      <div className="strategy-monitor-track">
        {rows.length === 0 && (
          <article className="strategy-monitor-empty">
            <span className="strategy-monitor-dot" />
            <div>
              <small>官方策略卡</small>
              <b>{loading ? "正在读取真实策略状态" : "当前没有策略部署记录"}</b>
            </div>
          </article>
        )}
        {rows.map((row, i) => (
          <article key={row.name} aria-label={`${row.name}：${row.state}`}>
            <span className={`strategy-monitor-dot s${i}${row.inactive ? " inactive" : ""}`} />
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
      <div className="strategy-monitor-pages">
        <i />
        <i />
        <i />
      </div>
      {rows.length > 1 && (
        <button
          className="strategy-monitor-pause"
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? "继续轮播" : "暂停轮播"}
        </button>
      )}
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
        {actions}
      </div>
    </div>
  );
}
function Meeting({ go }: { go: (page: Page) => void }) {
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
          ? `决策轮 ${selectedRound.decisionRoundId} · ${selectedRound.strategyName} · ${selectedRound.symbol}`
          : "读取真实决策轮；没有记录时不会显示演示会议"}
        actions={
          <>
            <button className="soft" onClick={() => go("hall")}>返回交易大厅</button>
            <button
              className="soft"
              onClick={() => setAuditOpen((open) => !open)}
              aria-expanded={auditOpen}
              disabled={!selectedRound}
            >
              {auditOpen ? "收起审计记录" : "查看审计记录"}
            </button>
          </>
        }
      />
      <div className="meeting-load-state" aria-live="polite">
        {loading && !data && <span>正在读取决策轮…</span>}
        {error && <span role="alert">{error} <button type="button" onClick={retry}>重试</button></span>}
        {!loading && !error && data?.decisionRounds.length === 0 && <span>当前没有可展示的决策轮。</span>}
      </div>
      {data && data.decisionRounds.length > 1 && (
        <label className="meeting-round-picker">
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
        <div className="meeting-grid">
          <section className="roundtable" aria-label="七智能体决策顺序">
            <div className="table-core">
              <b>{selectedRound.symbol.replace("USDT", "")}</b>
              <span>{selectedRound.status}</span>
            </div>
            {tradingHallAgentCatalog.map((agent, index) => {
              const event = eventFor(agent.key);
              return (
                <div className={`seat seat${index}`} key={agent.key}>
                  <i>{agent.sequence}</i>
                  <b>{agent.name}</b>
                  <small>{event ? "已记录" : "缺少记录"}</small>
                </div>
              );
            })}
          </section>
          <section className="transcript">
            <h3>
              七阶段公开记录 <span>{selectedRound.completeness.toUpperCase()}</span>
            </h3>
            {tradingHallAgentCatalog.map((agent) => {
              const event = eventFor(agent.key);
              return (
                <div className="line" key={agent.key}>
                  <i className={event ? "" : "warn"} />
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
        <section className="meeting-audit-panel">
          <header>
            <div>
              <small>AUDIT TRAIL</small>
              <h3>会议审计详情</h3>
            </div>
            <span>已记录 {selectedRound.events.length} 项</span>
          </header>
          <div className="meeting-audit-grid">
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
        <section className="final-card">
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
              <dd className="green">关闭</dd>
            </div>
          </dl>
          <p>硬风控优先于任何 Agent 意见。影子/模拟订单意图不代表客户交易所真实成交。</p>
        </section>
      )}
    </>
  );
}
function Security({ t }: { t: Record<string, string> }) {
  return (
    <div className="security-center-page">
      <PageHead title={t.security} sub="设置通知渠道与接收偏好" />
      <ClientNotificationSettings />
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
    registerLead: "使用邀请码加入 Riverton Capital 智能交易平台",
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
    registerLead: "使用邀請碼加入 Riverton Capital 智能交易平台",
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
    registerLead: "Join Riverton Capital with your invitation code",
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
    noAccount: "New to Riverton Capital?",
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
    registerLead: "Присоединитесь к Riverton Capital по коду приглашения",
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
    registerLead: "Únete a Riverton Capital con tu código de invitación",
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
    registerLead: "招待コードでRiverton Capitalに参加",
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
    registerLead: "초대 코드로 Riverton Capital에 참여하세요",
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
              <b>Riverton Capital</b>
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
              <button type="button" className="auth-link" onClick={() => window.location.assign("/login?mode=forgot")}>
                {copy.forgot}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
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
    if (row.category === "team_daily_brief") return "系统摘要";
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
                      ? "今日团队数据已汇总，可在通知详情中核对。"
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
