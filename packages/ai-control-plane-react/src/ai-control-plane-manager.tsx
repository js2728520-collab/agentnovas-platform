import type { BindingPolicy, ControlPlaneSnapshot, RoleDescriptor } from "@agentnovas/ai-control-plane";

import type { AiControlPlaneManagerProps } from "./types.ts";
import { useAiControlPlane } from "./use-ai-control-plane.ts";

function statusLabel(enabled: boolean, messages: AiControlPlaneManagerProps["messages"]) {
  return enabled ? messages.enabled : messages.disabled;
}

function targetLabel(index: number, messages: AiControlPlaneManagerProps["messages"]) {
  return index === 0 ? messages.primary : `${messages.fallback} ${index}`;
}

function bindingLabel(binding: BindingPolicy, roles: readonly RoleDescriptor[]) {
  return roles.find((role) => role.key === binding.roleKey)?.label ?? binding.roleKey;
}

function Empty({ label, className }: { label: string; className?: string }) {
  return <p className={className} role="status">{label}</p>;
}

function SummarySections(props: AiControlPlaneManagerProps & { snapshot: ControlPlaneSnapshot }) {
  const { snapshot, messages, classNames = {} } = props;
  const deploymentNames = new Map(snapshot.deployments.map((item) => [item.id, item.name ?? item.id]));
  return <>
    <section className={classNames.section} aria-labelledby="ai-control-plane-connections">
      <h2 id="ai-control-plane-connections">{messages.connections}</h2>
      {!snapshot.connections.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.connections.map((connection) => <li className={classNames.item} key={connection.id}>
          <div><b>{connection.name}</b> <span className={classNames.status}>{statusLabel(connection.enabled, messages)}</span></div>
          <small>{connection.adapterId} · {props.formatDateTime(connection.updatedAt)}</small>
          {props.renderConnectionActions?.(connection)}
        </li>)}
      </ul>}
    </section>
    <section className={classNames.section} aria-labelledby="ai-control-plane-deployments">
      <h2 id="ai-control-plane-deployments">{messages.deployments}</h2>
      {!snapshot.deployments.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.deployments.map((deployment) => <li className={classNames.item} key={deployment.id}>
          <div><b>{deployment.name ?? deployment.id}</b> <span className={classNames.status}>{statusLabel(deployment.enabled, messages)}</span></div>
          <small>{deployment.connectionId}</small>
          {deployment.rateCard && props.formatRateCard ? <small>{props.formatRateCard(deployment.rateCard)}</small> : null}
          {props.renderDeploymentActions?.(deployment)}
        </li>)}
      </ul>}
    </section>
    {messages.revisions ? <section className={classNames.section} aria-labelledby="ai-control-plane-revisions">
      <h2 id="ai-control-plane-revisions">{messages.revisions}</h2>
      {!snapshot.deploymentRevisions?.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.deploymentRevisions.map((revision) => <li className={classNames.item} key={revision.id}>
          <div><b>{revision.deploymentName ?? revision.deploymentId} · r{revision.revisionNumber}</b>{revision.isCurrent && messages.current ? <> <span className={classNames.status}>{messages.current}</span></> : null}</div>
          <small>{revision.modelId} · {props.formatDateTime(revision.createdAt)}</small>
          {props.renderDeploymentRevisionActions?.(revision)}
        </li>)}
      </ul>}
    </section> : null}
    <section className={classNames.section} aria-labelledby="ai-control-plane-bindings">
      <h2 id="ai-control-plane-bindings">{messages.bindings}</h2>
      {!snapshot.bindings.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.bindings.map((binding) => <li className={classNames.item} key={binding.id}>
          <div><b>{bindingLabel(binding, props.roles)}</b> <span className={classNames.status}>{statusLabel(binding.enabled, messages)}</span></div>
          <small>{binding.roleKey}</small>
          <ol>{binding.targets.map((target, index) => <li key={target.deploymentId}>{targetLabel(index, messages)} · {deploymentNames.get(target.deploymentId) ?? target.deploymentId}</li>)}</ol>
          {props.renderBindingActions?.(binding)}
        </li>)}
      </ul>}
    </section>
    <section className={classNames.section} aria-labelledby="ai-control-plane-probes">
      <h2 id="ai-control-plane-probes">{messages.probes}</h2>
      {!snapshot.probes.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.probes.map((probe) => <li className={classNames.item} key={probe.id}>
          <b>{probe.status}</b> <small>{props.formatDateTime(probe.testedAt)}{probe.latencyMs === undefined ? "" : ` · ${probe.latencyMs}ms`}</small>
          {props.formatProbeDetails?.(probe).map((detail,index) => <small key={`${probe.id}:${index}`}>{detail}</small>)}
          {props.renderProbeActions?.(probe)}
        </li>)}
      </ul>}
    </section>
    <section className={classNames.section} aria-labelledby="ai-control-plane-budgets">
      <h2 id="ai-control-plane-budgets">{messages.budgets}</h2>
      {!snapshot.budgets.length ? <Empty label={messages.empty} className={classNames.empty} /> : <ul className={classNames.list}>
        {snapshot.budgets.map((budget) => <li className={classNames.item} key={budget.id}>
          <div><b>{budget.scope} · {budget.unit}</b> <span className={classNames.status}>{statusLabel(budget.enabled, messages)}</span></div>
          <small>{budget.limit} · {budget.warningPercentage}%</small>
          {props.renderBudgetActions?.(budget)}
        </li>)}
      </ul>}
    </section>
  </>;
}

export function AiControlPlaneManager(props: AiControlPlaneManagerProps) {
  const resource = useAiControlPlane(props.client, props.initialSnapshot);
  const classNames = props.classNames ?? {};
  return <div className={classNames.root}>
    <header className={classNames.header}>
      <h1>{props.messages.title}</h1>
      <button type="button" onClick={() => void resource.refresh()} disabled={resource.loading}>{props.messages.refresh}</button>
    </header>
    <div aria-live="polite">{resource.loading ? props.messages.loading : resource.error ? props.messages.error : ""}</div>
    {resource.error && !resource.snapshot ? <div className={classNames.error} role="alert">
      <p>{props.messages.error}</p>
      <button type="button" onClick={() => void resource.refresh()}>{props.messages.refresh}</button>
    </div> : null}
    {resource.snapshot ? <SummarySections {...props} snapshot={resource.snapshot} /> : null}
  </div>;
}
