# API 目录与迁移状态

日期：2026-08-21
范围：当前包含 178 个 route 文件、229 个 HTTP method handler，全部进入同一机器可读 inventory。本文是人类索引，不替代 CI policy 证明；精确数量由 `scripts/generate-api-route-inventory.mjs --check` 生成和校验。

## 1. 使用说明

本目录记录接口所有权和迁移决定，不表示接口已经通过安全验收。目标所有权：`C` Client、`O` Operations、`M` Maintenance、`S` shared/machine。状态：

- `KEEP`：保留并按当前 audience 合同维护。
- `CURRENT`：当前商用 Paper SaaS 的已实现、可达合同。
- `MIGRATE`：业务保留，但必须迁入目标应用 RBAC/data scope。
- `MERGE`：合并到新接口，旧接口进入弃用。
- `REVIEW`：安全/产品语义未完成，不得视为生产合同。
- `DISABLED/BETA`：Proxy 在进入 Handler 前固定返回 503，Handler 也应安全失败；不属于 Beta 可达合同。
- `MACHINE`：供应商或 Worker 调用，使用签名/内部凭证而不是浏览器权限。

所有接口在受控测试前都必须进入可执行的 route policy 清单：method/path、audience、认证/MFA、permission、assignment-bound data scope、PII policy、mutation sensitivity、idempotency、rate limit、body limit 和审计类型。未登记 handler 发布失败。

## 2. Access 与账户（26）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/access/assignments/[id]` | DELETE | O/M | KEEP；当前 audience，敏感撤销不可绕过双审 |
| `/api/access/assignments` | GET, POST | O/M | KEEP；当前 audience |
| `/api/access/audit` | GET | O/M | KEEP；当前 audience |
| `/api/access/change-requests/[id]/decisions` | POST | O/M | KEEP；禁止自审/重复决定 |
| `/api/access/change-requests` | GET, POST | O/M | KEEP；按 audience/status/limit |
| `/api/access/me/effective` | GET | C/O/M | KEEP；只返回当前应用权限 |
| `/api/access/permissions` | GET | O/M | KEEP；目录按当前应用过滤 |
| `/api/access/role-templates` | GET, POST | O/M | KEEP |
| `/api/access/roles/[id]/publish` | POST | O/M | KEEP；原因+审计 |
| `/api/access/roles/[id]` | PATCH | O/M | KEEP |
| `/api/access/roles` | GET, POST | O/M | KEEP；敏感角色进入审批 |
| `/api/account/llm-config` | GET, PUT | C | DISABLED/BETA；客户 BYOK、私有端点和私有密钥已硬关闭，Client 只使用平台 Profile |
| `/api/account/llm-config/test` | POST | C | DISABLED/BETA；不接受客户密钥测试 |
| `/api/account/password` | POST | C/O/M | KEEP；校验当前密码、Argon2id、撤销其他会话与审计 |
| `/api/account/profile` | GET, PATCH | C | KEEP |
| `/api/auth/forgot-password` | POST | C | KEEP；内部 audience 404，需限流 |
| `/api/auth/login` | POST | C/O/M | KEEP；audience 登录资格、共享限流；内部强制 MFA，Client 已绑定时要求 MFA |
| `/api/auth/mfa/**` | GET, POST | C/O/M | KEEP；内部强制、Client 可选绑定；恢复码只显示一次且仅存哈希 |
| `/api/auth/logout` | POST | C/O/M | KEEP；只清当前 audience |
| `/api/auth/me` | GET | C/O/M | KEEP |
| `/api/auth/register` | POST | C | KEEP；邀请制，内部 audience 404 |
| `/api/auth/reset-password` | POST | C | KEEP；一次性 token、共享限流和全量会话撤销 |
| `/api/auth/verify-email` | POST | C | KEEP |
| `/api/system/bootstrap` | POST | M | DISABLED/BETA；HTTP 固定关闭，内部管理员只能由空系统一次性 CLI 创建 |
| `/api/invitations` | GET, POST | O | CURRENT；组织 scope、一次性设置密码、有效期与审计 |
| `/api/attributions/requests` | POST | O | CURRENT；归属变更申请，不允许直接产生副作用 |
| `/api/attributions/transfers` | POST | O | CURRENT；不同人员复核、scope 与审计 |

## 3. 模型、Agent、AI 与策略研发（31）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/admin/agent-role-bindings` | GET, PUT | M | CURRENT；Maintenance 兼容命名空间，Profile 版本与绑定为唯一真源 |
| `/api/admin/agent-role-bindings/test` | POST | M | CURRENT；原因、recent MFA、审计与安全回执 |
| `/api/admin/follow-policy` | GET, PUT | M | CURRENT；Maintenance 平台业务政策，版本化审计 |
| `/api/admin/llm-config` | GET, PUT | M | DISABLED/BETA；旧单配置第二真源已退役 |
| `/api/admin/llm-config/test` | POST | M | DISABLED/BETA；改用模型 Profile 测试 |
| `/api/admin/llm-profiles/[id]` | PATCH | M | CURRENT；版本化修改与不可回显密钥 |
| `/api/admin/llm-profiles` | GET, POST | M | CURRENT；Profile 与安全状态投影 |
| `/api/admin/runtime-explanation-bindings` | GET, PUT | M | CURRENT；区分产品角色与解释角色 |
| `/api/admin/runtime-explanation-bindings/test` | POST | M | CURRENT；只返回净化测试结果 |
| `/api/ai/conversations/[id]/messages/[messageId]/strategy` | POST | C | KEEP；所有权与 DSL 校验 |
| `/api/ai/conversations/[id]/messages` | POST | C | CURRENT；平台 `report` Profile、可信 usage、Credits 预留/结算/失败释放与幂等重放 |
| `/api/ai/conversations/[id]` | GET, PATCH | C | KEEP；所有权 |
| `/api/ai/conversations` | GET, POST | C | KEEP；所有权 |
| `/api/strategy-research/roles` | GET | C | KEEP；安全视图 |
| `/api/strategy-research/runs/**` | GET, POST | C | DISABLED/BETA；旧合同依赖客户永续账户，完成公共现货迁移前不可达 |
| `/api/strategy-studio/chat` | POST | C | DISABLED/BETA；旧客户端历史透传接口固定 410，改用持久化对话 |
| `/api/strategy-studio/generate` | POST | C | CURRENT；平台 `proposal_a` Profile、可信 usage、Credits 与稳定幂等键 |
| `/api/strategies/[strategyId]/versions/[versionId]/deployments` | POST | C | DISABLED/BETA；旧部署依赖客户永续账户 |
| `/api/strategy-deployments/**` | GET, POST | C | DISABLED/BETA；legacy 永续部署整族不可达，官方 paper 使用 trading-hall/platform subscription 合同 |
| `/api/automation/demo-cycle` | POST | S | DISABLED/BETA；旧 HTTP Runtime 固定 410，使用独立 Worker |
| `/api/automation/platform-ai-cycle` | POST | S | DISABLED/BETA；旧 HTTP Runtime 固定 410，使用独立 Worker |
| `/api/trading-hall` | GET | C | CURRENT；七角色、现货 long-only、Paper/Demo 分离合同 |
| `/api/trading/emergency-stop` | POST | C | DISABLED/BETA；旧路径会触达客户 Demo 账户，官方 paper 使用受控生命周期 |

## 4. 策略市场、订阅与模拟订单（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/platform-strategies/[code]/follow` | POST | C | CURRENT；仅建立官方 spot Paper 订阅，不接触客户交易所 |
| `/api/platform-strategy-subscriptions/[id]` | PATCH | C | CURRENT；`client.paper.manage`，官方 spot paper pause/stop |
| `/api/strategy-marketplace/**` | GET, POST, PATCH | C | DISABLED/BETA；社区市场、作者分润和治理进入 GA backlog |
| `/api/strategy-subscriptions/[id]` | PATCH | C | DISABLED/BETA；legacy subscription 不可达 |
| `/api/portfolio`、`/api/portfolio/strategies` | GET, POST, DELETE | C | DISABLED/BETA；改用官方 paper portfolio API |
| `/api/public-pool` | GET | O | DISABLED/BETA；旧公共客户池未纳入 Beta，避免无专用 PII 权限的邮箱读取 |
| `/api/risk/status` | GET | C | DISABLED/BETA；旧状态依赖 customer exchange account |
| `/api/simulated-orders/**` | GET, POST, PATCH | C | DISABLED/BETA；改用服务端 official paper fills |
| `/api/exchange-accounts/**` | GET | C | DISABLED/BETA；客户不上传或读取交易所账户 |

## 5. 交易所、行情与平台公开信息（14）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/exchange-accounts/[id]` | PATCH | C | DISABLED/BETA；客户密钥与连接状态不可达 |
| `/api/exchange-accounts` | GET, POST | C | DISABLED/BETA；客户密钥与连接状态不可达 |
| `/api/integrations/catalog` | GET | C | DISABLED/BETA；不向 Client 暴露环境变量名称或平台配置状态，运维使用专用安全投影 |
| `/api/market/candles` | GET | C | KEEP；缓存、数据质量 |
| `/api/market/instruments` | GET | C | KEEP；现货/永续产品类型明确 |
| `/api/market/news` | GET | C | KEEP |
| `/api/market/quote` | GET | C | KEEP |
| `/api/market/ticker` | GET | C | KEEP |
| `/api/market/watchlist` | GET, POST, DELETE | C | KEEP；所有权 |
| `/api/platform/network` | GET | C | DISABLED/BETA；不向 Client 提供密钥连接网络信息 |
| `/api/platform/settings` | GET | C | KEEP；只返回公开白名单字段 |
| `/api/health` | GET | S | KEEP；公开粗粒度模式/时间，不含内部检查 |
| `/api/health/live` | GET | S | KEEP；进程存活，公开粗粒度 |
| `/api/health/ready` | GET | S | KEEP；数据库 readiness，公开粗粒度 |
| `/api/integrations/payments/[provider]/webhook` | POST | S | DISABLED/BETA；自动支付与供应商回调均未开放，Proxy/Nginx 双层拒绝 |
| `/api/integrations/resend/webhook` | POST | S | MACHINE；Svix 签名、幂等、乱序保护 |

## 6. 钱包、通知、运营充值与账本（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/wallet/balances` | GET | C | KEEP；服务余额 |
| `/api/wallet/deposit-orders` | GET, POST | C | DISABLED/BETA；历史地址也不返回，页面固定说明未开放 |
| `/api/wallet/ledger` | GET | C | KEEP；不可变流水 |
| `/api/notifications/channels` | GET, POST, PATCH | C | DISABLED/BETA；Telegram/WhatsApp 不接入，偏好仅走 email/in-app |
| `/api/notifications/inbox` | GET, PATCH | C | KEEP |
| `/api/notifications/preferences` | GET, PUT | C | KEEP；失败保留原值 |
| `/api/operations/deposit-action-requests/[id]/decisions` | POST | O | KEEP；第二人审批 |
| `/api/operations/deposit-action-requests` | GET | O | KEEP；当前 audience/scope |
| `/api/operations/deposits/[id]/action-requests` | POST | O | KEEP；原因、幂等 |
| `/api/operations/deposits/[id]` | GET | O | KEEP；PII policy |
| `/api/operations/deposits` | GET | O | KEEP；游标/筛选/scope |
| `/api/operations/deposits/statistics` | GET | O | KEEP；真实统计 |
| `/api/operations/ledger` | GET | O | KEEP；只读、游标/scope |
| `/api/finance/adjustments` | POST | O | DISABLED/BETA；使用 Credits/会员/分成领域化 maker-checker 接口 |
| `/api/finance/collections` | GET | O | DISABLED/BETA；旧自动收款口径退役 |
| `/api/finance/collections/[id]/confirm-paid` | POST | O | DISABLED/BETA；改用会员或分成付款证据与复核 |
| `/api/finance/collections/refresh` | POST | O | DISABLED/BETA；不启动自动收款刷新 |
| `/api/finance/payout-profiles` | GET, POST | O | DISABLED/BETA；Beta 不维护自动付款资料 |
| `/api/finance/settlements` | GET, POST | O | DISABLED/BETA；真实付款仍为领域化人工流程 |
| `/api/finance/settlements/[id]/paid` | POST | O | DISABLED/BETA；不可绕过领域凭证与不同人员复核 |

## 7. 组织、团队、旧审批与数据中心（13）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/approvals` | GET | O | CURRENT；统一投影各领域待审批项，数据范围一致 |
| `/api/approvals/[id]/decision` | POST | O | CURRENT；事务锁、幂等与自审阻断，副作用仍由领域服务完成 |
| `/api/data-center` | GET | O | CURRENT；真实统计、RBAC 与 scope |
| `/api/employee/tasks` | GET | O | CURRENT；当前人员工作队列与 scope |
| `/api/organization/customers/[id]/notes` | POST | O | CURRENT；追加式历史、原因与审计 |
| `/api/organization/customers` | GET, PATCH | O | CURRENT；列表/详情 scope 一致，PII 脱敏 |
| `/api/organization/members/[id]/activate` | POST | O | CURRENT；recent MFA、范围与审计 |
| `/api/organization/members` | GET, POST, DELETE, PATCH | O | CURRENT；关系环校验、一次性设置密码、敏感 mutation |
| `/api/team/daily-brief` | GET, POST, PUT | O | CURRENT；服务端 scope 与持久化数据 |
| `/api/team/monthly-targets/export` | GET | O | CURRENT；受控 CSV、权限与审计 |
| `/api/team/monthly-targets/follow-up` | GET, POST, PATCH | O | CURRENT；服务端分页与范围 |
| `/api/team/monthly-targets` | GET, POST | O | CURRENT；真实目标数据，不使用静态 KPI |
| `/api/reports/monthly` | GET | O | CURRENT；运营聚合口径与 scope，不向 Client 暴露 |

## 8. Maintenance

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/maintenance/email/status` | GET | M | KEEP；安全视图 |
| `/api/maintenance/email/test` | POST | M | KEEP；原因、真实 configured_not_sent |
| `/api/maintenance/integrations/catalog` | GET | M | KEEP；代码固定的公共数据/新闻目录，仅安全状态投影 |
| `/api/maintenance/integrations/[id]/test` | POST | M | KEEP；固定只读目标、5 秒超时、原因、recent MFA 与持久化幂等；外部请求不占用 DB 事务，同键不重复 fetch，拒绝浏览器 URL |
| `/api/maintenance/payment-providers/[id]/status` | PATCH | M | KEEP；敏感操作 |
| `/api/maintenance/payment-providers/[id]/test` | POST | M | KEEP；开关关闭 503 |
| `/api/maintenance/payment-providers` | GET | M | KEEP；安全视图 |
| `/api/maintenance/payment-workers/health` | GET | M | KEEP；真实 heartbeat，configured/enabled/liveness/health/last result 分离 |
| `/api/maintenance/platform-settings` | GET, PUT | M | KEEP；私有/公开字段分离 |
| `/api/maintenance/trading/emergency-stop` | GET, POST | M | KEEP；scope、原因、recent MFA 与持久化幂等；业务状态、Paper 限制、审计和幂等终态同事务，不调用客户交易所、不改变平台 Demo |
| `/api/maintenance/commercial-disclosures` | GET, POST | M | KEEP；平台产品身份、七正文草稿/提交与 readiness |
| `/api/maintenance/commercial-disclosures/[id]/decision` | POST | M | KEEP；不同人员发布/拒绝，版本不可覆盖 |
| `/api/maintenance/demo-exchanges` | GET | M | KEEP；账户安全视图，不回显密钥 |
| `/api/maintenance/demo-exchanges/[id]/control` | POST | M | KEEP；reason/recent MFA/幂等/kill 安全语义 |
| `/api/maintenance/demo-exchanges/[id]/verify` | POST | M | KEEP；固定测试域名、原因、幂等审计 |
| `/api/maintenance/audit` | GET | M | KEEP；Demo/模型/集成/设置/安全/身份 allowlist 安全投影，domain/action/status/cursor 与 requestId/traceId |

## 9. 商业会员、Credits、Paper 与 Demo（Beta 新合同）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/membership/legal-consent` | GET, POST | C | KEEP；所有已登录 Client 可读取；精确确认当前七正文，写入同源、幂等、独立审计，不创建订单或付款 |
| `/api/membership/plans` | GET | C | KEEP；四档 v1 与七份可读正文；正文缺失/哈希不符时禁止创建订单 |
| `/api/membership/me` | GET | C | KEEP；trial/entitlement/到期状态 |
| `/api/membership/orders` | GET, POST | C | KEEP；人工付款，无地址/二维码，稳定幂等 |
| `/api/membership/performance-statements` | GET | C | KEEP；paper 模拟分成安全视图 |
| `/api/membership/performance-statements/[id]` | GET | C | KEEP；客户本人账单快照与状态时间线，不返回内部 PII/凭证原文 |
| `/api/credits/me` | GET | C | KEEP；余额与累计不可变分录摘要 |
| `/api/trading-hall/paper/portfolio` | GET | C | KEEP；每卡 10,000 USDT 独立组合 |
| `/api/trading-hall/paper/trades` | GET | C | KEEP；服务端 paper history/cursor |
| `/api/trading-hall/paper/platform-demo-summary` | GET | C | KEEP；按 provider/card 的净化测试状态，不返回账户/订单/trace/secret，明确 customerImpact=false |
| `/api/operations/membership-orders` | GET | O | KEEP；scope/pagination/filter |
| `/api/operations/membership-orders/[id]` | GET | O | KEEP；凭证脱敏/审批历史 |
| `/api/operations/membership-orders/[id]/evidence` | POST | O | KEEP；maker/幂等/recent MFA |
| `/api/operations/membership-orders/[id]/submit` | POST | O | KEEP；状态锁定 |
| `/api/operations/membership-orders/[id]/decision` | POST | O | KEEP；checker/自审阻断/事务激活 |
| `/api/operations/credit-adjustments` | GET, POST | O | KEEP；maker-checker，不可负余额 |
| `/api/operations/credit-adjustments/[id]/decision` | POST | O | KEEP；exactly-once ledger side effect |
| `/api/operations/performance-statements/generate` | POST | O | KEEP；上一完整 UTC 周幂等生成 |
| `/api/operations/performance-statements/[id]/decision` | POST | O | KEEP；业务批准只形成应收 |
| `/api/operations/performance-statements/[id]/payment-evidence` | POST | O | KEEP；外部付款凭证 |
| `/api/operations/performance-statements/[id]/payment-decision` | POST | O | KEEP；复核后提交高水位 |
| `/api/maintenance/demo-exchanges/[id]/verify` | POST | M | KEEP；固定测试域名/权限检查 |
| `/api/maintenance/demo-exchanges/[id]/control` | POST | M | KEEP；enable/disable/kill/resume 与 card kill，reason/recent MFA/audit |
| `/api/maintenance/audit` | GET | M | KEEP；统一技术安全投影；授权审计仍在 `/api/access/audit` |

## 10. 下一步

1. 机器可读 inventory 是 229 个 method handler 的发布真源；本文仅维护人类可读的所有权与产品状态。
2. `DISABLED/BETA` 路径不得因未来重构重新暴露；重新启用必须先更新 PRD、ADR、policy、测试与页面合同。
3. `openapi-controlled-beta.yaml` 只描述核心浏览器合同，不能替代完整 API Policy。
