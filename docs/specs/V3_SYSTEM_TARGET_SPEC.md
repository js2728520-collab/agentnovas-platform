# AgentNovas V3 系统目标规格

状态：`TARGET`；高风险能力按 Gate 解锁
日期：2026-08-23
上位真源：`../product/PRD.md`、ADR-0021

> **当前发布边界（2026-08-25）：** 本文是 V3 目标规格，不是当前发布授权。当前唯一发布范围是 S0——受控的 Paper/Demo 商业平台；Spot Live、USDT Perpetual、Withdrawal/Transfer 和 Maintenance CI/CD trigger 均为后续独立切片，继续保持关闭，必须分别通过自己的 Gate、授权和发布评审。

## 1. 目标架构

目标运行环境保持自托管 Linux、Node.js 22.21+、PostgreSQL、Nginx、Certbot 和独立 Worker/服务。不引入 Cloudflare Runtime 或 Redis。

部署单元：

- Client Web
- Operations Web
- Maintenance Web
- Runtime Worker
- Execution Service
- Notification Worker
- Payment Webhook/受控支付服务
- CI/CD 受限触发适配器
- PostgreSQL migrator

三端可以同仓库构建，但 audience、Cookie、端口、Host、数据库角色、环境变量、菜单、路由和 API Policy 独立。

## 2. 状态模型

每项能力标记 `CURRENT/PARTIAL/TARGET/BLOCKED/RETIRED/HISTORICAL`。运行状态区分：

- 配置：`unconfigured/configured`
- 开关：`disabled/enabled`
- 连接：`disconnected/connected`
- 健康：`unknown/alive/healthy/degraded/stale/failed`
- 外部动作：`not_sent/accepted/partial/filled/rejected/reconcile_wait`

环境变量或页面开关不能证明进程健康、外部请求成功或订单成交。

## 3. 身份、注册和会话

### 3.1 Client

- 邮箱与国际手机号必填，首期只验证邮箱。
- 最多 5 个并发设备会话。
- 新设备/异地通知和全量退出。
- 可重复客户邀请 token 与内部角色 token 完全分离。

实施状态（2026-08-23）：上述 Client 身份合同已完成代码、迁移和自动化并发验证；城市级
位置精度与第 6 台交互已由 ADR-0024 收口（网段判定、自动挤出并强制通知），真实邮件/浏览器/
目标 Nginx G1 证据尚未完成。

### 3.2 Operations

- 使用角色/权限注册链接自助注册。
- token 长期可重复使用，手动作废；重生成撤销旧 token。
- token 只存摘要，完整值只在生成时返回一次并禁止进入日志。
- 注册事务原子创建身份、账号、published assignment、scope 和审计。
- 生成者只能生成低于自身层级的角色链接。
- 注册无需人工审批。内部 MFA/recent MFA 能力与数据合同不变；当前准备阶段不强制，正式生产按 ADR-0023 三端统一开启。

### 3.3 Maintenance

不提供公开注册。管理员由受控 CLI 或更高权限的显式工作流创建，并使用最短会话；MFA/recent MFA 在正式生产启用开关后强制，当前阶段保留能力但不强制。

## 4. RBAC、组织与字段范围

RBAC 继续使用代码注册权限、published role/assignment、固定 data scope 和撤权 tombstone。

Operations UI 不提供组织树。数据库仍保存 organization、organization set、team、direct reports 和客户归属，供 scope resolver 使用。

字段权限独立覆盖手机号、邮箱、IP、设备、社交方式、资金汇总、交易账户和持仓。列表、详情、计数和导出共享同一个服务端授权谓词。

## 5. 行情平台

每个市场配置：provider、授权、symbols、时区、交易日历、K 线周期、实时协议、延迟阈值、stale 阈值、备用源和恢复校验。

- 加密货币默认 Coinbase fallback。
- 股票、外汇和贵金属使用各自合法主备源。
- 主源切换需要 symbol、时间戳、价格偏差和完整性校验。
- 陈旧数据不得触发新开仓。
- 行情事件携带 provider、exchange time、receive time、sequence 和 stale 状态。

实施快照（2026-08-24）：T2.1a/T2.1b 已提供 provider 独立 market/provider/calendar/capability
合同、严格事件 envelope、新鲜度与 `canOpenPosition` 服务端派生，以及当前四市场/40 标的的
加法式 instruments API。provider 独立的 sequence、连接、新鲜度、重连退避和 stale cache
纯状态机已实现；当前 Runtime 也已过滤未收盘 K 线，并按 K 线 cadence 阻断陈旧/非法行情的新开仓，
同时保持退出路径。真实 stream 综合准入尚未接入。当前公共源只标记 display/research 和 display-only，不声明 WebSocket、
生产授权或 execution。真实 provider 注册、账户/策略偏好、主备切换和 Runtime stale 接线仍未
完成，本节整体保持 `PARTIAL/TARGET`，G2 未解锁。

## 6. AI、策略和确定性内核

LLM 负责对话、需求结构化、候选策略、解释和反方意见。确定性代码负责 DSL 验证、数据规范化、回测、评分、准入、风险、仓位、费用、订单意图和状态转换。

策略版本不可变。客户投稿、审核、上架、下架和重大版本重审均形成审计事件。跟单绑定策略版本、账户、资本比例、风险参数和费用合同快照。

当前 S0 只允许在独立 G3 证据通过后纳入 Paper/Demo 策略市场与 Paper 跟单配置。目标费用合同不收固定策略订阅费，并固定 P-06 的 20% 实盘绩效分成、UTC 自然周、客户-策略高水位线、亏损周不收费、作者/平台 50%/50% 和已结算不退，但真实结算仍在 S0 外。S0 可保存不可变费用合同快照，并对 Paper-only 结果计算/展示模拟分成和作者/平台模拟分配，但必须明确标注“模拟、不可提现、未实际结算”；不得扣客户服务余额、生成真实应收/发票/作者收益余额、触发支付/退款或写入资金账本。真实订单跟单须通过 G4/G4A 的独立 provider/environment/product Gate；作者/平台真实分账、绩效分成结算和其它真实商业副作用须另行通过商业与账本 Gate。

## 7. Execution Service

Execution Service 是唯一长期持有客户交易凭证解密能力并签名订单的进程：

- 不接受公网入站。
- 每个交易所适配器独立 allowlist、精度、时间同步和限流。
- `clientOrderId` 确定性派生，重试幂等。
- 下单后查单，对账未知进入 `reconcile_wait`。
- 部分成交、手续费和平均价如实记账。
- 单账户失败不影响其他账户；交易所故障暂停新开仓但不阻断安全平仓。
- 按交易所、账户和策略提供 kill switch。

Paper、Demo、Live 共用确定性订单/记账数学，但使用不同 book、账户、回执和产品文案。

## 8. 实盘激活 Gate

实盘按 `(provider, environment, product)` 独立激活。最低要求：

- 客户凭证无提现/划转权限且 IP 白名单有效。
- 平台账本与交易所余额/持仓完成对账。
- 客户完成实盘确认并绑定不可变风险参数。
- provider 通过真实最小额订单、撤单、部分成交、超时和查单验收。
- 订单、回执、对账、live book、绩效和审计端到端一致。
- 熔断、紧急平仓和恢复演练通过。

任一项缺失时，在发送外部请求前由单一 named gate 拒绝。

## 9. 资金出站

提现/划转使用与交易执行不同的权限、服务、密钥域和账本状态机。交易执行凭证永不具备资金出站权限。

资金出站规格至少包含网络、地址白名单、限额、冷静期、服务费、maker/checker、制裁/风险筛查、链上确认、对账、退款和事故恢复。在专项 Spec 完成前 endpoint 不存在或固定拒绝。

## 10. 计费和版本化配置

套餐、Credits、策略跟单绩效分成、作者分账、支付、退款、优惠、Prompt、技能、模型费率和功能开关全部版本化。策略跟单不收固定订阅费；P-06 的 20% 实盘绩效分成按 UTC 自然周和客户-策略高水位线计算，作者与平台按 50%/50% 分账，已结算费用不退款。历史订单和执行引用不可变快照。

S0 可以保留支付、退款和优惠的目标合同及服务端安全配置入口，但其运行时 consumer 与外部写入不属于 S0。独立商业/账本 Gate 通过前，状态必须保持并展示为 `not_configured`、`disabled` 或 `unverified`，不得声称支付成功、退款完成或优惠已应用，也不得扣服务余额/Credits、生成真实应收/发票/作者余额或写入资金账本。配置 `ACTIVE`、人工审批、连通或健康状态均不能替代外部结果事实。

高风险发布使用 draft/test/approve/schedule/activate/rollback 状态机，创建者不能批准自己。

实施快照（2026-08-26）：T3.1a 已提供不含秘密的通用 JSON 配置版本、测试、独立审批、
带时区调度、到期激活和历史回滚追加式内核/API；T3.1b 已提供 Maintenance 工作台、差异、
测试证据、时区预览、调度、current、激活和回滚控制，以及使用全局租约、数据库复核、专用
最小权限角色和健康告警的自动到期激活 Worker。T3.1c-FF1/FF2 已让
`client.strategy_research` 全局 v1 与用户/组织/应用版本/稳定百分比/独立时窗定向 v2 通过严格
schema、服务端确定性测试和 Client 最小权限网关接管策略研究 GET/POST；评估上下文由服务端
身份、部署元数据和时间提供，环境 Gate 仍是上限，配置只能进一步收窄。Prompt/Skill 的 PS1
合同与确定性 tester、PS2 Prompt consumer 和任务版本固定、PS3 Maintenance 工作台已有实现资产；
Prompt 仍须通过 T3.4a 独立证据/Gate，Skill runtime consumer 尚未实现并归入 S0 之外的 T3.4b。其他配置
消费者仍未实现，因此本节整体仍为 `PARTIAL/TARGET`；配置 `ACTIVE` 不表示运行时或发布已经通过。

主题与语言由两个独立偏好合同管理：T3.10b 的主题族/明暗模式仅保存在设备浏览器并通过同源
`storage` 事件同步，不进入账号、数据库或跨域；T3.11b2 的 Client locale 显式偏好写入账号并跨设备
同步，本地镜像用于首屏和公开/登录页。Client 默认英语并支持七语言，Operations/Maintenance 固定
`zh-CN`，系统邮件保持英语。具体解析、迁移和失败关闭语义分别以
`PLATFORM_THEME_PREFERENCE_SPEC.md` 与 `PLATFORM_LOCALE_SPEC.md` 为准。

## 11. Maintenance CI/CD 控制面

当前不可变发布证据表继续作为真源。V3 可增加预定义 workflow trigger：

- Maintenance 只传版本 ID、环境、动作、原因和幂等键。
- 适配器换取短期凭证，不保存长期 CI token。
- workflow 固定仓库、ref、环境和允许动作；禁止任意命令/参数。
- production 要求 staging 同制品成功、不同人批准和健康 Gate。
- 回调验签后追加部署事实；页面不根据触发请求直接显示成功。

## 12. API Policy

每个 method/path 登记 audience、auth、MFA、permissions、scope、PII、sensitivity、idempotency、rate/body limit、audit 和 feature gate。未登记 handler 构建失败。

新增目标 API 家族必须先写合同，再写迁移和实现：

- role registration links
- market-data source preferences/status
- community strategy lifecycle
- follow subscription/fees
- exchange account activation/live readiness
- live orders/reconciliation
- pricing/coupons/refunds
- CI/CD workflow triggers

## 13. 数据与迁移

- PostgreSQL 是唯一持久化真源。
- 金额使用定点 numeric/decimal，不使用 JS 浮点作为账本事实。
- 账本、订单、回执、审批、授权和发布事实追加式保存。
- 迁移要求 fresh、rerun、checksum、concurrency、N-1 compatibility、backup/restore 和 forward rollback 证据。
- 每个进程使用独立最小数据库角色并在启动时验证 `current_user`。

## 14. 安全与可观测性

- requestId/traceId 贯穿行情、决策、订单、对账、账本、收费和通知。
- secret、完整 endpoint、凭证明文、Webhook 原文和非必要 PII 不进入响应或日志。
- 外部调用具备超时、有限重试、熔断、幂等和安全错误码。
- 每个进程提供 liveness/readiness/heartbeat；公开健康只返回粗粒度。

## 15. 完成条件

目标系统只有在对应 Phase 的 API、数据、UI、测试、浏览器证据、Runbook、回滚和文档同时完成后才可把状态从 `TARGET/BLOCKED` 改为 `CURRENT`。
