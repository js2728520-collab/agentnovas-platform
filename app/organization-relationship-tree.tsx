"use client";

import { useEffect, useMemo, useState } from "react";

type RelationshipNode = {
  id: string;
  subjectId: string;
  parentId: string | null;
  kind: "member" | "customer";
  displayName: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  organizationId: string | null;
  organizationName: string;
  createdAt: string;
  attributionStatus?: string;
  attributionSource?: string;
  effectiveAt?: string | null;
  canManuallyActivate?: boolean;
};

type ActivationDelivery = {
  ok: true;
  memberId: string;
  deliveryStatus: "queued";
  message: string;
};

type RelationshipPayload = {
  rootId: string;
  scope: string;
  nodes: RelationshipNode[];
  summary: { organizations: number; members: number; customers: number; active: number };
  error?: string;
};

const roleOrder: Record<string, number> = { hq_admin: 0, hq_support: 1, finance: 2, auditor: 3, branch_admin: 4, manager: 5, supervisor: 6, employee: 7, customer: 8 };
const statusLabels: Record<string, string> = { pending: "待激活", active: "正常", frozen: "已冻结", closed: "已关闭" };
const attributionLabels: Record<string, string> = { public_pool_pending: "公海待认领", review_pending: "归属审批中", active: "归属生效", rejected: "归属已驳回", ended: "归属已结束" };
const sourceLabels: Record<string, string> = { employee_invite: "员工邀请", public_pool: "公海分配", manual_transfer: "人工转移" };

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OrganizationRelationshipTree({ refreshKey = "" }: { refreshKey?: string }) {
  const [payload, setPayload] = useState<RelationshipPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [activatingId, setActivatingId] = useState("");
  const [activationError, setActivationError] = useState("");
  const [activationDelivery, setActivationDelivery] = useState<ActivationDelivery | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/organization/members?view=tree", { signal: controller.signal })
      .then(async response => {
        const data = await response.json() as RelationshipPayload;
        if (!response.ok) throw new Error(data.error || "组织关系读取失败");
        return data;
      })
      .then(data => {
        setPayload(data);
        setExpanded(new Set([data.rootId]));
        setSelectedId(current => data.nodes.some(node => node.id === current) ? current : data.rootId);
      })
      .catch(reason => {
        if ((reason as Error).name !== "AbortError") setError(reason instanceof Error ? reason.message : "组织关系读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, refreshVersion]);

  const nodes = useMemo(() => payload?.nodes || [], [payload]);
  const rootId = payload?.rootId || "";
  const nodeMap = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const childrenMap = useMemo(() => {
    const map = new Map<string, RelationshipNode[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const children = map.get(node.parentId) || [];
      children.push(node);
      map.set(node.parentId, children);
    }
    for (const children of map.values()) {
      children.sort((left, right) => (roleOrder[left.role] ?? 99) - (roleOrder[right.role] ?? 99) || left.displayName.localeCompare(right.displayName, "zh-CN"));
    }
    return map;
  }, [nodes]);

  const descendantStats = useMemo(() => {
    const cache = new Map<string, { members: number; customers: number }>();
    const visit = (id: string, visiting = new Set<string>()): { members: number; customers: number } => {
      const saved = cache.get(id);
      if (saved) return saved;
      if (visiting.has(id)) return { members: 0, customers: 0 };
      const nextVisiting = new Set(visiting).add(id);
      const result = { members: 0, customers: 0 };
      for (const child of childrenMap.get(id) || []) {
        if (child.kind === "customer") result.customers += 1;
        else {
          result.members += 1;
          const nested = visit(child.id, nextVisiting);
          result.members += nested.members;
          result.customers += nested.customers;
        }
      }
      cache.set(id, result);
      return result;
    };
    nodes.forEach(node => visit(node.id));
    return cache;
  }, [childrenMap, nodes]);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleSearchIds = useMemo(() => {
    if (!normalizedQuery) return null;
    const visible = new Set<string>();
    for (const node of nodes) {
      const haystack = `${node.displayName} ${node.email} ${node.roleLabel} ${node.organizationName} ${statusLabels[node.status] || node.status}`.toLocaleLowerCase("zh-CN");
      if (!haystack.includes(normalizedQuery)) continue;
      let current: RelationshipNode | undefined = node;
      while (current && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parentId ? nodeMap.get(current.parentId) : undefined;
      }
    }
    if (rootId) visible.add(rootId);
    return visible;
  }, [nodeMap, nodes, normalizedQuery, rootId]);

  const selected = nodeMap.get(selectedId) || (rootId ? nodeMap.get(rootId) : undefined);
  const selectedChildren = selected ? childrenMap.get(selected.id) || [] : [];
  const selectedStats = selected ? descendantStats.get(selected.id) || { members: 0, customers: 0 } : { members: 0, customers: 0 };
  const matchingCount = visibleSearchIds ? nodes.filter(node => {
    const haystack = `${node.displayName} ${node.email} ${node.roleLabel} ${node.organizationName} ${statusLabels[node.status] || node.status}`.toLocaleLowerCase("zh-CN");
    return haystack.includes(normalizedQuery);
  }).length : nodes.length;

  function toggle(id: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(nodes.filter(node => (childrenMap.get(node.id) || []).length).map(node => node.id)));
  }

  function collapseAll() {
    setExpanded(new Set(rootId ? [rootId] : []));
  }

  function refresh() {
    setLoading(true);
    setError("");
    setRefreshVersion(value => value + 1);
  }

  async function activateMember(node: RelationshipNode) {
    if (!window.confirm(`确定为 ${node.email} 重新发送设置密码邀请？\n\n旧邀请会失效；在成员完成设置密码前，账户仍保持待激活。`)) return;
    setActivatingId(node.id);
    setActivationError("");
    try {
      const response = await fetch(`/api/organization/members/${encodeURIComponent(node.subjectId)}/activate`, { method: "POST" });
      const data = await response.json() as Partial<ActivationDelivery> & { error?: string };
      if (!response.ok) throw new Error(data.error || "设置密码邀请发送失败");
      if (data.ok !== true || data.deliveryStatus !== "queued" || !data.memberId || !data.message) {
        throw new Error("设置密码邀请回执无效");
      }
      setActivationDelivery(data as ActivationDelivery);
    } catch (reason) {
      setActivationError(reason instanceof Error ? reason.message : "设置密码邀请发送失败");
    } finally {
      setActivatingId("");
    }
  }

  function renderNode(node: RelationshipNode) {
    if (visibleSearchIds && !visibleSearchIds.has(node.id)) return null;
    const children = (childrenMap.get(node.id) || []).filter(child => !visibleSearchIds || visibleSearchIds.has(child.id));
    const open = normalizedQuery ? children.length > 0 : expanded.has(node.id);
    const directMembers = children.filter(child => child.kind === "member").length;
    const directCustomers = children.filter(child => child.kind === "customer").length;
    return <div className={`organization-tree-node ${node.kind}`} key={node.id}>
      <div className={`organization-tree-row ${selected?.id === node.id ? "selected" : ""}`}>
        <button type="button" className={`organization-tree-toggle ${children.length ? "has-children" : "leaf"}`} aria-label={children.length ? `${open ? "收起" : "展开"}${node.displayName}` : `${node.displayName}没有下级`} aria-expanded={children.length ? open : undefined} onClick={() => children.length && toggle(node.id)}>{children.length ? open ? "−" : "+" : "·"}</button>
        <button type="button" className="organization-tree-person" onClick={() => setSelectedId(node.id)}>
          <span className={`organization-tree-avatar role-${node.role}`}>{node.kind === "customer" ? "用" : node.roleLabel.slice(0, 1)}</span>
          <span className="organization-tree-identity"><b>{node.displayName}</b><small>{node.email}</small></span>
          <span className={`organization-tree-role role-${node.role}`}>{node.roleLabel}</span>
          <span className={`organization-tree-status status-${node.status}`}><i />{statusLabels[node.status] || node.status}</span>
          <span className="organization-tree-direct">{children.length ? `${directMembers} 名直属 · ${directCustomers} 名用户` : node.kind === "customer" ? attributionLabels[node.attributionStatus || ""] || "用户层" : "暂无下级"}</span>
          <span className="organization-tree-open">›</span>
        </button>
      </div>
      {open && children.length > 0 && <div className="organization-tree-children">{children.map(renderNode)}</div>}
    </div>;
  }

  return <section className="organization-relationship-panel">
    <header className="organization-relationship-head">
      <div><small>ORGANIZATION RELATIONSHIP</small><h2>组织关系树</h2><p>按直属关系逐层展开，最终查看每位员工关联的用户。</p></div>
      <span><i />实时组织数据</span>
    </header>

    {loading && <div className="organization-tree-loading"><i /><span>正在生成组织关系树…</span></div>}
    {!loading && error && <div className="organization-tree-error"><span>{error}</span><button type="button" onClick={refresh}>重新加载</button></div>}
    {!loading && !error && payload && <>
      <div className="organization-tree-summary">
        <article><small>组织/分公司</small><b>{payload.summary.organizations}</b><span>当前可见范围</span></article>
        <article><small>内部成员</small><b>{payload.summary.members}</b><span>含当前管理账号</span></article>
        <article><small>关联用户</small><b>{payload.summary.customers}</b><span>已进入归属关系</span></article>
        <article><small>正常账户</small><b>{payload.summary.active}</b><span>成员与用户合计</span></article>
      </div>

      <div className="organization-tree-toolbar">
        <label><span>搜索关系网</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名、邮箱、职位或组织名称" /></label>
        <div><span className="organization-tree-result">{normalizedQuery ? `找到 ${matchingCount} 条` : "逐级查看模式"}</span><button type="button" onClick={expandAll}>全部展开</button><button type="button" onClick={collapseAll}>收起到第一层</button><button type="button" onClick={refresh}>刷新</button></div>
      </div>

      <div className="organization-tree-workspace">
        <div className="organization-tree-canvas">
          <div className="organization-tree-legend"><span><i className="member" />内部成员</span><span><i className="customer" />用户层</span><small>点击 + 逐层展开，点击人员查看右侧详情</small></div>
          {payload.rootId && nodeMap.get(payload.rootId) ? renderNode(nodeMap.get(payload.rootId)!) : <div className="organization-tree-empty">当前范围暂无可显示的组织关系</div>}
          {normalizedQuery && matchingCount === 0 && <div className="organization-tree-no-result">没有找到符合条件的人员</div>}
        </div>

        <section className="organization-tree-detail">
          {selected ? <>
            <header><span className={`organization-tree-avatar role-${selected.role}`}>{selected.kind === "customer" ? "用" : selected.roleLabel.slice(0, 1)}</span><div><small>{selected.kind === "customer" ? "USER PROFILE" : "MEMBER PROFILE"}</small><h3>{selected.displayName}</h3><p>{selected.email}</p></div></header>
            <div className="organization-tree-detail-badges"><span className={`role-${selected.role}`}>{selected.roleLabel}</span><span className={`status-${selected.status}`}>{statusLabels[selected.status] || selected.status}</span></div>
            <dl>
              <div><dt>所属组织</dt><dd>{selected.organizationName}</dd></div>
              <div><dt>直属成员</dt><dd>{selectedChildren.filter(child => child.kind === "member").length} 人</dd></div>
              <div><dt>全部下属成员</dt><dd>{selectedStats.members} 人</dd></div>
              <div><dt>关系网用户</dt><dd>{selectedStats.customers} 人</dd></div>
              <div><dt>{selected.kind === "customer" ? "注册时间" : "创建时间"}</dt><dd>{formatDate(selected.createdAt)}</dd></div>
              <div><dt>账户状态</dt><dd>{statusLabels[selected.status] || selected.status}</dd></div>
            </dl>
            {selected.kind === "customer" && <section><h4>用户归属信息</h4><p><span>归属状态</span><b>{attributionLabels[selected.attributionStatus || ""] || selected.attributionStatus || "—"}</b></p><p><span>归属来源</span><b>{sourceLabels[selected.attributionSource || ""] || selected.attributionSource || "—"}</b></p><p><span>生效时间</span><b>{formatDate(selected.effectiveAt)}</b></p></section>}
            {selected.canManuallyActivate && <section className="organization-tree-activation">
              <h4>待激活账户</h4>
              <p>重新发送一次性设置密码邀请；成员完成设置密码前，账户不会变为正常状态。</p>
              <button type="button" disabled={Boolean(activatingId)} onClick={() => void activateMember(selected)}>{activatingId === selected.id ? "正在加入邮件队列…" : "重新发送设置密码邀请"}</button>
            </section>}
            {activationDelivery?.memberId === selected.subjectId && <section className="organization-tree-credentials" aria-live="polite">
              <header><div><small>DELIVERY QUEUED</small><h4>设置密码邀请已进入邮件队列</h4></div><span>待发送</span></header>
              <p className="organization-tree-credential-note">{activationDelivery.message}</p>
              <p>此处不会显示或复制密码、Token 或登录链接。邮件投递成功也不等于成员已激活。</p>
              <div className="organization-tree-credential-actions"><button type="button" onClick={() => setActivationDelivery(null)}>关闭回执</button></div>
            </section>}
            {activationError && <div className="organization-tree-activation-error">{activationError}</div>}
            <footer>人员编号 <code>{selected.subjectId}</code></footer>
          </> : <div className="organization-tree-detail-empty">点击左侧人员查看详情</div>}
        </section>
      </div>
    </>}
  </section>;
}
