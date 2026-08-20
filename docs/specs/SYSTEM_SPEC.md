# Riverton 三应用一库系统规格

版本：1.0
状态：受控测试基线

## 1. 物理拓扑

```text
Client Web ───────┐
Operations Web ──┼─ Next.js codebase ─ PostgreSQL
Maintenance Web ─┘          │
                            ├─ Research Worker
                            ├─ Runtime Worker
                            ├─ Payment Worker（默认关闭）
                            └─ Notification Worker（默认关闭）
```

三个 Web 进程使用相同代码但独立的 `RIVERTON_APP_AUDIENCE`、域名、端口、构建目录和 Session Cookie。共享数据库不等于共享访问权；每次页面和 API 请求都必须解析 audience、会话、权限与数据范围。

目标部署为 Linux、Node.js 22.21+、PostgreSQL 16+、Nginx、Certbot 和 systemd。不引入 Cloudflare Runtime 或 Redis。

## 2. Audience 合同

| Audience | 生产域名 | 默认本地端口 | Cookie | 注册 |
| --- | --- | ---: | --- | --- |
| `client` | `agentnovas.com` | 3000 | `rc_client_session`，兼容 `an_session` | 邀请制 |
| `operations` | `zht.agentnovas.com` | 3001 | `rc_ops_session` | 禁止 |
| `maintenance` | `xm.agentnovas.com` | 3002 | `rc_maint_session` | 禁止 |

解析优先级：明确环境 audience → 已配置 Host 映射 → 本地开发 Host/端口映射 → 拒绝不明确请求。生产环境不得根据路径猜测 audience。

错误 audience 页面返回 404；API 不允许以当前用户在其他应用拥有权限为理由跨 audience 回退。

## 3. 路由合同

### Client

`/`、`/login`、`/wallet`、`/wallet/deposits`、`/notifications`；现有 SPA 内部工作区保留交易大厅、行情、策略广场、我的策略、Agent 对话、回测、模拟盘、会员、交易所连接、风险和账户设置。

### Operations

`/`、`/customers`、`/organization`、`/deposits`、`/deposits/[id]`、`/ledger`、`/finance`、`/approvals`、`/access`、`/access/audit`。

目标扩展：`/analytics`、`/team`、`/team/targets`、`/organization/members`、`/organization/invitations`、`/customers/attributions`、`/strategies/review`、`/finance/revenue`、`/finance/settlements`、`/finance/collections`、`/finance/payouts`、`/policies/follow`、`/audit`。

### Maintenance

`/`、`/models`、`/integrations`、`/integrations/email`、`/integrations/payments`、`/health`、`/safety`、`/settings`、`/access`、`/access/audit`。

目标扩展：`/integrations/data`、`/health/workers`、`/audit`。

## 4. 身份、会话与授权

### 会话

- Cookie 必须使用 `HttpOnly`、生产 `Secure`、合理 `SameSite` 和 audience 专属名称。
- Session 行必须记录 `appAudience`；退出只删除当前 audience 会话。
- `next` 只能接受站内绝对路径，拒绝 `//`、反斜杠和外部 URL。
- Client 可邀请注册和找回密码；内部应用相同接口返回 404。

### RBAC

- 页面启动调用 `/api/access/me/effective`，只用于菜单、按钮和客户端路由体验。
- API 必须重新校验当前 audience、权限键和数据范围。
- 固定数据范围：`SELF`、`DIRECT_REPORTS`、`TEAM_TREE`、`ORGANIZATION`、`ORGANIZATION_SET`、`PLATFORM`。
- 角色、模板、分配、变更申请和审计查询必须带当前应用条件。
- 敏感角色、资金人工操作、策略上/下架和跨组织授权必须双人审批；申请人不能自审。

旧 `users.role` 只允许作为有截止期的迁移兼容来源。生产受控测试前必须完成显式分配，禁用“无分配即自动恢复全部旧权限”的无限期回退。

## 5. 业务数据域

| 数据域 | 真源 | 写入规则 |
| --- | --- | --- |
| 用户、组织、归属 | PostgreSQL 业务表 | 运营 RBAC + 数据范围；关系变化审计 |
| 平台钱包、充值、账本 | PostgreSQL | 账本分录不可变；修正使用反向分录 |
| 策略研发、候选、评估 | PostgreSQL + Worker | 所有权、租约、幂等、版本固定 |
| 运行周期与事件 | PostgreSQL | 完整 K 线触发；唯一周期/决策轮；七阶段有序 |
| 模型 Profile/绑定 | PostgreSQL 加密字段 | Maintenance 管理；浏览器只见安全视图 |
| 通知投递 | PostgreSQL outbox | Worker 开关、租约、幂等、Webhook 乱序保护 |
| 外部集成状态 | PostgreSQL + 环境变量 | 配置态、启用态、心跳态分别表示 |

业务组件只消费 `packages/contracts` 的 camelCase 合同，不直接消费数据库 snake_case 行。

## 6. 七智能体运行规格

官方三卡的角色与策略参数见 `../product/SEVEN_AGENT_TRADING_HALL.md`。系统层约束：

- `decisionRoundId` 可以复用当前 runtime cycle 主键，但 API 字段必须使用产品语义。
- 新运行事件角色：`market_analysis`、`technical_analysis`、`strategy_proposal`、`adversarial_review`、`risk_approval`、`final_decision`、`execution_receipt`。
- 旧 runtime 角色允许通过显式兼容映射读取；旧 `audit` 不映射为 `final_decision`。
- 运行审计元数据另存，不占七角色序列。
- 实际执行环境枚举：`shadow`、`paper`、`exchange_demo`、`live_spot`；当前只允许前两者，现有明确授权的 OKX Demo 紧急平仓是独立运维路径，不代表 Client 实盘开放。

## 7. API 与错误合同

成功响应使用对应 `packages/contracts` 类型。错误逐步统一为：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "当前账号无权查看该模块",
    "details": {}
  },
  "requestId": "..."
}
```

| HTTP | 语义 | 前端行为 |
| ---: | --- | --- |
| 400 | 格式错误 | 保留输入，定位字段 |
| 401 | 会话缺失/过期 | 跳当前应用登录并保留 `next` |
| 403 | 登录有效但无权 | 显示无权限，不循环跳转 |
| 404 | 资源不存在或错误 audience | 不泄露资源是否在其他应用存在 |
| 409 | 自审、重复决定、版本/状态冲突 | 显示服务端业务原因 |
| 422 | 业务验证失败 | 显示字段或规则原因 |
| 429 | 登录/敏感操作限流 | 显示重试时间 |
| 503 | 服务未配置、Worker 关闭、测试禁用 | 显示真实不可用状态 |

## 8. 安全要求

- 密码采用适合口令的现代 KDF；登录、找回和 bootstrap/setup 必须限流并有审计。
- 内部高权限账户在受控测试前启用 MFA 或等效强认证。
- CSP、HSTS、frame、MIME、referrer 和 permissions 安全响应头纳入构建/浏览器验收。
- 所有 SQL 参数化；动态排序、筛选和数据范围使用白名单。
- PII 脱敏在服务端完成，列表与详情一致。
- 不在通知 payload 中保存临时密码；初始账号通过一次性设置链接完成。
- 公开健康检查只返回粗粒度可用性；密钥存在性、队列数量、紧急状态和内部组件细节仅对 Maintenance 开放。

## 9. 可观测性

- 每个请求生成 `requestId`，关键操作携带 actor、audience、permission、scope、subject 和结果。
- Worker 需要最后心跳、当前 lease owner、最近成功/失败、队列积压和开关状态。
- “已配置”“已启用”“进程存活”“最近成功”是四个独立字段。
- 七智能体使用 `decisionRoundId` 和 trace ID 串联行情快照、事件、决定和执行回执。

## 10. 数据库迁移

- PostgreSQL 是唯一生产真源。
- 新功能迁移使用单一顺序迁移目录；Drizzle 元数据与 `postgres/migrations` 的权责必须在 Gate 0 选定并记录。
- 生产迁移前必须在一次性 Schema/恢复副本中执行、核对行数与关键哈希，并准备回滚。
- 本任务不执行生产迁移。

## 11. 完成定义

一个模块只有在稳定路由、权限、数据范围、API 合同、真实状态、空/错/加载、重复提交保护、审计、自动测试、浏览器验收和文档全部完成后，才能从 `PARTIAL` 改为 `CURRENT`。
