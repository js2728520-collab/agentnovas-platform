# Riverton Capital 受邀付费 Beta 系统规格

> 文档状态：`CURRENT_BASELINE`。本文描述当前运行和硬关闭边界；V3 目标系统见 [`V3_SYSTEM_TARGET_SPEC.md`](V3_SYSTEM_TARGET_SPEC.md)。目标文档不自动解锁本文关闭的真实交易、资金出站或自动部署。

版本：2.0
状态：当前受控 Beta 系统规格；以测试和 Gate 证据判定完成度

## 1. 拓扑与信任边界

```text
Client Web ─────────┐
Client Auth Gateway ┤
Operations Web ─────┼── PostgreSQL（共享数据、逻辑隔离）
Maintenance Web ────┘       ├─ Notification Worker
                             ├─ Paper Runtime Worker
                             ├─ Demo Execution Worker
                             └─ Payment Webhook（独立 DB role）

Payment Worker：不部署 unit；优盾充值由同步地址 API + 验签 Webhook + Ops 双审完成
Legacy Research Worker：Beta 不启动，HTTP/租约/orchestrator/systemd 均硬关闭
真实交易/提现/划转/自动扣款：代码路径硬关闭
```

三个 Web 进程使用相同代码但独立 `RIVERTON_APP_AUDIENCE`、域名、端口、构建目录、Session Cookie、最小 env 和数据库角色。共享数据库不是共享授权；所有入口重新解析 audience、会话、MFA enforcement、权限与 assignment-bound data scope。

Client 使用两个不可继承、不可链式放大的数据库角色。`agentnovas_client_web` 只通过绑定当前有效 Client session token hash 的 `SECURITY DEFINER` gateway 完成会话、自助资料、MFA、注册 claim 和 reset consume，不能直接读取身份/邀请表；`agentnovas_client_auth` 只可执行登录身份投影、当前主体密码投影和找回密码发行三个精确 gateway，不能创建/完成 session、消费 reset 或继承 Web 角色。所有 gateway 由 migrator 持有、固定 `search_path`，过期但未 revoked 的 session 也必须失败关闭。Next 构建不打开数据库连接；运行时第一条 SQL 前同时校验 URL 用户名和 `current_user` 与 audience 一致。

Client 的两个连接是不同的能力边界，不是同一高权角色的两个别名：

| 连接变量 | 固定角色 | 允许能力 | 必须拒绝 |
| --- | --- | --- | --- |
| Client `DATABASE_URL` | `agentnovas_client_web` | 当前有效 session、注册邀请码和一次性 reset capability 所需的精确 gateway | 身份/邀请表直访；登录 hash 投影；任意其他客户或内部身份 |
| `CLIENT_AUTH_DATABASE_URL` | `agentnovas_client_auth` | `client_login_identity`、`client_self_password_identity`、`client_queue_password_reset` | 创建/完成 session；消费 reset；继承或切换为 Web/内部角色 |

每次部署必须从每个实际进程加载的连接串执行 `SELECT current_user`，记录“进程/连接变量/预期角色/实际角色”。Client 两条连接、Operations、Maintenance、Notification、Runtime、Demo、payment webhook 和 migrator 任一不匹配都失败关闭；Payment Worker 与 legacy Research 角色必须保持 `NOLOGIN`。

## 2. Audience 与路由

| Audience | 本地端口 | Cookie | 注册 |
| --- | ---: | --- | --- |
| `client` | 3000 | `rc_client_session` | 仅邀请/一次性设置密码 |
| `operations` | 3001 | `rc_ops_session` | 禁止 |
| `maintenance` | 3002 | `rc_maint_session` | 禁止 |

解析顺序：显式进程 audience → 配置 Host allowlist → 已知本地 Host/端口 → 404。未知生产 Host 不得默认为 Client。页面错误 audience 404；API 不因同一用户在其他应用有权限而跨 audience 回退。

稳定路由：

- Client：`/`、`/login`、`/legal/consent`、`/membership`、`/membership/orders`、`/credits`、`/performance-statements[/id]`、`/paper`、`/paper/[portfolioId]`、`/trading-hall`、`/work-records[/id]`、`/notifications`、`/account/security`、`/support`、`/wallet`、`/wallet/deposits`。
- Operations：`/`、`/customers`、`/organization`、`/team`、`/data-center`、`/membership-orders`、`/credits`、`/performance-statements`、`/deposits`、`/ledger`、`/finance`、`/approvals`、`/access`、`/access/audit`。

优盾充值数据流固定为：Client 同源+RBAC+幂等请求 → Client Web 使用安全 provider 视图和运行时 secret 调用专属 `*.udun.io` 节点生成地址 → Maintenance 公网 webhook 使用独立数据库角色验签/去重并推进 `MANUAL_REVIEW` → Operations maker/checker → 同事务平衡账本、钱包版本、订单、审计和通知。配置缺失返回 503；提现、划转和自动扣款 endpoint 不存在。
- Maintenance：`/`、`/models`、`/ai-usage`、`/work-records`、`/integrations/sources`、`/integrations/email`、`/integrations/payments`、`/integrations/demo-exchanges`、`/health`、`/safety`、`/settings`、`/settings/disclosures`、`/configurations`、`/releases`、`/access`、`/access/audit`、`/audit`。

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
- Client 注册要求国际手机号和邮箱，邮箱验证前身份保持 pending；验证 token 只存摘要，
  Email outbox 只存加密 token，重发按邮箱与可信网络限流且撤销旧 token。
- Client 设备 Cookie 与 Session Cookie 分离且只存摘要；同设备重登轮换，会话最多 5 个
  设备身份，第 6 台当前拒绝。新设备/网段变化双通道提醒，支持单设备和全量撤销。
- 邮箱+audience 登录失败 5 次/15 分钟；IP 30 次/15 分钟；找回使用更严格小时限额，存储在 PostgreSQL 以覆盖多实例。
- TOTP/recovery 完整实现与加密数据保留。当前 `MFA_ENFORCEMENT_ENABLED=false` 时三端直接发完整 session，内部 critical 操作不要求 recent MFA；正式生产三端统一设为 `true` 后，Operations/Maintenance 完成 TOTP 才发完整 session，critical 操作要求 15 分钟内 recent MFA。recovery code 始终单次使用并只保存 hash。
- Client 可选启用 TOTP；一旦启用，后续登录必须完成 TOTP 或消耗一枚 recovery code。启用/轮换只显示一次恢复码，服务器只存 hash。
- 密码修改/重置、冻结、撤权和恢复码重置撤销相关 session。
- HTTP bootstrap 在生产 404；CLI 仅在无内部管理员时一次成功并留审计。
- 内部邀请与重置只发送一次性 set-password link；响应、通知 payload、日志和 UI 不含临时密码或明文 token。
- 生产 Cookie 强制 `HttpOnly`/`Secure`/audience 专属；信任代理列表显式配置；敏感写操作校验 Origin/CSRF。

### 4.1 应用偏好

- `user_app_preferences` 以 `(user_id, app_audience)` 唯一保存 `locale`、`theme_mode` 和 `theme_palette`；三端偏好不会串用。
- `GET/PATCH /api/account/preferences` 的 audience 只从当前有效会话推导，不接受浏览器指定；PATCH 严格拒绝未知字段、空更新和当前应用不支持的语言，并以事务 upsert 后写审计。
- Client 支持 `en-US`、`zh-CN`、`zh-TW`、`ru-RU`、`es-ES`、`ja-JP`、`ko-KR`，默认英语；Operations/Maintenance 只支持 `zh-CN`、`en-US`，默认简体中文。
- `users.locale` 只作为 Client 首次迁移来源；内部端无显式记录时不继承该值。登录后服务端偏好覆盖本地值，匿名页使用 audience 隔离的本地值和安全默认顺序。
- 主题模式为 `system | light | dark`，调色板为 `classic | harbor | forest`。首帧脚本在绘制前同时恢复语言、模式和调色板；业务状态色不由调色板替换。

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
- `0030_commercial_disclosure_trial.sql`
- `0031_credit_adjustment_workflow.sql`
- `0032_operations_customer_org_hardening.sql`
- `0033_notification_email_suppression.sql`
- `0034_client_registration_rate_limit.sql`
- `0035_technical_audit_correlation.sql`
- `0036_pre_disclosure_trial_remediation.sql`
- `0037_bootstrap_system_role_permission_sync.sql`
- `0038_client_ai_runtime_credits.sql`
- `0039_maintenance_idempotency.sql`
- `0040_client_identity_rls.sql`
- `0041_release_version_management.sql`
- `0042_udun_deposit_gateway.sql`
- `0043_client_identity_gateway_hardening.sql`

`0041` 增加 Maintenance-only 的不可变版本、验证与部署事实。版本状态和环境 current 由追加事实投影；production 要求同版本 staging 成功，失败记录不改变 current，三表禁止更新/删除。`0042` 增加优盾 deposit-only 配置安全视图、签名回调证据、重放/地址/开放订单唯一约束和独立 payment webhook 角色。`0043` 以显式数据库角色 allowlist、强制 RLS 和精确 SECURITY DEFINER ACL 撤销 Client 对身份/邀请表的直接能力，并使未知/遗留数据库角色失败关闭。

`0044`–`0065` 继续建立审计防篡改、共享决策轮、Execution/Live book 失败关闭基础、可复用 Client/内部
角色邀请、USDT 会员价格和无资金出站权限边界；这些表或服务存在不代表真实交易、提现或自动部署已
开放。`0066`–`0068` 完成 Client 邮箱/五设备安全、可选 MFA 和 Operations PII 权限；`0069`–`0074`
完成版本化配置、到期激活 Worker、功能开关消费者、密码重置修复、locale 默认和 Maintenance AI
用量聚合；`0075`–`0076` 完成至少六个月工作记录保留、Client 订阅期间投影和 Maintenance 脱敏导出。
`0077`–`0087` 是受限 CI/CD 委派的失败关闭基础与证据事实，不因表/API 存在而成为 M1 可见菜单或获准生产触发；`0088` 让设备会话查询过滤过期、超时和撤销记录；`0089` 增加 audience 隔离的用户应用偏好、强制 RLS 和会话绑定的精确读写 gateway。
所有已应用文件不可修改；修复使用新的 forward migration。

数据库角色至少拆分为 migrator、client_web、client_auth、ops_web、maint_web、notification_worker、runtime_worker、demo_execution_worker 和 payment_webhook；legacy research 和 Payment Worker 不获得 Beta 业务写权限。

当前恢复证据覆盖至 `0076_maintenance_work_record_export.sql`：77 个迁移、154 张基础表已在隔离
PostgreSQL 16.14 完成 fresh、76→77 N-1、幂等复跑、双 migrator 并发和 custom dump 恢复；恢复前后
表集合、逐表行数和 migration registry 完全一致，临时资源已清理。新增、改名或 checksum 变化会立即
使该证据失效；必须按实际集合重新演练，不能手工递增数字或改 registry hash。

## 7. 账本、会员和 credits

- 账本命令使用来源幂等锁、账户/余额行锁、同币种借贷平衡、wallet version CAS，并在同事务写 audit/outbox。
- 已发布 transaction/posting 禁止 UPDATE/DELETE；修正只能 reversal。
- 会员订单保存 v1 计划价格快照；外部人工凭证经过 maker-checker 后幂等激活 entitlement 并发放 credits。
- Credits 使用独立不可变 ledger；reserve/settle/release 按模型费率和 provider usage 执行，余额不得为负。
- Client 只在优盾 deposit-only 配置、验签和权限 Gate 完整时从 provider 生成专属充值地址；未配置返回
  503，页面不生成静态地址或二维码。链上回调只进入人工复核，Operations maker/checker 通过后才同
  事务入账；Payment Worker、自动扣款、提现、划转和自动退款继续关闭。

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
- 通知类别/渠道偏好和账号时区下的成对免打扰时段以一个数据库事务保存；Email Worker 在 claim 事务内按 IANA 时区、DST 和跨午夜窗口延迟发送，不增加 attempt 或保留 lease；in-app 不受影响。安全与缴费通知不可关闭。
- Email 只有 domain、API key、webhook、模板、suppression、retention、allowlist 全部就绪并获显式授权才可发送；否则为 `configured_not_sent`。
- `0033` 从唯一可信映射的历史 bounce/complaint/suppressed 事件回填收件人 SHA-256；歧义映射跳过，数据库不新增收件人明文。
- Maintenance DTO 仅含 `hasSecret`、provider/environment、权限检查、最近验证/测试；不返回 Key、密文引用、完整端点或 raw webhook。
- 优盾仅作为 Client USDT deposit-only 通道；Payment Worker 仍 disabled，Webhook 验签后只进入人工复核，不构成自动支付路径。
- LLM endpoint 采用 provider host allowlist，拒绝私网 IPv4/IPv6、redirect 与 DNS rebinding，并配合出口控制。
- Client AI/策略请求只使用 Maintenance 发布并绑定的平台模型 Profile，按平台费率扣减 Credits；`/api/account/llm-config` 及测试入口在 Beta 失败关闭，Client 不接受 BYOK、客户 API Key 或私有模型端点。缺少可用平台 Profile、费率或可靠 usage 时返回真实 503/422，不回退假模型结果。
- Client 只读取 `client_ai_runtime_model_bindings` 安全投影，不读取 Profile 密文表；模型响应必须同时提供可靠 provider request ID 与 token usage。Credits 先原子预留，再按真实 usage 结算或释放；相同幂等键不得再次调用 provider。provider 已成功但进程在落库前崩溃时，平台承担无法证明的孤儿成本，客户预留释放并进入人工核对，不向客户重复扣费。
- Maintenance 公共源测试与紧急停控必须提供 8–128 字符 `Idempotency-Key`。键只保存 SHA-256；operation、actor、subject 与 payload 绑定，重放返回已持久化终态，冲突/处理中/超时待核对均失败关闭。公共源网络请求在 claim 事务外执行，避免持有数据库事务等待外部网络。

## 11. 可观测性与健康

每请求生成 `requestId`；七智能体和关键商业流程使用 `traceId`。JSON 日志记录 audience、actor ID、permission、result、latency 和安全错误码，不写 secret、完整 PII、token 或 raw webhook。

`worker_instances` 记录 worker type、instance、commit SHA、started/heartbeat、last success/failure、error code、current job。Maintenance 分别显示 configured/enabled/alive/healthy/stale，包含 queue depth/oldest age；告警阈值由 `lib/maintenance-health-metrics.ts` 固定并在 API 返回，运行手册记录响应动作。

技术审计聚合 Demo、模型、集成、商业设置、安全停控和身份/MFA allowlist，携带 requestId/traceId、安全错误码和游标；失败检查按 `error_code` 与安全投影状态显示为 failed，不会统一伪装为 succeeded；不返回 raw payload、幂等键、订单 ID、secret 或完整 PII。授权审计继续按 audience 保持独立。

公开 `/api/health/live` 与 `/api/health/ready` 只返回粗粒度状态；详细数据库、配置、队列、provider 和 Worker 诊断需要 `maint.system_health.view`。

## 12. 前端与 NFR

- audience server import 与 route-level lazy loading；Client bundle 不含 Ops/Maint 文案，内部端不加载交易大厅/会员资源。
- 初始 JS ≤ 200KB gzip、CSS ≤ 50KB gzip、单张首屏图 ≤ 200KB。
- loading/error/not-found、AbortController、防 stale response、标准错误行为、表单重复提交保护齐全。
- 320/768/1024/1440 无非预期横向溢出；抽屉/对话框支持 ESC、focus trap、回焦、skip link 和 `aria-live`。
- 三组调色板与明暗模式共六套主题，组件只消费 `--rv-*` 语义令牌；Client 七语默认英语，Operations/Maintenance 中英默认简体中文。M1.3 的覆盖合同、六主题和四断点浏览器证据已于 2026-08-29 完成；认证、错误页和邮件文案仍须在对应业务 Gate 做逐语言人工审校。
- 严格 CSP 使用每请求 nonce；nonce 页面动态渲染的性能影响纳入预算。
- 目标：LCP ≤ 2.5s、CLS ≤ 0.1、TBT ≤ 200ms；关键 E2E console error/warning 为 0，axe critical/serious 为 0。

## 13. 部署安全

三端和 Worker 使用独立最小 env/DB role；清理旧 Web unit、重复 3000 端口和重复 Nginx server name。Payment Worker 强制 disabled。部署使用 current/previous 原子链接，应用回滚目标 <5 分钟；数据库只做前向兼容 expand/contract。

本计划不执行生产 migration、DNS/TLS、真实 Email、真实 Demo smoke、真实支付、真实交易或真实退款。

## 14. 完成定义

只有稳定路由、机器可读 API policy、显式权限与 scope、真实状态、幂等事务、空/错/加载、响应式、可访问性、PG 集成测试、四身份浏览器 E2E、迁移/恢复演练、文档和外部 Gate 全部具备证据，模块才能标记 `CURRENT`。页面或表存在不等于闭环完成。
