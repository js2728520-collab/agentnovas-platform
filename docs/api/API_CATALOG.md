# API 目录与迁移状态

> 文档状态：`CURRENT_BASELINE`。本文只登记当前真实 route 和 Policy，不提前虚构 V3 endpoint。V3 目标 API 家族见 [`../specs/V3_SYSTEM_TARGET_SPEC.md`](../specs/V3_SYSTEM_TARGET_SPEC.md)；每个家族只有在合同、实现和 Gate 完成后才能写入本目录并改为 `CURRENT`。

日期：2026-08-24
范围：当前包含 203 个 route 文件、268 个 HTTP method route，全部进入同一机器可读 inventory。本文是人类索引，不替代 CI policy 证明；精确数量由 `scripts/generate-api-route-inventory.mjs --check` 生成和校验。V3 Current→Target 的代码、数据库、页面、Worker 和 Gate 映射见 [`../architecture/CAPABILITY_MIGRATION_MATRIX.md`](../architecture/CAPABILITY_MIGRATION_MATRIX.md)。

## 0. V3 目标接口族（尚不是当前合同）

下列接口族来自 PRD V3.0。这里只记录所有权和依赖，不指定最终 path；详细设计、威胁模型、中央 Policy、迁移和测试完成后，才可把实际 route 加入后续章节。

| 接口族 | 所有权 | 当前状态 | 前置条件 |
| --- | --- | --- | --- |
| Operations 角色权限注册链接 | O | `CURRENT/PARTIAL` | 签发、复制、撤销、重生成、注册、限流和审计已落地；待 Client 会话子项与 G1 浏览器验收 |
| Client 可复用邀请与 5 设备会话 | C/O | `CURRENT/PARTIAL` | 邮箱验证、5 设备、提醒和全量退出已实现；待 G1 浏览器/邮件/目标 Nginx 证据 |
| 行情源偏好、provider 状态和主备切换 | C/M/S | `TARGET` | provider/symbol/calendar 合同，G2 |
| 客户策略投稿、审核、上架和下架 | C/O | `TARGET` | 策略版本、准入、作者权限，G3 |
| 跟单订阅、费用、参数和停止 | C/O/S | `TARGET` | 不可变快照、收费、风险，G3/G4 |
| 客户交易账户 live readiness | C/S | `PARTIAL/BLOCKED` | balance reconcile、activation，G4 |
| 真实订单、回执和对账 | S | `PARTIAL/BLOCKED` | Execution Service/provider Gate，G4A/G4B |
| 提现、划转和服务费 | C/O/S | `BLOCKED` | 独立资金 Spec 与 G5 |
| 套餐、Credits、退款和优惠版本 | M/C/O | `TARGET/PARTIAL` | 产品参数、双审、账本，G3/G6 |
| CI/CD workflow 触发与回调 | M/S | `BLOCKED` | 受限 workflow、短期凭证、G7 |

任何 `TARGET/BLOCKED` 接口都不得通过复用旧 route、隐藏参数或临时开关绕过中央 inventory。

> 迁移状态：`/api/invitations/staff-link` 与 `/api/organization/staff-register` 已切换到 V3 权限注册链接合同；内部 token 使用独立表、长期有效、只存摘要、注册即产生 active assignment。`/api/invitations/link` 仍是客户可复用邀请，二者不可互换。逐人创建成员和汇报关系写接口返回 `410 Retired`，历史待激活账号的兼容处理暂时保留。

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

本目录中标记 `recent MFA` 的策略实现均受服务端 `MFA_ENFORCEMENT_ENABLED` 约束：当前准备阶段为 `false`，其他权限、scope、Origin、幂等、限流和审计继续执行；正式生产按 ADR-0023 三端统一设为 `true` 后生效。

## 2. Access 与账户（33）

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
| `/api/account/sessions` | GET, POST, DELETE | C/O/M | CURRENT；列出/单会话撤销；POST 原子退出全部设备并清当前 Cookie |
| `/api/auth/forgot-password` | POST | C | KEEP；内部 audience 404，需限流 |
| `/api/auth/login` | POST | C/O/M | CURRENT；Client 强制已验证邮箱、原子 5 设备上限和新设备/网段变化提醒；MFA 强制由服务端开关控制，当前关闭 |
| `/api/auth/mfa/**` | GET, POST | C/O/M | KEEP；完整 TOTP/recovery 能力保留；恢复码只显示一次且仅存哈希；当前不强制登录挑战 |
| `/api/auth/logout` | POST | C/O/M | KEEP；只清当前 audience |
| `/api/auth/me` | GET | C/O/M | KEEP |
| `/api/auth/register` | POST | C | CURRENT；国际手机号和邮箱必填，创建 pending 身份与加密验证邮件；内部 audience 404 |
| `/api/auth/resend-verification` | POST | C | CURRENT；匿名同源、邮箱/网络双桶限流、非枚举响应并轮换旧验证 token |
| `/api/auth/reset-password` | POST | C | KEEP；一次性 token、共享限流和全量会话撤销 |
| `/api/auth/verify-email` | POST | C | CURRENT；24 小时摘要 token，消费后激活；浏览器 token 使用 URL fragment |
| `/api/invitations/staff-link` | GET, POST, PATCH, DELETE | O | CURRENT；五级向下授权、复制审计、手动作废和原子重生成；recent MFA 仅在生产强制开关开启时要求 |
| `/api/organization/staff-register` | POST | O | CURRENT；匿名但仅 Operations，同源、三桶限流、注册即 active assignment；返回当前 MFA enforcement 事实 |
| `/api/organization/members` | GET, POST, PATCH, DELETE | O | PARTIAL；GET 提供 scope-bound 平面账号目录；POST/PATCH 已 `410 Retired`，DELETE 禁用 |
| `/api/organization/members/[id]/status` | PATCH | O | CURRENT；严格低级角色/下级链路，停用同时撤销会话、令牌和签发链接 |
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
| `/api/ai/inferences/[id]/cancel` | POST | C | CURRENT；`client.paper.view`、同源和 Idempotency-Key；仅本人请求，取消/完成竞态决定 Credits 唯一终态 |
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
| `/api/market/instruments` | GET | C | KEEP/CURRENT；contract v1 加法式返回四个当前市场、canonical instrument 与公共 provider symbol 映射，保留旧字段；不声明 WebSocket、生产授权或 execution |
| `/api/market/news` | GET | C | KEEP |
| `/api/market/quote` | GET | C | KEEP |
| `/api/market/ticker` | GET | C | KEEP |
| `/api/platform/network` | GET | C | DISABLED/BETA；不向 Client 提供密钥连接网络信息 |
| `/api/platform/settings` | GET | C | KEEP；只返回公开白名单字段 |
| `/api/health` | GET | S | KEEP；公开粗粒度模式/时间，不含内部检查 |
| `/api/health/live` | GET | S | KEEP；进程存活，公开粗粒度 |
| `/api/health/ready` | GET | S | KEEP；数据库 readiness，公开粗粒度 |
| `/api/integrations/payments/[provider]/webhook` | POST | S | MACHINE；仅 `udun`，原始 body MD5 协议验签、时效、nonce/event/tx 防重放，使用独立 DB role；无提现动作 |
| `/api/integrations/resend/webhook` | POST | S | MACHINE；Svix 签名、幂等、乱序保护 |

## 6. 钱包、通知、运营充值与账本（19）

| 路由 | 方法 | 所有权 | 状态/说明 |
| --- | --- | --- | --- |
| `/api/wallet/balances` | GET | C | KEEP；服务余额 |
| `/api/wallet/deposit-orders` | GET, POST | C | CURRENT；GET 自身订单，POST RBAC/同源/幂等并从优盾生成真实专属地址；未配置返回 503 |
| `/api/wallet/ledger` | GET | C | KEEP；不可变流水 |
| `/api/notifications/channels` | GET, POST, PATCH | C | DISABLED/BETA；Telegram/WhatsApp 不接入，偏好仅走 email/in-app |
| `/api/notifications/inbox` | GET, PATCH | C | KEEP |
| `/api/notifications/preferences` | GET, PUT | C | KEEP；失败保留原值 |
| `/api/operations/deposit-action-requests/[id]/decisions` | POST | O | KEEP；第二人审批；批准 `APPROVE_CREDIT` 时原子写钱包、不可变账本、审计和通知 |
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
| `/api/maintenance/payment-providers/[id]/configuration` | PATCH | M | CURRENT；disabled 状态下配置非密钥币种映射，修改后强制重测 |
| `/api/maintenance/payment-providers/[id]/test` | POST | M | CURRENT；显式开关后调用优盾支持币种接口，不创建地址/交易 |
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
| `/api/maintenance/ai-usage` | GET | M | CURRENT（T3.9a）；`maint.ai_usage.view` 敏感只读；按 UTC 请求创建 cohort 聚合已预留 inference，返回可信成功 Token、settled Credits、已记录非取消失败率及组织快照质量/稳定伪名用户/模型 revision/Agent/功能/日期维度；默认 30 天、最大 90 天、高基数 Top 50，`no-store`；不返回原始用户 ID、PII、AI 内容、错误原文或模型凭证，失败率不代表系统/provider 可用率 |
| `/api/maintenance/configuration-versions` | GET, POST | M | CURRENT（T3.1a）；查询或幂等创建不含秘密的不可变配置草稿，按 `(kind,key,audience)` 并发分配版本号 |
| `/api/maintenance/configuration-versions/[id]/tests` | POST | M | CURRENT（T3.1c-FF1/FF2）；功能开关 v1/v2 只接收原因并由服务端生成确定性结果/证据；尚未注册的其他配置族保留人工 passed/failed 证据，审批后均禁止补写 |
| `/api/maintenance/configuration-versions/[id]/approval` | POST | M | CURRENT（T3.1a）；不同人员 approve/reject，创建者不可自审 |
| `/api/maintenance/configuration-versions/[id]/schedule` | POST | M | CURRENT（T3.1a）；登记带明确 UTC offset 的唯一生效时间 |
| `/api/maintenance/configuration-versions/[id]/activation` | POST | M | CURRENT（T3.1c-FF1/FF2）；到期激活或回滚到同流曾生效的已验证版本；`client.strategy_research` 从下一次请求按全局 v1 或定向 v2 判定，其他配置族不执行具体副作用 |
| `/api/maintenance/releases` | GET, POST | M | CURRENT；查询或幂等登记 SemVer/commit/artifact/migration 不可变版本身份 |
| `/api/maintenance/releases/[id]/verification` | POST | M | CURRENT；不同人员 approve/reject，recent MFA、证据摘要和不可变审计 |
| `/api/maintenance/releases/[id]/deployments` | POST | M | CURRENT；登记 staging/production deploy/rollback 成功或失败事实，不执行基础设施操作 |

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
| `/api/work-records` | GET | C | CURRENT；本人订阅期间的公共决策与组合准入摘要，游标分页、私有不缓存 |
| `/api/work-records/[id]` | GET | C | CURRENT；公共七阶段与本人模拟意图/成交安全投影，越权与不存在统一 404 |
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

1. 机器可读 inventory 是 268 个 method route 的发布真源；本文仅维护人类可读的所有权与产品状态。
2. `DISABLED/BETA` 路径不得因未来重构重新暴露；重新启用必须先更新 PRD、ADR、policy、测试与页面合同。
3. `openapi-controlled-beta.yaml` 只描述核心浏览器合同，不能替代完整 API Policy。
