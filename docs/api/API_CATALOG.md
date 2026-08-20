# API 目录与迁移状态

日期：2026-08-21
范围：当前包含 159 个 route 文件、203 个 HTTP method handler，全部进入同一机器可读 inventory。本文是人类索引，不替代 CI policy 证明。

## 1. 使用说明

本目录记录接口所有权和迁移决定，不表示接口已经通过安全验收。目标所有权：`C` Client、`O` Operations、`M` Maintenance、`S` shared/machine。状态：

- `KEEP`：保留并按当前 audience 合同维护。
- `MIGRATE`：业务保留，但必须迁入目标应用 RBAC/data scope。
- `MERGE`：合并到新接口，旧接口进入弃用。
- `REVIEW`：安全/产品语义未完成，不得视为生产合同。
- `DISABLED/BETA`：Route Handler 仍为历史兼容代码，但 Proxy 在进入 Handler 前固定返回 503；不属于 Beta 可达合同。
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
| `/api/account/llm-config` | GET, PUT | C | KEEP；客户私有模型配置 |
| `/api/account/llm-config/test` | POST | C | REVIEW；限流、原因、安全回执 |
| `/api/account/password` | POST | C/O/M | REVIEW；KDF、强认证与限流 |
| `/api/account/profile` | GET, PATCH | C | KEEP |
| `/api/auth/forgot-password` | POST | C | KEEP；内部 audience 404，需限流 |
| `/api/auth/login` | POST | C/O/M | KEEP；audience 登录资格，需限流/MFA |
| `/api/auth/logout` | POST | C/O/M | KEEP；只清当前 audience |
| `/api/auth/me` | GET | C/O/M | KEEP |
| `/api/auth/register` | POST | C | KEEP；邀请制，内部 audience 404 |
| `/api/auth/reset-password` | POST | C | REVIEW；一次性 token/限流/会话撤销 |
| `/api/auth/verify-email` | POST | C | KEEP |
| `/api/system/bootstrap` | POST | M | REVIEW/P0；一次性、内网、不可持续重置 |
| `/api/invitations` | GET, POST | O | MIGRATE；组织 scope、有效期、审计 |
| `/api/attributions/requests` | POST | O | MIGRATE；业务审批 |
| `/api/attributions/transfers` | POST | O | MIGRATE；跨组织双审 |

## 3. 模型、Agent、AI 与策略研发（31）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/admin/agent-role-bindings` | GET, PUT | M | MERGE；改为 Maintenance 命名空间 |
| `/api/admin/agent-role-bindings/test` | POST | M | MERGE；原因、审计、安全回执 |
| `/api/admin/follow-policy` | GET, PUT | O | MIGRATE；版本化业务政策 |
| `/api/admin/llm-config` | GET, PUT | M | MERGE；并入 Profile，停止第二真源 |
| `/api/admin/llm-config/test` | POST | M | MERGE |
| `/api/admin/llm-profiles/[id]` | PATCH | M | MERGE；迁入 Maintenance 模型命名空间 |
| `/api/admin/llm-profiles` | GET, POST | M | MERGE |
| `/api/admin/runtime-explanation-bindings` | GET, PUT | M | KEEP/MERGE；区分产品角色与解释角色 |
| `/api/admin/runtime-explanation-bindings/test` | POST | M | KEEP/MERGE |
| `/api/ai/conversations/[id]/messages/[messageId]/strategy` | POST | C | KEEP；所有权与 DSL 校验 |
| `/api/ai/conversations/[id]/messages` | POST | C | KEEP；流式输出、限额 |
| `/api/ai/conversations/[id]` | GET, PATCH | C | KEEP；所有权 |
| `/api/ai/conversations` | GET, POST | C | KEEP；所有权 |
| `/api/strategy-research/roles` | GET | C | KEEP；安全视图 |
| `/api/strategy-research/runs/**` | GET, POST | C | DISABLED/BETA；旧合同依赖客户永续账户，完成公共现货迁移前不可达 |
| `/api/strategy-studio/chat` | POST | C | MERGE；旧流程退役计划 |
| `/api/strategy-studio/generate` | POST | C | MERGE；旧流程退役计划 |
| `/api/strategies/[strategyId]/versions/[versionId]/deployments` | POST | C | DISABLED/BETA；旧部署依赖客户永续账户 |
| `/api/strategy-deployments/**` | GET, POST | C | DISABLED/BETA；legacy 永续部署整族不可达，官方 paper 使用 trading-hall/platform subscription 合同 |
| `/api/automation/demo-cycle` | POST | M | REVIEW；内部凭证、非浏览器 |
| `/api/automation/platform-ai-cycle` | POST | M | REVIEW；内部凭证、非浏览器 |
| `/api/trading-hall` | GET | C | REVIEW；七角色/现货边界/安全合同对齐 |
| `/api/trading/emergency-stop` | POST | C | DISABLED/BETA；旧路径会触达客户 Demo 账户，官方 paper 使用受控生命周期 |

## 4. 策略市场、订阅与模拟订单（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/platform-strategies/[code]/follow` | POST | C | REVIEW；当前只允许模拟/准备状态 |
| `/api/platform-strategy-subscriptions/[id]` | PATCH | C | CURRENT；`client.paper.manage`，官方 spot paper pause/stop |
| `/api/strategy-marketplace/**` | GET, POST, PATCH | C | DISABLED/BETA；社区市场、作者分润和治理进入 GA backlog |
| `/api/strategy-subscriptions/[id]` | PATCH | C | DISABLED/BETA；legacy subscription 不可达 |
| `/api/portfolio`、`/api/portfolio/strategies` | GET, POST, DELETE | C | DISABLED/BETA；改用官方 paper portfolio API |
| `/api/public-pool` | GET | C | REVIEW；公开/客户数据边界 |
| `/api/risk/status` | GET | C | DISABLED/BETA；旧状态依赖 customer exchange account |
| `/api/simulated-orders/**` | GET, POST, PATCH | C | DISABLED/BETA；改用服务端 official paper fills |
| `/api/exchange-accounts/**` | GET | C | DISABLED/BETA；客户不上传或读取交易所账户 |

## 5. 交易所、行情与平台公开信息（14）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/exchange-accounts/[id]` | PATCH | C | DISABLED/BETA；客户密钥与连接状态不可达 |
| `/api/exchange-accounts` | GET, POST | C | DISABLED/BETA；客户密钥与连接状态不可达 |
| `/api/integrations/catalog` | GET | C/M | REVIEW；客户安全视图与运维详情拆分 |
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
| `/api/integrations/payments/[provider]/webhook` | POST | S | MACHINE；签名、幂等、body 限制 |
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
| `/api/finance/adjustments` | POST | O | MIGRATE；申请/审批/反向分录 |
| `/api/finance/collections` | GET | O | MIGRATE |
| `/api/finance/collections/[id]/confirm-paid` | POST | O | MIGRATE；人工证据/复核 |
| `/api/finance/collections/refresh` | POST | O | REVIEW；任务化/幂等 |
| `/api/finance/payout-profiles` | GET, POST | O | MIGRATE；敏感变更 |
| `/api/finance/settlements` | GET, POST | O | MIGRATE；人工付款语义 |
| `/api/finance/settlements/[id]/paid` | POST | O | MIGRATE；人工付款证据与复核 |

## 7. 组织、团队、旧审批与数据中心（13）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/approvals` | GET | O | REBUILD；按业务类型适配 |
| `/api/approvals/[id]/decision` | POST | O | REBUILD/P0；事务、锁、幂等、自审 |
| `/api/data-center` | GET | O | MIGRATE；analytics RBAC/scope |
| `/api/employee/tasks` | GET | O | MIGRATE |
| `/api/organization/customers/[id]/notes` | POST | O | MIGRATE；追加式历史 |
| `/api/organization/customers` | GET, PATCH | O | MIGRATE；新 RBAC/scope |
| `/api/organization/members/[id]/activate` | POST | O | MIGRATE；强认证/审计 |
| `/api/organization/members` | GET, POST, DELETE, PATCH | O | REBUILD/P0；scope、关系环、敏感 mutation |
| `/api/team/daily-brief` | GET, POST, PUT | O | MIGRATE |
| `/api/team/monthly-targets/export` | GET | O | MIGRATE；导出权限/审计 |
| `/api/team/monthly-targets/follow-up` | GET, POST, PATCH | O | MIGRATE |
| `/api/team/monthly-targets` | GET, POST | O | MIGRATE |
| `/api/reports/monthly` | GET | O/C | REVIEW；拆分客户/运营口径 |

## 8. Maintenance

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/maintenance/email/status` | GET | M | KEEP；安全视图 |
| `/api/maintenance/email/test` | POST | M | KEEP；原因、真实 configured_not_sent |
| `/api/maintenance/payment-providers/[id]/status` | PATCH | M | KEEP；敏感操作 |
| `/api/maintenance/payment-providers/[id]/test` | POST | M | KEEP；开关关闭 503 |
| `/api/maintenance/payment-providers` | GET | M | KEEP；安全视图 |
| `/api/maintenance/payment-workers/health` | GET | M | KEEP；真实 heartbeat，configured/enabled/liveness/health/last result 分离 |
| `/api/maintenance/platform-settings` | GET, PUT | M | KEEP；私有/公开字段分离 |
| `/api/maintenance/trading/emergency-stop` | GET, POST | M | KEEP；scope、原因、审计、Demo-only 自动平仓 |
| `/api/maintenance/demo-exchanges` | GET | M | KEEP；账户安全视图，不回显密钥 |
| `/api/maintenance/demo-exchanges/[id]/control` | POST | M | KEEP；reason/recent MFA/幂等/kill 安全语义 |
| `/api/maintenance/demo-exchanges/[id]/verify` | POST | M | KEEP；固定测试域名、原因、幂等审计 |
| `/api/maintenance/audit` | GET | M | KEEP；Demo 控制/验证安全投影、cursor/filter |

## 9. 商业会员、Credits、Paper 与 Demo（Beta 新合同）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/membership/plans` | GET | C | KEEP；四档 v1 与七份可读正文；正文缺失/哈希不符时禁止创建订单 |
| `/api/membership/me` | GET | C | KEEP；trial/entitlement/到期状态 |
| `/api/membership/orders` | GET, POST | C | KEEP；人工付款，无地址/二维码，稳定幂等 |
| `/api/membership/performance-statements` | GET | C | KEEP；paper 模拟分成安全视图 |
| `/api/credits/me` | GET | C | KEEP；余额与累计不可变分录摘要 |
| `/api/trading-hall/paper/portfolio` | GET | C | KEEP；每卡 10,000 USDT 独立组合 |
| `/api/trading-hall/paper/trades` | GET | C | KEEP；服务端 paper history/cursor |
| `/api/operations/membership-orders` | GET | O | TARGET；scope/pagination/filter |
| `/api/operations/membership-orders/[id]` | GET | O | TARGET；凭证脱敏/审批历史 |
| `/api/operations/membership-orders/[id]/evidence` | POST | O | TARGET；maker/幂等/recent MFA |
| `/api/operations/membership-orders/[id]/submit` | POST | O | TARGET；状态锁定 |
| `/api/operations/membership-orders/[id]/decision` | POST | O | TARGET；checker/自审阻断/事务激活 |
| `/api/operations/credit-adjustments` | GET, POST | O | TARGET；maker-checker，不可负余额 |
| `/api/operations/credit-adjustments/[id]/decision` | POST | O | TARGET；exactly-once ledger side effect |
| `/api/operations/performance-statements/generate` | POST | O | TARGET；上一完整 UTC 周幂等生成 |
| `/api/operations/performance-statements/[id]/decision` | POST | O | TARGET；业务批准只形成应收 |
| `/api/operations/performance-statements/[id]/payment-evidence` | POST | O | TARGET；外部付款凭证 |
| `/api/operations/performance-statements/[id]/payment-decision` | POST | O | TARGET；复核后提交高水位 |
| `/api/maintenance/demo-exchanges/[id]/verify` | POST | M | KEEP；固定测试域名/权限检查 |
| `/api/maintenance/demo-exchanges/[id]/control` | POST | M | KEEP；enable/disable/kill/resume 与 card kill，reason/recent MFA/audit |
| `/api/maintenance/audit` | GET | M | KEEP；当前 Beta 的 Demo 技术动作证据；全域技术事件聚合进入 GA |

## 10. 下一步

1. 以机器可读 policy 扫描实际 route/method，零遗漏后生成本目录的状态摘要。
2. 先完成身份/access、商业事务、paper/Demo，再迁移 UI；legacy handler 未登记不得继续隐式暴露。
3. `openapi-controlled-beta.yaml` 只描述核心浏览器合同，不能替代完整 API Policy。
