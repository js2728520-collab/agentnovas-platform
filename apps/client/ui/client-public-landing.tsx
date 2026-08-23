"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

import styles from "./client-public-landing.module.css";
import Link from "next/link";
import {
  PLATFORM_LOCALE_STORAGE_KEY,
  resolvePlatformLocale,
  type PlatformLocale,
} from "@/lib/platform-locale";

type Page = "home" | "login" | "hall" | "market" | "trading";

type Lang = PlatformLocale;

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
    strategy: "AI Strategies",
    risk: "Risk Settings",
    login: "Sign in",
    hero: "An AI quant team working for you",
    sub: "Specialized agents analyze markets, challenge proposals, and manage risk. Execution currently produces shadow or paper receipts only; real orders are off.",
    enter: "Enter Trading Hall",
    demo: "Explore Strategies",
    market: "Market regime",
    decision: "Current decision",
  },
  extraText: {
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
    watch: "Watch the team at work",
    riskIndex: "AI risk index",
    accountStatus: "Account status",
    teamTitle: "Not one bot, but a professional team",
    teamSub: "Each Agent judges independently and challenges the others. Risk controls and deterministic rules decide whether execution is allowed.",
    skipMain: "Skip to main content",
    homeAria: "Riverton Capital home",
    flowAria: "Four-stage product flow, horizontally scrollable",
    demoEnvironmentsAria: "Isolated platform test environments",
    demoAccount: "Platform test account",
  },
  landingMore: {
    roles: "M|Market Analyst|Classifies the current market;T|Technical Analyst|Validates concrete signals;S|Strategy Researcher|Builds a candidate plan;C|Adversarial Reviewer|Finds flaws and contrary evidence;R|Chief Risk Officer|Applies hard risk approval;D|AI Decision Officer|Issues the final decision;E|Execution Agent|Produces a shadow or paper receipt",
    // This is the English first-paint copy. Keep it aligned with the lazy locale module.
    gateNote: "Stage 5 runs on deterministic code, not a model. It can veto every AI conclusion above it, and no new position opens when data is thin or risk checks are unavailable.",
    visibleTitle: "Every decision is visible",
    visible: "Live collaboration|See Agent views, objections, revisions and final decisions.;Dynamic risk control|Reduce paper exposure or pause as markets change.;Complete audit|Keep paper receipts separate from platform Demo evidence.",
    review: "Risk review in progress",
    enterHall: "Enter live Trading Hall",
    safetyTitle: "AI adapts. Hard controls protect the boundary.",
    safety: "No customer credentials|Beta uses public market data and server-managed paper portfolios.;Isolated principal|Each official card receives a separate 10,000 USDT paper balance.;Spot only|BTC, ETH and SOL against USDT, with no leverage or shorting.;Portfolio circuit breaker|Stop new entries at loss or drawdown limits.;Fail safe|No paper fill on stale data, timeout or malformed output.;Separated evidence|Platform Demo receipts never change customer paper performance or settlement.",
    exchangeTitle: "Platform test-environment evidence",
    exchangeDesc: "OKX Demo, Binance Spot Testnet and Bybit Demo validate platform signals only. Customers do not connect accounts and no live trade is placed.",
    connectWays: "View paper portfolios",
    faqTitle: "Common questions",
    faq: "Must I connect an exchange?|No. Beta does not accept customer exchange credentials.;Will AI place live orders?|No. Customer activity is limited to risk-controlled paper receipts.;Are the returns real?|No. Paper performance is not actual or future performance.;What is a platform Demo receipt?|It only proves a signal was tested in an isolated provider environment.",
    ctaTitle: "Enter the AI quant team’s live workspace",
    ctaSub: "Explore three official spot strategies through isolated paper portfolios.",
    browse: "Browse AI strategies",
    footer: "Invite-only Beta · Customer paper and platform test evidence are not actual or future returns",
    legalRisk: "Risk Disclosure",
    legalPrivacy: "Privacy",
    legalTerms: "Terms",
  },
};

export function ClientPublicLanding() {
  const [lang, setLang] = useState<Lang>("en-US");
  const [localeData, setLocaleData] = useState<LocaleData>(initialLocaleData);
  const [localeLoading, setLocaleLoading] = useState(false);
  const [localeError, setLocaleError] = useState("");
  const localeRequest = useRef(0);
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

  useEffect(() => {
    let cancelled = false;
    let savedLocale: string | null = null;
    try {
      savedLocale = window.localStorage.getItem(PLATFORM_LOCALE_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in hardened browser contexts; browser preference still works.
    }
    const resolved = resolvePlatformLocale({
      savedLocale,
      browserLanguages: navigator.languages ?? [navigator.language],
    });
    if (resolved.locale === "en-US") return () => { cancelled = true; };
    const requestId = ++localeRequest.current;
    void import("./client-public-landing-locales")
      .then((locales) => {
        if (cancelled || requestId !== localeRequest.current) return;
        setLocaleData({
          text: locales.text[resolved.locale],
          extraText: locales.extraText[resolved.locale],
          landingMore: locales.landingMore[resolved.locale],
        });
        setLang(resolved.locale);
      })
      .catch(() => {
        if (!cancelled && requestId === localeRequest.current) {
          setLocaleError("Language resources could not be loaded. Please retry.");
        }
      });
    return () => { cancelled = true; };
  }, []);

  const selectLanguage = async (nextLanguage: Lang) => {
    if (nextLanguage === lang) return;
    const requestId = ++localeRequest.current;
    if (nextLanguage === "en-US") {
      setLocaleData(initialLocaleData);
      setLang(nextLanguage);
      try { window.localStorage.setItem(PLATFORM_LOCALE_STORAGE_KEY, nextLanguage); } catch {
        // A language choice remains usable for this page even when persistence is unavailable.
      }
      return;
    }
    setLocaleLoading(true);
    setLocaleError("");
    try {
      const locales = await import("./client-public-landing-locales");
      if (requestId !== localeRequest.current) return;
      setLocaleData({
        text: locales.text[nextLanguage],
        extraText: locales.extraText[nextLanguage],
        landingMore: locales.landingMore[nextLanguage],
      });
      setLang(nextLanguage);
      try { window.localStorage.setItem(PLATFORM_LOCALE_STORAGE_KEY, nextLanguage); } catch {
        // A language choice remains usable for this page even when persistence is unavailable.
      }
    } catch {
      if (requestId === localeRequest.current) {
        setLocaleError("Language resources could not be loaded. Please retry.");
      }
    } finally {
      if (requestId === localeRequest.current) setLocaleLoading(false);
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
      <a className={styles.skipLink} href="#landing-main">{t.skipMain}</a>
      <header className={styles.topbar}>
        <Link className={styles.logo} href="/" aria-label={t.homeAria}>
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
    label: "Risk disclosure",
    body: "Crypto assets and automated trading involve substantial risk.",
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
          <p className={styles.chainSub}>{m.teamSub}</p>
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
      <section className={styles.section} tabIndex={0} aria-label={t.flowAria}>
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
          <div className={styles.exchangeLogos} aria-label={t.demoEnvironmentsAria}>
            {["OKX Demo", "Binance Spot Testnet", "Bybit Demo"].map((name) => (
              <div className={styles.exchangeLogo} key={name}><b>{name}</b><small>{t.demoAccount}</small></div>
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
          {/* 原本这里是纯文本「风险披露、隐私政策、服务条款」——点不动，也没有对应页面。
              视觉上像入口而实际打不开，访客会认为平台把条款藏起来了。 */}
          <div className={styles.footerLinks}>
            <Link href="/legal#risk_disclosure" prefetch={false}>{m.legalRisk}</Link>
            <Link href="/legal#privacy" prefetch={false}>{m.legalPrivacy}</Link>
            <Link href="/legal#terms" prefetch={false}>{m.legalTerms}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
