# 旧运营后台能力迁移与优化矩阵

日期：2026-08-20
原则：先盘点、再决定，不做无差别复制。业务能力进入 Operations，技术配置进入 Maintenance；重复、虚假或越权入口下线。

## 状态说明

- `CURRENT`：已经迁移到稳定路由，并有 RBAC/scope/真实状态/测试证据。
- `MIGRATE`：保持业务语义，接入新路由、RBAC、数据范围和审计。
- `REBUILD`：需求保留，但旧接口/页面安全或模型不合格，需要重构。
- `MERGE`：并入新模块，避免维护两套入口。
- `RETIRED`：不应继续存在。

## 能力矩阵

| 旧后台能力 | 现状 | 目标应用/路由 | 决定 | 必须优化 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 总览 KPI | 真实业务查询，错误时不回退静态数字 | Operations `/` | `CURRENT` | 持续校验口径和 p95 | P0 |
| 数据中心/客户经营分析 | 客户/会员/Paper/应收真实指标与 drill-down | Operations `/data-center` | `CURRENT` | 仅保留受控导出 | P1 |
| 员工任务、每日简报 | 服务端分页、scope 和写审计已接入 | Operations `/team` | `CURRENT` | 无 | P1 |
| 月度目标、导出、跟进 | 合并进团队工作台，受控 CSV 与跟进历史 | Operations `/team` | `CURRENT` | 无 | P1 |
| 组织关系树 | 使用 assignment-bound scope | Operations `/organization` | `CURRENT` | 无 | P0 |
| 成员创建/启停/删除 | 一次性 set-password 邀请，停用可恢复 | Operations `/organization` | `CURRENT` | 不提供物理删除 | P1 |
| 上下级关系变更 | maker-checker、版本锁和关系环验证 | Operations `/organization`、`/approvals` | `CURRENT` | 无 | P1 |
| 组织邀请码 | 有效期/撤销/使用审计 | Operations `/organization` | `CURRENT` | 无 | P1 |
| 客户列表/详情 | 服务端分页、字段 PII、统一 scope | Operations `/customers` | `CURRENT` | 无 | P0 |
| 客户备注历史 | 追加式历史与作者/时间 | Operations `/customers/[id]` | `CURRENT` | 无 | P1 |
| 客户冻结/恢复/归档 | 原因、session/能力撤销、通知和可恢复归档 | Operations `/customers/[id]` | `CURRENT` | 无 | P0 |
| 客户归属/转移 | maker-checker、有效期和历史链 | Operations `/customers/[id]`、`/approvals` | `CURRENT` | 无 | P1 |
| 旧通用审批队列 | 只做跨领域安全投影，决定回到各领域事务 | Operations `/approvals` | `CURRENT` | 无 | P0 |
| 官方/社区策略审核 | 官方三卡在 Ops 只读看业务影响；社区市场硬关闭 | Operations `/finance`、Maintenance `/models` | `RETIRED/MERGE` | GA 新立项才可恢复社区能力 | P0 |
| 充值查询、详情 | Beta 仅历史查询，PII/分页/筛选统一 | Operations `/deposits` | `CURRENT` | 创建继续关闭 | P0 |
| 充值人工操作 | 申请/不同人审批；不声称资金已执行 | Operations `/deposits/[id]`、`/approvals` | `CURRENT` | 创建继续关闭 | P0 |
| 只读账本 | 游标、scope、分录详情、不可变 | Operations `/ledger` | `CURRENT` | 无 | P0 |
| 月度收入报表 | 商业订单、Paper 应收和账本真实投影 | Operations `/finance` | `CURRENT` | 无 | P1 |
| 旧结算/collections/payout | 与本 Beta 人工会员/分成合同冲突 | Operations `/finance` | `RETIRED/BETA` | 写 API Policy 硬关闭 | P1 |
| 调整单与证据 | Credits 与商业纠正使用 maker-checker/不可变分录 | Operations `/credits`、`/finance` | `CURRENT` | 无 | P0 |
| 跟随策略政策 | 客户按官方卡自助启停，风险参数不可编辑 | Client `/paper` | `REBUILD/CURRENT` | 旧组织级策略政策退休 | P1 |
| 市场/新闻集成 | 代码固定公共只读目标，真实健康/陈旧/延迟 | Maintenance `/integrations/sources` | `CURRENT` | 无浏览器 URL | P1 |
| 系统 LLM 单配置 | 旧 API 返回 retired；Profile 为唯一真源 | Maintenance `/models` | `RETIRED/MERGE` | 无 | P0 |
| LLM Profile/Agent 绑定 | 版本、验证、绑定、回滚和密钥轮换 | Maintenance `/models` | `CURRENT` | 无 | P0 |
| 邮件/支付状态 | Email readiness 逐项；Payment 始终 disabled | Maintenance `/integrations/*` | `CURRENT` | 外部凭证未配置时安全降级 | P0 |
| Worker 健康 | DB heartbeat、queue age、migration 与固定阈值 | Maintenance `/health` | `CURRENT` | 无 | P0 |
| 全局紧急停止 | 仅暂停官方 Paper 新开仓，平台 Demo 单独控制 | Maintenance `/safety` | `CURRENT` | 无客户交易所/自动平仓副作用 | P0 |
| 业务授权审计 | audience 隔离、筛选和事件详情 | Operations `/access/audit` | `CURRENT` | 无 | P0 |
| 技术系统审计 | Demo/模型/集成/设置/安全/身份 allowlist 与关联 ID | Maintenance `/audit` | `CURRENT` | Worker 实时状态留在 `/health` | P1 |

## 付费 Beta 新能力与旧能力处置

| 能力 | 目标应用 | 决定 | Beta 合同 |
| --- | --- | --- | --- |
| 客户充值创建/链上地址 | Client | `RETIRED/BETA` | 充值页只读并显示未开放；无地址/二维码/监听 |
| 静态会员套餐/演示付款 | Client | `REBUILD` | 四档服务端计划、订单号、人工付款指引 |
| 会员付款凭证与权益激活 | Operations | `NEW` | maker/checker，同事务 entitlement/credits/ledger/audit |
| AI credits 充值 | Client | `RETIRED/BETA` | 只由会员和双审调整产生 |
| Credits 调整 | Operations | `NEW` | 不可变 ledger、非负、maker/checker |
| 客户模拟订单 | Client | `REBUILD` | 三卡独立 10,000 USDT server-owned paper portfolio |
| 客户交易所账户连接 | Client | `RETIRED/BETA` | 客户不上传密钥；未来真实执行独立立项 |
| 平台交易所测试账户 | Maintenance | `NEW` | OKX Demo/Binance Spot Testnet/Bybit Demo 安全视图 |
| Demo 执行意图与回执 | Maintenance/Client read view | `NEW` | 与 paper 完全隔离，固定限额与 kill switch |
| 周策略费/旧 collections | Operations | `REBUILD` | UTC 周 paper 净收益、高水位、应收/付款两段复核 |
| Telegram/WhatsApp 验证 | Client | `RETIRED/BETA` | 未接入、不可验证；不得返回演示验证码 |
| Payment Worker/自动入账 | Maintenance | `RETIRED/BETA` | 始终 disabled，不作为收费路径 |

## 旧代码退出条件

旧 `Admin` 页面和 legacy API 只有同时满足以下条件才能删除：

1. 矩阵中的能力已有明确 `CURRENT`、`RETIRED` 或产品负责人批准的延期结论。
2. 新接口完成 audience、RBAC、数据范围、PII、审计和并发验证。
3. 新页面完成真实数据、空/错/加载、敏感操作和浏览器验收。
4. 数据迁移或兼容读路径有回滚方案。
5. 旧 API 先观测调用量、发出弃用告警，再关闭；不能直接删除仍被外部客户端调用的合同。

## 推荐模块边界

```text
Operations
├─ Customers & Organization
├─ Team & Analytics
├─ Strategy Governance
├─ Service Deposits & Ledger
├─ Finance & Manual Settlement
└─ Business Access & Audit

Maintenance
├─ Models & Agent Bindings
├─ Email / Disabled Payment / Demo Exchange Integrations
├─ Worker, Queue & Database Health
├─ Safety Controls
├─ Platform Settings
└─ Technical Access & Audit
```
