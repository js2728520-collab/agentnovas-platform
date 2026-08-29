"use client";

import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function StrategyCenterUnavailable() {
  const { t } = useAppLocale();
  return <>
    <header className="rc-page-heading">
      <div>
        <small>STRATEGY CENTER</small>
        <h1>{t("策略中心")}</h1>
        <p>{t("策略研究与回测暂不可用。")}</p>
      </div>
    </header>
    <section className="rc-state" role="status">
      <strong>{t("功能尚未开放")}</strong>
      <p>{t("开放前不会创建研究任务、运行回测或产生费用。")}</p>
    </section>
  </>;
}
