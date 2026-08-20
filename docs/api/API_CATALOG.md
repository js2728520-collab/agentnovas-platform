# API 目录与迁移状态

日期：2026-08-20
范围：当前 `app/api/**/route.ts` 共 131 个 route 文件。

## 1. 使用说明

本目录记录接口所有权和迁移决定，不表示接口已经通过安全验收。目标所有权：`C` Client、`O` Operations、`M` Maintenance、`S` shared/machine。状态：

- `KEEP`：保留并按当前 audience 合同维护。
- `MIGRATE`：业务保留，但必须迁入目标应用 RBAC/data scope。
- `MERGE`：合并到新接口，旧接口进入弃用。
- `REVIEW`：安全/产品语义未完成，不得视为生产合同。
- `MACHINE`：供应商或 Worker 调用，使用签名/内部凭证而不是浏览器权限。

所有接口在受控测试前都必须进入可执行的 route policy 清单：允许 audience、认证方式、permission、data scope、PII policy、mutation sensitivity、rate limit 和审计类型。

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
| `/api/strategy-research/runs/[id]/answer` | POST | C | KEEP；当前缺失字段白名单 |
| `/api/strategy-research/runs/[id]/cancel` | POST | C | KEEP；幂等 |
| `/api/strategy-research/runs/[id]/candidates/[candidateId]/save` | POST | C | KEEP；所有权+幂等 |
| `/api/strategy-research/runs/[id]/events` | GET | C | KEEP；SSE 所有权 |
| `/api/strategy-research/runs/[id]` | GET | C | KEEP；所有权 |
| `/api/strategy-research/runs` | GET, POST | C | KEEP；幂等键、预算 |
| `/api/strategy-studio/chat` | POST | C | MERGE；旧流程退役计划 |
| `/api/strategy-studio/generate` | POST | C | MERGE；旧流程退役计划 |
| `/api/strategies/[strategyId]/versions/[versionId]/deployments` | POST | C | KEEP；仅 shadow/paper |
| `/api/strategy-deployments/[id]/cycles` | GET | C | KEEP；所有权 |
| `/api/strategy-deployments/[id]/pause` | POST | C | KEEP；所有权/幂等 |
| `/api/strategy-deployments/[id]/resume` | POST | C | KEEP；停控状态 |
| `/api/strategy-deployments/[id]` | GET | C | KEEP；所有权 |
| `/api/automation/demo-cycle` | POST | M | REVIEW；内部凭证、非浏览器 |
| `/api/automation/platform-ai-cycle` | POST | M | REVIEW；内部凭证、非浏览器 |
| `/api/trading-hall` | GET | C | REVIEW；七角色/现货边界/安全合同对齐 |
| `/api/trading/emergency-stop` | POST | O/M | MERGE；移除 Client 假控制，统一作用域安全控制 |

## 4. 策略市场、订阅与模拟订单（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/platform-strategies/[code]/follow` | POST | C | REVIEW；当前只允许模拟/准备状态 |
| `/api/platform-strategy-subscriptions/[id]` | PATCH | C | REVIEW；客户控制语义 |
| `/api/strategy-marketplace/[id]/backtest` | POST | C | KEEP；进度流与真实历史数据 |
| `/api/strategy-marketplace/[id]/change-request` | POST, GET, PATCH | C/O | MIGRATE；客户申请、Operations 审核 |
| `/api/strategy-marketplace/[id]/follow` | POST | C | KEEP；资格/执行环境约束 |
| `/api/strategy-marketplace/[id]` | GET, PATCH | C/O | MIGRATE；写操作进入策略治理 |
| `/api/strategy-marketplace/[id]/submit` | POST | C | KEEP；验证资格 |
| `/api/strategy-marketplace/[id]/versions` | POST | C | KEEP；版本不可变 |
| `/api/strategy-marketplace/refresh-inactive` | POST | O/M | REVIEW；内部任务化、审计 |
| `/api/strategy-marketplace` | GET, POST | C | KEEP；所有权/公开视图分离 |
| `/api/strategy-subscriptions/[id]` | PATCH | C | MERGE；与 platform subscription 收敛 |
| `/api/portfolio` | GET | C | KEEP；所有权、执行口径 |
| `/api/portfolio/strategies` | GET, POST, DELETE | C | REVIEW；资金隔离和重复分配 |
| `/api/public-pool` | GET | C | REVIEW；公开/客户数据边界 |
| `/api/risk/status` | GET | C | KEEP |
| `/api/simulated-orders/[id]` | PATCH | C | KEEP；模拟环境 |
| `/api/simulated-orders` | GET, POST | C | KEEP；不得接真实路由 |
| `/api/exchange-accounts/[id]/routing` | GET | C | REVIEW；只读路由资格 |
| `/api/exchange-accounts/[id]/perpetual-instruments` | GET | C | KEEP；仅自建策略研究，不属于官方现货三卡 |

## 5. 交易所、行情与平台公开信息（14）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/exchange-accounts/[id]` | PATCH | C | KEEP；所有权、密钥不回显 |
| `/api/exchange-accounts` | GET, POST | C | KEEP；无提现权限验证 |
| `/api/integrations/catalog` | GET | C/M | REVIEW；客户安全视图与运维详情拆分 |
| `/api/market/candles` | GET | C | KEEP；缓存、数据质量 |
| `/api/market/instruments` | GET | C | KEEP；现货/永续产品类型明确 |
| `/api/market/news` | GET | C | KEEP |
| `/api/market/quote` | GET | C | KEEP |
| `/api/market/ticker` | GET | C | KEEP |
| `/api/market/watchlist` | GET, POST, DELETE | C | KEEP；所有权 |
| `/api/platform/network` | GET | C | KEEP；未配置 IP 不伪造 |
| `/api/platform/settings` | GET | C | KEEP；只返回公开白名单字段 |
| `/api/health` | GET | S | REVIEW/P0；公开响应最小化 |
| `/api/integrations/payments/[provider]/webhook` | POST | S | MACHINE；签名、幂等、body 限制 |
| `/api/integrations/resend/webhook` | POST | S | MACHINE；Svix 签名、幂等、乱序保护 |

## 6. 钱包、通知、运营充值与账本（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/wallet/balances` | GET | C | KEEP；服务余额 |
| `/api/wallet/deposit-orders` | GET, POST | C | KEEP；未配置返回 503 |
| `/api/wallet/ledger` | GET | C | KEEP；不可变流水 |
| `/api/notifications/channels` | GET, POST, PATCH | C | KEEP |
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

## 8. Maintenance（8）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/maintenance/email/status` | GET | M | KEEP；安全视图 |
| `/api/maintenance/email/test` | POST | M | KEEP；原因、真实 configured_not_sent |
| `/api/maintenance/payment-providers/[id]/status` | PATCH | M | KEEP；敏感操作 |
| `/api/maintenance/payment-providers/[id]/test` | POST | M | KEEP；开关关闭 503 |
| `/api/maintenance/payment-providers` | GET | M | KEEP；安全视图 |
| `/api/maintenance/payment-workers/health` | GET | M | REVIEW；补真实心跳 |
| `/api/maintenance/platform-settings` | GET, PUT | M | KEEP；私有/公开字段分离 |
| `/api/maintenance/trading/emergency-stop` | GET, POST | M | KEEP；scope、原因、审计、Demo-only 自动平仓 |

## 9. 下一步

1. 把本目录转为机器可读 `api-policy.ts` 并在测试中验证 131 个 route 无遗漏。
2. 优先迁移标为 P0/REVIEW 的认证、组织、审批、health 和交易大厅接口。
3. 完成后再为核心合同扩展 `openapi-controlled-beta.yaml`；该 YAML 不是当前全部 131 个接口的授权证明。
