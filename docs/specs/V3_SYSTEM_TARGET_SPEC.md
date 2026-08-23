# AgentNovas V3 系统目标规格

状态：`TARGET`；高风险能力按 Gate 解锁
日期：2026-08-23
上位真源：`../product/PRD.md`、ADR-0021

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
位置与第 6 台交互按 ADR-0022 待确认，真实邮件/浏览器/目标 Nginx G1 证据尚未完成。

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

## 6. AI、策略和确定性内核

LLM 负责对话、需求结构化、候选策略、解释和反方意见。确定性代码负责 DSL 验证、数据规范化、回测、评分、准入、风险、仓位、费用、订单意图和状态转换。

策略版本不可变。客户投稿、审核、上架、下架和重大版本重审均形成审计事件。跟单绑定策略版本、账户、资本比例、风险参数和费用合同快照。

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

套餐、Credits、策略订阅、收益分成、作者分账、优惠、Prompt、技能、模型费率和功能开关全部版本化。历史订单和执行引用不可变快照。

高风险发布使用 draft/test/approve/schedule/activate/rollback 状态机，创建者不能批准自己。

实施快照（2026-08-24）：T3.1a 已提供不含秘密的通用 JSON 配置版本、测试、独立审批、
带时区调度、到期激活和历史回滚追加式内核/API。当前尚无 Maintenance 工作台、自动到期
激活 Worker 或具体配置消费者，因此本节整体仍为 `PARTIAL/TARGET`，不能把草稿或调度当作
业务配置已经生效。

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
