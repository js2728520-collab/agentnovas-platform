# 旧运营后台能力迁移与优化矩阵

日期：2026-08-20
原则：先盘点、再决定，不做无差别复制。业务能力进入 Operations，技术配置进入 Maintenance；重复、虚假或越权入口下线。

## 状态说明

- `MIGRATE`：保持业务语义，接入新路由、RBAC、数据范围和审计。
- `REBUILD`：需求保留，但旧接口/页面安全或模型不合格，需要重构。
- `MERGE`：并入新模块，避免维护两套入口。
- `RETIRED`：不应继续存在。

## 能力矩阵

| 旧后台能力 | 现状 | 目标应用/路由 | 决定 | 必须优化 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 总览 KPI | 新 Operations 有基础概览，部分旧数字为聚合 | Operations `/` | `REBUILD` | 只用真实查询；查询失败不显示静态 KPI | P0 |
| 数据中心/客户经营分析 | 旧 `/api/data-center` 使用 legacy role | Operations `/analytics` | `REBUILD` | RBAC scope、指标口径、分页、脱敏 | P1 |
| 员工任务、每日简报 | 只在旧 Admin | Operations `/team` | `MIGRATE` | 查看/分派分权；组织树 scope；审计 | P1 |
| 月度目标、导出、跟进 | 只在旧 Admin | Operations `/team/targets` | `REBUILD` | 目标版本、跟进状态、真实导出任务 | P1 |
| 组织关系树 | 新端复用了旧接口 | Operations `/organization` | `REBUILD` | 新 RBAC/data scope；禁止 legacy bypass | P0 |
| 成员创建/启停/删除 | 只在旧 Admin | Operations `/organization/members` | `MIGRATE` | 邀请式初始密码、关系环、双审/审计 | P1 |
| 上下级关系变更 | 只在旧 Admin | Operations `/organization/members` | `REBUILD` | 事务、并发版本、影响范围预览 | P1 |
| 组织邀请码 | 只在旧 Admin | Operations `/organization/invitations` | `MIGRATE` | 有效期、使用次数、撤销、审计 | P1 |
| 客户列表/详情 | 新 Operations 已有基础页 | Operations `/customers` | `MERGE` | 详情、分页、字段级 PII、scope 集成测试 | P0 |
| 客户备注历史 | 旧 Admin 有单值/历史能力 | Operations `/customers/[id]` | `MIGRATE` | 追加式历史、作者、时间、不可静默覆盖 | P1 |
| 客户冻结/恢复/归档 | 新端有部分管理 | Operations `/customers/[id]` | `REBUILD` | 原因、影响预览、幂等、通知语义 | P0 |
| 客户归属/转移 | 只在旧 Admin | Operations `/customers/attributions` | `REBUILD` | 数据范围、跨组织双审、历史链 | P1 |
| 旧通用审批队列 | 旧 route 可直接改变多业务状态 | Operations `/approvals` | `REBUILD` | 按业务类型适配；事务/锁/幂等/禁止自审 | P0 |
| 官方/社区策略审核 | 功能分散，缺新端完整页 | Operations `/strategies/review` | `REBUILD` | 上/下架双审、证据、版本锁、作者不可审 | P0 |
| 充值查询、详情 | 新 Operations 已有 | Operations `/deposits` | `MERGE` | 统一 PII、分页、状态/渠道/网络筛选 | P0 |
| 充值人工操作 | 新端已有申请/审批 | Operations `/deposits/[id]`、`/approvals` | `MERGE` | 并发 DB 验收；批准不等于资金执行 | P0 |
| 只读账本 | 新端已有 | Operations `/ledger` | `MERGE` | 游标、scope、分录详情、不可变断言 | P0 |
| 月度收入报表 | 旧 Admin | Operations `/finance/revenue` | `MIGRATE` | 明确收入确认口径，去静态/重复计算 | P1 |
| 结算创建/查询 | 新端偏只读，旧端有创建 | Operations `/finance/settlements` | `REBUILD` | 状态机、审批、人工付款标识、幂等 | P1 |
| 应收与收款确认 | 新端偏只读，旧端有确认 | Operations `/finance/collections` | `REBUILD` | 证据、第二人复核、不可写成自动到账 | P1 |
| 付款资料/二维码 | 旧 Admin | Operations `/finance/payouts` | `REBUILD` | 敏感字段、对象存储引用、变更双审 | P1 |
| 调整单与证据 | 新/旧接口并存 | Operations `/finance` | `MERGE` | 反向分录、对象存储、申请/批准分权 | P0 |
| 跟随策略政策 | 旧 Admin | Operations `/policies/follow` | `MIGRATE` | 版本化、灰度、生效时间、审计 | P1 |
| 市场/新闻集成 | 旧 Admin | Maintenance `/integrations/data` | `REBUILD` | 数据质量、最后成功、延迟、密钥安全视图 | P1 |
| 系统 LLM 单配置 | 旧 Admin 与 Profile 重复 | Maintenance `/models` | `MERGE` | 合并到版本化 Profile，不保留第二真源 | P0 |
| LLM Profile/Agent 绑定 | 新 Maintenance 已有 | Maintenance `/models` | `MERGE` | 研发/产品运行/解释角色目录分离 | P0 |
| 邮件/支付状态 | 新 Maintenance 已有 | Maintenance `/integrations/*` | `MERGE` | configured/enabled/running/last success 分离 | P0 |
| Worker 健康 | 当前主要读取开关 | Maintenance `/health/workers` | `REBUILD` | 心跳、lease、队列、最近成功失败 | P0 |
| 全局紧急停止 | 旧 Client/Admin 存在假按钮；新 Maint 有作用域暂停 | Maintenance `/safety` | `RETIRED/MERGE` | 删除无行为按钮；只保留有权限、有原因、有审计的控制 | P0 |
| 业务授权审计 | 新 Access Center 有基础 | Operations `/access/audit` | `MERGE` | 当前 audience、筛选、事件详情 | P0 |
| 技术系统审计 | 分散 | Maintenance `/audit` | `REBUILD` | 认证、配置、集成、Worker、安全事件聚合 | P1 |

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
