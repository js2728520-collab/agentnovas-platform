# Riverton Capital 受邀付费 Beta 系统规格

版本：2.0
状态：目标规格；以测试和 Gate 证据判定完成度

## 1. 拓扑与信任边界

```text
Client Web ───────┐
Operations Web ──┼── PostgreSQL（共享数据、逻辑隔离）
Maintenance Web ─┘       ├─ Notification Worker
                          ├─ Paper Runtime Worker
                          └─ Demo Execution Worker

Payment Worker：Beta 不部署 unit，接口与外部副作用路径 disabled
Legacy Research Worker：Beta 不启动，HTTP/租约/orchestrator/systemd 均硬关闭
真实交易/提现/自动支付：代码路径硬关闭
```

三个 Web 进程使用相同代码但独立 `RIVERTON_APP_AUDIENCE`、域名、端口、构建目录、Session Cookie、最小 env 和数据库角色。共享数据库不是共享授权；所有入口重新解析 audience、会话、MFA、权限与 assignment-bound data scope。

## 2. Audience 与路由

| Audience | 本地端口 | Cookie | 注册 |
| --- | ---: | --- | --- |
| `client` | 3000 | `rc_client_session` | 仅邀请/一次性设置密码 |
| `operations` | 3001 | `rc_ops_session` | 禁止 |
| `maintenance` | 3002 | `rc_maint_session` | 禁止 |

解析顺序：显式进程 audience → 配置 Host allowlist → 已知本地 Host/端口 → 404。未知生产 Host 不得默认为 Client。页面错误 audience 404；API 不因同一用户在其他应用有权限而跨 audience 回退。

稳定路由：

- Client：`/`、`/login`、`/legal/consent`、`/membership`、`/membership/orders`、`/credits`、`/paper`、`/paper/[portfolioId]`、`/trading-hall`、`/notifications`、`/wallet`、`/wallet/deposits`。
- Operations：`/`、`/customers`、`/organization`、`/membership-orders`、`/credits`、`/performance-statements`、`/deposits`、`/ledger`、`/finance`、`/approvals`、`/access`、`/access/audit`。
- Maintenance：`/`、`/models`、`/integrations/email`、`/integrations/payments`、`/integrations/demo-exchanges`、`/health`、`/safety`、`/access`、`/access/audit`、`/audit`。

Beta 未完成或不在范围的旧策略市场、自动结算、团队经营分析入口 feature-gate 隐藏。

## 3. 中央 API Policy

每个 HTTP method/path 在机器可读 inventory 中注册：

```ts
type ApiPolicy = {
  method: HttpMethod;
  path: string;
  audiences: AppAudience[];
  auth: "public" | "session" | "machine";
  mfa: "none" | "required" | "recent";
  permissions: string[];
  scopeResolver?: string;
  pii: "none" | "masked" | "reveal";
  sensitivity: "read" | "write" | "critical";
  idempotency: boolean;
  rateLimit?: RateLimitPolicy;
  bodyMaxBytes?: number;
};
```

`withApiPolicy()` 构建 `ApiContext { requestId, audience, actor, grants, scope, mfaLevel }`。未登记 handler、错误 audience、缺权限、缺 recent MFA、写请求缺 Origin/CSRF 或幂等键均默认拒绝。CI 对全部 route/method inventory 做零遗漏断言。

统一错误：

```json
{
  "error": { "code": "STATE_CONFLICT", "message": "当前状态不允许该操作" },
  "requestId": "..."
}
```

401 回当前应用登录并保留安全 `next`；403 显示无权限且不循环；404 隐藏跨 audience 资源；409 表示自审/重复/状态或版本冲突；422 返回业务校验；429 携带重试信息；503 表示未配置、未启用或 Worker 不健康。

## 4. 身份与会话

- 新密码使用 Argon2id：memory `19,456 KiB`、iterations `2`、parallelism `1`、32-byte output；旧 PBKDF2 登录成功后 lazy rehash。
- 不存在账号执行等价 dummy verify，登录和找回不泄露账户存在性。
- Client session：absolute 7 天、idle 24 小时；内部 session：absolute 12 小时、idle 1 小时。
- 邮箱+audience 登录失败 5 次/15 分钟；IP 30 次/15 分钟；找回使用更严格小时限额，存储在 PostgreSQL 以覆盖多实例。
- Operations/Maintenance 完成 TOTP 才发完整 session；recovery code 单次使用并保存 hash。critical 操作要求 15 分钟内 recent MFA。
- 密码修改/重置、冻结、撤权和恢复码重置撤销相关 session。
- HTTP bootstrap 在生产 404；CLI 仅在无内部管理员时一次成功并留审计。
- 内部邀请与重置只发送一次性 set-password link；响应、通知 payload、日志和 UI 不含临时密码或明文 token。
- 生产 Cookie 强制 `HttpOnly`/`Secure`/audience 专属；信任代理列表显式配置；敏感写操作校验 Origin/CSRF。

TOTP 是 Beta 基线，不宣称完整 NIST AAL2；Passkey/WebAuthn 为 GA 前任务。

## 5. RBAC 与数据范围

- Operations/Maintenance 必须有显式 published assignment；legacy fallback 在 Beta 为 disabled。
- 撤权写 tombstone；删除最后 assignment 不会恢复 `users.role` 权限。
- assignment 保存 organization、organization set、team、direct reports 和有效期；scope resolver 不得只使用当前用户组织替代 assignment 约束。
- 列表、详情、计数、导出、审批目标和账本 counterparty 使用同一 scope。
- 敏感授权、会员付款、credits 调整、盈利分成、客户冻结和充值人工操作强制 maker-checker；申请人永远不能自审。
- 所有决定锁定请求和业务版本，在同一事务完成状态、业务副作用、账本/outbox 和审计。

## 6. 数据与迁移

`postgres/migrations` 是唯一生产 schema 真源。迁移器维护 `_agentnovas_migrations(version, checksum, applied_at, commit_sha)`，使用 advisory lock；每文件独立事务，已应用跳过，checksum 变化失败。必须验证 fresh、N-1、rerun、checksum mismatch、并发和恢复。

本 Beta 固定迁移：

- `0021_identity_access_hardening.sql`
- `0022_ledger_approval_invariants.sql`
- `0023_commercial_membership_settlement.sql`
- `0024_platform_demo_execution.sql`
- `0025_worker_observability.sql`
- `0026_client_paper_permissions.sql`
- `0027_platform_demo_admin_commands.sql`
- `0028_commercial_legal_content.sql`
- `0029_beta_legacy_runtime_hard_close.sql`

数据库角色至少拆分为 migrator、client_web、ops_web、maint_web、notification_worker、runtime_worker、demo_execution_worker；legacy research 和 Payment Worker 不获得 Beta 业务写权限。

## 7. 账本、会员和 credits

- 账本命令使用来源幂等锁、账户/余额行锁、同币种借贷平衡、wallet version CAS，并在同事务写 audit/outbox。
- 已发布 transaction/posting 禁止 UPDATE/DELETE；修正只能 reversal。
- 会员订单保存 v1 计划价格快照；外部人工凭证经过 maker-checker 后幂等激活 entitlement 并发放 credits。
- Credits 使用独立不可变 ledger；reserve/settle/release 按模型费率和 provider usage 执行，余额不得为负。
- Beta 不生成充值地址、二维码、链上监听、客户钱包入账或自动退款。

商业状态机和 API 见 `../product/PRD.md` 与 `../api/API_CATALOG.md`。

## 8. paper、七智能体与 Demo

- `packages/contracts` 保存三卡唯一 snapshot，runtime/部署/Hall 只引用 snapshot hash。
- 每个用户/卡片组合初始 `10,000 USDT`，只支持 BTC/ETH/SOL spot long-only。
- runtime 对完整 candle 幂等地产生七事件、paper intent/trade 和 trace；到期停止新开仓。
- Demo intent 与 paper trade 使用不同表、状态机和金额；provider 失败不改变 paper。
- Demo Worker 的进程启用与 provider 外部写授权是两个独立开关；Maintenance 诊断必须分别报告 `processEnabled`/`externalWritesEnabled`/`alive`/`healthy`，不得用已配置或已存活代替写入授权。
- OKX 强制 Demo header；Binance 只允许 Spot Testnet；Bybit 只允许 Demo 域名。生产域名和提现/划转/杠杆/衍生品 endpoint 不在 allowlist。
- provider/card/round 使用确定性 clientOrderId；单笔默认上限 10 USDT、provider 日上限 100 USDT；kill switch 默认安全。
- CI 只用净化 fixture。真实 Demo smoke 只允许 staging、显式开关和已配置平台测试凭证。

## 9. 周盈利分成

系统按上一个完整 UTC 周汇总一个客户三卡已平仓 paper 净收益。费用基数、高水位、亏损结转、费率和付款条件以 PRD 为准。生成、业务审批、付款凭证、付款复核是四个不同事件；只有最终复核事务提交新高水位。任何状态都不得自动扣钱包或描述为真实投资结算。

## 10. 通知与外部集成

- Beta 渠道为 in-app 与 Email。Telegram/WhatsApp 为 `not_integrated`，接口不生成/返回验证码。
- Email 只有 domain、API key、webhook、模板、suppression、retention、allowlist 全部就绪并获显式授权才可发送；否则为 `configured_not_sent`。
- Maintenance DTO 仅含 `hasSecret`、provider/environment、权限检查、最近验证/测试；不返回 Key、密文引用、完整端点或 raw webhook。
- 支付始终 disabled。Payment Webhook/Worker 不构成 Beta 收费路径。
- LLM endpoint 采用 provider host allowlist，拒绝私网 IPv4/IPv6、redirect 与 DNS rebinding，并配合出口控制。

## 11. 可观测性与健康

每请求生成 `requestId`；七智能体和关键商业流程使用 `traceId`。JSON 日志记录 audience、actor ID、permission、result、latency 和安全错误码，不写 secret、完整 PII、token 或 raw webhook。

`worker_instances` 记录 worker type、instance、commit SHA、started/heartbeat、last success/failure、error code、current job。Maintenance 分别显示 configured/enabled/alive/healthy/stale，包含 queue depth/oldest age；进程停止须在阈值内变 stale。

公开 `/api/health/live` 与 `/api/health/ready` 只返回粗粒度状态；详细数据库、配置、队列、provider 和 Worker 诊断需要 `maint.system_health.view`。

## 12. 前端与 NFR

- audience server import 与 route-level lazy loading；Client bundle 不含 Ops/Maint 文案，内部端不加载交易大厅/会员资源。
- 初始 JS ≤ 200KB gzip、CSS ≤ 50KB gzip、单张首屏图 ≤ 200KB。
- loading/error/not-found、AbortController、防 stale response、标准错误行为、表单重复提交保护齐全。
- 320/768/1024/1440 无非预期横向溢出；抽屉/对话框支持 ESC、focus trap、回焦、skip link 和 `aria-live`。
- 严格 CSP 使用每请求 nonce；nonce 页面动态渲染的性能影响纳入预算。
- 目标：LCP ≤ 2.5s、CLS ≤ 0.1、TBT ≤ 200ms；关键 E2E console error/warning 为 0，axe critical/serious 为 0。

## 13. 部署安全

三端和 Worker 使用独立最小 env/DB role；清理旧 Web unit、重复 3000 端口和重复 Nginx server name。Payment Worker 强制 disabled。部署使用 current/previous 原子链接，应用回滚目标 <5 分钟；数据库只做前向兼容 expand/contract。

本计划不执行生产 migration、DNS/TLS、真实 Email、真实 Demo smoke、真实支付、真实交易或真实退款。

## 14. 完成定义

只有稳定路由、机器可读 API policy、显式权限与 scope、真实状态、幂等事务、空/错/加载、响应式、可访问性、PG 集成测试、四身份浏览器 E2E、迁移/恢复演练、文档和外部 Gate 全部具备证据，模块才能标记 `CURRENT`。页面或表存在不等于闭环完成。
