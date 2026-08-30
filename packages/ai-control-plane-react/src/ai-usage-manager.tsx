import type { AiUsageClient,UsageBreakdown,UsageSnapshot } from "@agentnovas/ai-control-plane";

import { useAiUsage,type AiUsageQuery } from "./use-ai-usage.ts";

export type AiUsageMessages = {
  title: string;refresh: string;loading: string;error: string;empty: string;
  requests: string;attempts: string;tokens: string;fallbacks: string;unpriced: string;
  consumers: string;roles: string;deployments: string;includeProbes: string;
  providerCosts?: string;settledCredits?: string;
  queueLatencyP95?: string;providerLatencyP95?: string;totalLatencyP95?: string;
};

export type AiUsageManagerProps = {
  client: AiUsageClient;
  query: AiUsageQuery;
  onQueryChange?: (query: AiUsageQuery) => void;
  initialSnapshot?: UsageSnapshot;
  messages: AiUsageMessages;
  formatInteger: (value: string | number) => string;
  classNames?: Partial<Record<"root" | "header" | "summary" | "section" | "table" | "error" | "empty",string>>;
};

function Breakdown({ title,rows,messages,formatInteger,classNames = {} }: {
  title: string;rows: readonly UsageBreakdown[];
  messages: AiUsageMessages;
  formatInteger: AiUsageManagerProps["formatInteger"];
  classNames?: AiUsageManagerProps["classNames"];
}) {
  return <section className={classNames.section}><h2>{title}</h2>{!rows.length
    ? <p className={classNames.empty}>{messages.empty}</p>
    : <table className={classNames.table}><thead><tr><th scope="col">{title}</th><th scope="col">{messages.requests}</th><th scope="col">{messages.attempts}</th><th scope="col">{messages.tokens}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.label ?? row.key}</th><td>{formatInteger(row.requestCount)}</td><td>{formatInteger(row.attemptedCount)}</td><td>{formatInteger(row.inputTokens)} / {formatInteger(row.outputTokens)}</td></tr>)}</tbody></table>}
  </section>;
}

export function AiUsageManager(props: AiUsageManagerProps) {
  const resource = useAiUsage(props.client,props.query,props.initialSnapshot);
  const classes = props.classNames ?? {};
  const summary = resource.snapshot?.summary;
  return <div className={classes.root}>
    <header className={classes.header}><h1>{props.messages.title}</h1><button type="button" onClick={() => void resource.refresh()} disabled={resource.loading}>{props.messages.refresh}</button></header>
    <label><input type="checkbox" checked={props.query.includeProbeTraffic} disabled={!props.onQueryChange} onChange={event => props.onQueryChange?.({ ...props.query,includeProbeTraffic: event.target.checked })} />{props.messages.includeProbes}</label>
    <div aria-live="polite">{resource.loading ? props.messages.loading : ""}</div>
    {resource.error ? <p className={classes.error} role="alert">{props.messages.error}</p> : null}
    {summary ? <dl className={classes.summary}>
      <div><dt>{props.messages.requests}</dt><dd>{props.formatInteger(summary.requestCount)}</dd></div>
      <div><dt>{props.messages.attempts}</dt><dd>{props.formatInteger(summary.attemptedCount)}</dd></div>
      <div><dt>{props.messages.tokens}</dt><dd>{props.formatInteger(summary.inputTokens)} / {props.formatInteger(summary.outputTokens)}</dd></div>
      <div><dt>{props.messages.fallbacks}</dt><dd>{props.formatInteger(summary.fallbackAttemptCount)}</dd></div>
      <div><dt>{props.messages.unpriced}</dt><dd>{props.formatInteger(summary.unpricedCount)}</dd></div>
      {props.messages.queueLatencyP95 ? <div><dt>{props.messages.queueLatencyP95}</dt><dd>{summary.queueLatencyP95Ms === null || summary.queueLatencyP95Ms === undefined ? "—" : `${props.formatInteger(summary.queueLatencyP95Ms)} ms`}</dd></div> : null}
      {props.messages.providerLatencyP95 ? <div><dt>{props.messages.providerLatencyP95}</dt><dd>{summary.providerLatencyP95Ms === null ? "—" : `${props.formatInteger(summary.providerLatencyP95Ms)} ms`}</dd></div> : null}
      {props.messages.totalLatencyP95 ? <div><dt>{props.messages.totalLatencyP95}</dt><dd>{summary.totalLatencyP95Ms === null || summary.totalLatencyP95Ms === undefined ? "—" : `${props.formatInteger(summary.totalLatencyP95Ms)} ms`}</dd></div> : null}
      {props.messages.settledCredits ? <div><dt>{props.messages.settledCredits}</dt><dd>{props.formatInteger(resource.snapshot?.settledCredits ?? "0")}</dd></div> : null}
    </dl> : null}
    {resource.snapshot ? <>
      {props.messages.providerCosts ? <section className={classes.section}><h2>{props.messages.providerCosts}</h2>{resource.snapshot.providerCosts.length
        ? <ul>{resource.snapshot.providerCosts.map(cost => <li key={cost.currency}>{cost.amount} {cost.currency}</li>)}</ul>
        : <p className={classes.empty}>{props.messages.empty}</p>}
      </section> : null}
      <Breakdown title={props.messages.consumers} rows={resource.snapshot.byConsumer} messages={props.messages} formatInteger={props.formatInteger} classNames={props.classNames} />
      <Breakdown title={props.messages.roles} rows={resource.snapshot.byRole} messages={props.messages} formatInteger={props.formatInteger} classNames={props.classNames} />
      <Breakdown title={props.messages.deployments} rows={resource.snapshot.byDeployment} messages={props.messages} formatInteger={props.formatInteger} classNames={props.classNames} />
    </> : null}
  </div>;
}
