"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";

import styles from "./client-public-landing.module.css";
import Link from "next/link";

type Page = "home" | "login" | "hall" | "market" | "trading";

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

type LocaleData = {
  text: Record<string, string>;
  extraText: Record<string, string>;
  landingMore: Record<string, string>;
};

const initialLocaleData: LocaleData = {
  text: {
    strategy: "策略广场",
    risk: "风险设置",
    login: "登录",
    hero: "一支为你工作的 AI 量化团队",
    sub: "多位专业 Agent 分析市场、生成策略、相互质疑并管理风险；交易执行阶段目前仅生成影子或模拟回执，真实订单关闭。",
    enter: "进入交易大厅",
    demo: "查看策略方案",
    market: "市场状态",
    decision: "当前决策",
  },
  extraText: {
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
    watch: "观看工作现场",
    riskIndex: "AI 风险指数",
    accountStatus: "账户状态",
    teamTitle: "不是一个机器人，而是一支专业团队",
    teamSub: "每位 Agent 独立判断、交叉质疑，最终由风控与确定性规则共同决定是否执行。",
  },
  landingMore: {
    roles: "市|市场分析师|识别当前市场状态;技|技术分析师|验证具体交易信号;策|策略研究员|生成候选策略方案;反|反方审查员|寻找漏洞与反向证据;险|首席风控官|执行硬风险审批;决|AI 决策官|形成最终决策单;执|交易执行员|生成影子或模拟执行回执",
    // 注意：这是 zh-CN 内容的第二份真源（首屏内联，避免加载整个语言包）。
    // 改文案要同时改 client-public-landing-locales.ts，否则中文与其它语言会不一致。
    gateNote: "第 5 阶段由确定性代码执行，不是模型。它可以否决前面全部 AI 结论；数据不足或风控不可用时，不产生新开仓。",
    visibleTitle: "每一次决策，都看得见",
    visible: "实时协作|查看 Agent 的观点、异议、修正和最终决定。;动态风控|市场变化时自动降低 paper 仓位或暂停策略。;完整审计|策略信号、风控批准、paper 回执和平台 Demo 证据分开记录。",
    review: "风险复核中",
    enterHall: "进入实时交易大厅",
    safetyTitle: "AI负责适应，硬风控守住底线",
    safety: "无需客户密钥|Beta 使用公共行情和服务端 paper 组合。;本金隔离|每张官方策略拥有独立的 10,000 USDT 模拟本金。;现货边界|仅 BTC、ETH、SOL 的 USDT 现货模拟，无杠杆和做空。;组合级熔断|达到日亏损或回撤限制立即停止新开仓。;异常安全|数据延迟、模型超时或格式异常时不生成 paper 成交。;证据隔离|平台 Demo 回执不影响客户 paper 收益或结算。",
    exchangeTitle: "平台测试环境验证",
    exchangeDesc: "OKX Demo、Binance Spot Testnet 与 Bybit Demo 仅验证平台策略信号；客户无需连接账户，也不会产生真实成交。",
    connectWays: "查看 paper 组合",
    faqTitle: "你可能关心的问题",
    faq: "需要连接交易所吗？|不需要。Beta 不接收客户交易所密钥。;AI会发送真实订单吗？|不会。客户侧仅生成受风控约束的 paper 回执。;现在展示的收益真实吗？|不是。paper 收益不代表真实或未来收益。;平台 Demo 回执是什么？|它只证明信号可在隔离测试环境验证，不影响客户组合。",
    ctaTitle: "进入AI量化团队的实时工作现场",
    ctaSub: "从三张官方现货策略开始体验 10,000 USDT 独立 paper 组合。",
    browse: "浏览AI策略",
    footer: "受邀 Beta · 客户 paper 与平台测试证据不代表真实或未来收益",
    legal: "风险披露　隐私政策　服务条款",
  },
};

export function ClientPublicLanding() {
  const [lang, setLang] = useState<Lang>("zh-CN");
  const [localeData, setLocaleData] = useState<LocaleData>(initialLocaleData);
  const [localeLoading, setLocaleLoading] = useState(false);
  const [localeError, setLocaleError] = useState("");
  const t: Record<string, string> = useMemo(
    () => ({
      ...localeData.text,
      ...localeData.extraText,
      ...localeData.landingMore,
      _lang: lang,
    }),
    [lang, localeData],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const selectLanguage = async (nextLanguage: Lang) => {
    if (nextLanguage === lang) return;
    if (nextLanguage === "zh-CN") {
      setLocaleData(initialLocaleData);
      setLang(nextLanguage);
      return;
    }
    setLocaleLoading(true);
    setLocaleError("");
    try {
      const locales = await import("./client-public-landing-locales");
      setLocaleData({
        text: locales.text[nextLanguage],
        extraText: locales.extraText[nextLanguage],
        landingMore: locales.landingMore[nextLanguage],
      });
      setLang(nextLanguage);
    } catch {
      setLocaleError("语言资源加载失败，请重试。");
    } finally {
      setLocaleLoading(false);
    }
  };

  const navigate = (page: Page) => {
    const nextPath =
      page === "market"
        ? "/market"
        : page === "trading"
          ? "/paper"
          : "/trading-hall";
    window.location.assign(
      page === "home"
        ? "/"
        : page === "login"
          ? `/login?next=${encodeURIComponent("/dashboard")}`
          : `/login?next=${encodeURIComponent(nextPath)}`,
    );
  };

  return (
    <main className={`${styles.page} app-shell client-app-shell`} data-app-shell>
      <a className={styles.skipLink} href="#landing-main">跳到主要内容</a>
      <header className={styles.topbar}>
        <Link className={styles.logo} href="/" aria-label="Riverton Capital 首页">
          <Image
            className={styles.brandLogo}
            src="/riverton-capital-logo.png"
            width={2193}
            height={324}
            sizes="(max-width: 560px) 154px, 220px"
            priority
            alt="Riverton Capital"
          />
        </Link>
        <div className={styles.topActions}>
          <button type="button" className={styles.login} onClick={() => navigate("login")}>
            {t.login}
          </button>
          <select
            data-locale-static
            className={styles.langSelect}
            aria-label="Language"
            value={lang}
            disabled={localeLoading}
            onChange={(event) => void selectLanguage(event.target.value as Lang)}
          >
            {Object.entries(languageNames).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {localeError && <span className={styles.localeError} role="alert">{localeError}</span>}
        </div>
      </header>
      <div id="landing-main" tabIndex={-1}>
        <Landing t={t} go={navigate} />
      </div>
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
  const m = t;
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
    <div>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>MULTI-AGENT QUANT SYSTEM</div>
          <h1>{t.hero}</h1>
          <p>{t.sub}</p>
          <div className={styles.heroActions}>
            <button className={styles.primary} onClick={() => go("hall")}>{t.enter} →</button>
            <button className={styles.ghost} onClick={() => go("hall")}>{t.demo}</button>
          </div>
          <div className={styles.trust}>
            <span>✓ {t.trust1}</span>
            <span>✓ {t.trust2}</span>
            <span>✓ {t.trust3}</span>
            <span>✓ {t.trust4}</span>
          </div>
        </div>

        {/*
          七阶段决策链。旧版把它画成一圈装饰性轨道，其中三个角色还是用 CSS
          content 注入的——于是 7 种语言里有 5 种只显示英文。这里改成真实 DOM，
          用与下方角色栅格同一份本地化数据，7 种语言都对。
        */}
        <div className={styles.chain} aria-label={m.teamTitle}>
          <div className={styles.chainHead}>
            <b>{m.teamTitle}</b>
            <span>7 STAGES</span>
          </div>
          <div className={styles.pulse} aria-hidden="true" />
          {roles.map((role, index) => {
            const isGate = index === 4;
            return (
              <div key={role[1]} className={isGate ? `${styles.stage} ${styles.gate}` : styles.stage}>
                <span className={styles.stageNo} aria-hidden="true">{`0${index + 1}`}</span>
                <span className={styles.stageBody}>
                  <b>{role[1]}</b>
                  <span>{role[2]}</span>
                </span>
                {isGate && <p className={styles.gateNote}>{m.gateNote}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* 横向滚动容器在窄屏必须可键盘聚焦；axe 会校验这个行为。 */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <section className={styles.section} tabIndex={0} aria-label="四阶段产品流程，可横向滚动">
        <div className={styles.flow}>
          {[[t.flow1, t.flow1s], [t.flow2, t.flow2s], [t.flow3, t.flow3s], [t.flow4, t.flow4s]].map((step, index) => (
            <div className={styles.card} key={step[0]}>
              <span className={styles.cardNo}>{`0${index + 1}`}</span>
              <h3>{step[0]}</h3>
              <p>{step[1]}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.ticker}>
          {["BTC", "ETH", "SOL"].map((symbol) => (
            <button className={styles.tickerItem} key={symbol} onClick={() => go("market")}>
              <b>{symbol}/USDT</b>
              <span>SPOT TARGET</span>
              <em>NO STATIC QUOTE</em>
            </button>
          ))}
          <div className={styles.tickerItem}>
            <b>{t.riskIndex}</b>
            <span>HARD LIMITS</span>
            <em>{t.decision} · SIMULATION ONLY</em>
          </div>
          <div className={styles.tickerItem}>
            <b>{t.accountStatus}</b>
            <span>NON-CUSTODIAL</span>
            <em>REAL ORDERS OFF</em>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <div className={styles.eyebrow}>AI QUANT TEAM</div>
          <h2>{t.teamTitle}</h2>
          <p>{t.teamSub}</p>
        </div>
        <div className={styles.cardGrid}>
          {roles.map((x, i) => (
            <article className={styles.card} key={x[1]}>
              <i><RoleIcon index={i} /></i>
              <h3>{x[1]}</h3>
              <p>{x[2]}</p>
              <span>{`ROLE CONTRACT · 0${i + 1}`}</span>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.split}>
          <div className={styles.preview}>
            <Image
              src="/trading-hall.webp"
              width={1672}
              height={941}
              sizes="(max-width: 768px) 100vw, 55vw"
              alt="AI quantitative trading operations center"
            />
            <div className={styles.previewCaption}>
              <span>PRODUCT PREVIEW</span>
              <b>{m.review}</b>
            </div>
            <button className={styles.previewLink} onClick={() => go("hall")}>{m.enterHall} →</button>
          </div>
          <div>
            <div className={styles.sectionHead}>
              <div className={styles.eyebrow}>VISIBLE INTELLIGENCE</div>
              <h2>{m.visibleTitle}</h2>
            </div>
            <div className={styles.capabilities}>
              {visible.map((x, i) => (
                <div className={styles.capability} key={x[0]}>
                  <i>{`0${i + 1}`}</i>
                  <span>
                    <b>{x[0]}</b>
                    <p>{x[1]}</p>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.safety}`}>
        <div className={styles.sectionHead}>
          <div className={styles.eyebrow}>SECURITY BY DESIGN</div>
          <h2>{m.safetyTitle}</h2>
        </div>
        <div className={styles.cardGrid}>
          {safety.map((x, i) => (
            <article className={styles.card} key={x[0]}>
              <span className={styles.cardNo}>{`0${i + 1}`}</span>
              <h3>{x[0]}</h3>
              <p>{x[1]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.exchange}>
          <div>
            <div className={styles.eyebrow}>PLATFORM DEMO EVIDENCE</div>
            <h2>{m.exchangeTitle}</h2>
            <p>{m.exchangeDesc}</p>
          </div>
          <div className={styles.exchangeLogos} aria-label="平台隔离的测试环境">
            {["OKX Demo", "Binance Spot Testnet", "Bybit Demo"].map((name) => (
              <div className={styles.exchangeLogo} key={name}><b>{name}</b><small>平台测试账户</small></div>
            ))}
          </div>
          <button className={styles.exchangeLink} onClick={() => go("trading")}>
            {m.connectWays} →
          </button>
        </div>
      </section>

      <section className={`${styles.section} ${styles.faq}`}>
        <div className={styles.sectionHead}>
          <div className={styles.eyebrow}>COMMON QUESTIONS</div>
          <h2>{m.faqTitle}</h2>
        </div>
        {faq.map((x) => (
          <details key={x[0]}>
            <summary>{x[0]}<span aria-hidden="true">＋</span></summary>
            <p>{x[1]}</p>
          </details>
        ))}
      </section>

      <section className={styles.section}>
        <div className={styles.finalCta}>
          <div className={styles.eyebrow}>MULTI-AGENT QUANT PLATFORM</div>
          <h2>{m.ctaTitle}</h2>
          <p>{m.ctaSub}</p>
          <div>
            <button className={styles.primary} onClick={() => go("hall")}>{t.enter}</button>
            <button className={styles.ghost} onClick={() => go("hall")}>{m.browse}</button>
          </div>
        </div>
      </section>

      {/* 风险披露独立成块并带左侧色条：它是合规文案，不能压成页脚灰色小字。 */}
      <div className={styles.riskNotice}>
        <b>{riskNotice.label}</b>
        <p>{riskNotice.body}</p>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerMain}>
          <b className={styles.footerMark}>
            <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="160px" alt="Riverton Capital" />
          </b>
          <span>{m.footer}</span>
          <div className={styles.footerLinks}>{m.legal}</div>
        </div>
      </footer>
    </div>
  );
}
