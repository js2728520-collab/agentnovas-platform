# Riverton Capital 完整功能说明

> 文档状态：`CURRENT_BASELINE`。本文保留当前受控 Beta/Paper 的已实现功能事实；V3 目标功能见 [`FULL_PLATFORM_V3_FUNCTIONAL_DESCRIPTION.md`](FULL_PLATFORM_V3_FUNCTIONAL_DESCRIPTION.md) 和 [`PRD.md`](PRD.md)。两者不一致时，生产运行继续遵守本文硬关闭，开发目标遵守 V3 文档与 Gate。

状态：`CURRENT`，团队功能总览真源

文档版本：1.0

基线日期：2026-08-21

代码基线：`bef7a4c` 及其之前的集成提交
适用范围：5–20 名受邀客户的受控商业 Beta

## 1. 文档目的

本文面向产品、设计、研发、测试、运营、运维和发布人员，用一份文档说明当前产品具备哪些功能、由谁使用、如何流转、依赖什么权限、会产生什么状态，以及哪些能力仍被安全关闭。

本文是“功能地图”，不是数据结构或接口字段的第二套定义。发生冲突时按以下优先级处理：

1. `packages/contracts` 中的版本化业务合同和 `lib/rbac.ts` 权限目录；
2. API Policy inventory、PostgreSQL 迁移、领域服务和自动化测试；
3. PRD、System Spec、三端 Spec、七智能体合同和版本管理 Spec；
4. 本文的跨角色功能说明；
5. 原始用户说明书、原型、历史截图或口头描述。

本文不证明某个外部服务已经开通。Email、交易所 Demo、DNS、TLS、告警和生产数据库均必须以目标环境的真实验证证据为准。

## 2. 产品定义

Riverton Capital 是基于 AgentNovas 技术平台构建的 AI 策略研究和模拟交易服务。客户购买的是以下服务能力：

- 可解释、可追踪的七阶段智能决策过程；
- AI 稳健型、AI 平衡型、AI 激进型三张官方现货策略；
- 每张策略独立 `10,000 USDT` 的服务器托管 Paper 模拟组合；
- 策略研究、AI 助手、确定性回测和版本历史；
- AI Credits 使用额度；
- 站内通知、满足外部 Gate 后的 Email，以及人工运营支持；
- 周期化 Paper 模拟盈利分成账单和完整复核记录。

客户不在本平台存入交易本金，不上传交易所密钥，也不会通过本产品产生真实投资订单。平台交易所 Demo 账户只用于证明策略信号能否被测试环境接受，不代表客户真实成交。

## 3. 当前功能状态定义

| 状态 | 含义 | 对外表达规则 |
| --- | --- | --- |
| `CURRENT` | 代码、稳定路由、权限和相应测试已经存在 | 可以描述为“平台支持” |
| `CONFIG_REQUIRED` | 功能代码存在，但必须配置外部服务或目标环境 | 只能显示“未配置、已配置未发送、未验证”等真实状态 |
| `SAFE_DISABLED` | 产品或安全策略主动关闭，接口和 UI 均不得绕过 | 明确显示“Beta 未开放”或隐藏入口 |
| `RETIRED` | 旧功能已退出当前产品合同 | 不得重新挂回菜单或用旧接口继续提供 |

### 3.1 当前总体状态

| 功能域 | 状态 | 说明 |
| --- | --- | --- |
| Client、Operations、Maintenance 三端 | `CURRENT` | 单工程、单 PostgreSQL，按 audience 独立登录、Cookie、路由、菜单、权限和构建 |
| 邀请、登录、内部 MFA、会话管理 | `CURRENT` | Client 强制邮箱验证与 5 设备；内部端强制 TOTP；bearer token 仅存摘要 |
| 商业披露、Trial、会员订单 | `CURRENT` | 平台维护七类版本化正文，确认后才启动试用和商业能力 |
| AI Credits | `CURRENT` | 与钱包、Paper 和 Demo 资金隔离，余额不可为负 |
| 三张官方 Paper 组合 | `CURRENT` | 每卡独立 10,000 USDT，仅现货、仅做多、无杠杆 |
| 七智能体交易大厅 | `CURRENT` | 七阶段顺序、决策轮、Paper 回执和 Demo 安全摘要已落地 |
| 平台 Demo 交易所 | `CONFIG_REQUIRED` | 支持 OKX Demo、Binance Spot Testnet、Bybit Demo；没有凭证时不宣称已连接 |
| 站内通知 | `CURRENT` | 收件箱、已读、偏好和免打扰可用 |
| Email | `CONFIG_REQUIRED` | 域名、Key、Webhook、模板、suppression、allowlist 和 Worker 授权均满足后才能真实发送 |
| Telegram / WhatsApp | `SAFE_DISABLED` | 未接入、不可验证，不生成演示验证码 |
| 客户钱包与历史账本 | `CURRENT` | 只读服务余额，不代表客户交易本金 |
| 客户 USDT 充值 | `CURRENT` | 优盾专属地址、验签回调、maker/checker 入账；无二维码、无静态地址 |
| 会员收款和 Paper 分成收款 | `CURRENT` | 外部人工收款、站内凭证和双人复核，不自动扣款 |
| Payment Worker 和自动支付 | `SAFE_DISABLED` | 支付状态只读，不能从浏览器启用真实支付 |
| 真实现货、永续、提现、划转 | `SAFE_DISABLED` | HTTP、Worker、运行时和迁移层共同关闭 |
| 社区策略市场 | `RETIRED` | 当前 Beta 只提供三张官方策略 |
| 不可变版本发布控制面 | `CURRENT` | 记录版本、验证、部署和回滚证据，但浏览器不执行基础设施命令 |

## 4. 三应用一库架构

### 4.1 应用划分

| 应用 | 主要用户 | 核心职责 |
| --- | --- | --- |
| Client | 受邀客户 | 账号、披露、会员、Credits、策略研究、回测、Paper、七智能体、账单、钱包和通知 |
| Operations | 运营 maker、checker、客服、财务 | 客户、组织、会员凭证、双审、Credits 调整、周分成、账本、财务和业务 RBAC |
| Maintenance | 技术管理员、安全管理员、发布人员 | 模型、Agent 绑定、外部集成、Worker、紧急暂停、披露发布、版本发布、技术 RBAC 和审计 |

### 4.2 隔离方式

三端共享 Next.js 代码库、组件体系和 PostgreSQL，但不是一个“切换角色即可看全部”的后台。系统通过以下边界同时隔离：

- `RIVERTON_APP_AUDIENCE` 和部署域名确定当前应用；
- Client、Operations、Maintenance 使用不同名称的会话 Cookie；
- 登录接口校验账号是否有当前 audience 的登录资格；
- 页面路由只允许当前 audience 的稳定路由，错误应用路由返回 404；
- 菜单根据 `/api/access/me/effective` 的有效权限生成；
- 直接访问页面时再次执行前端权限守卫；
- API 使用中央策略声明 audience、认证、MFA、权限、数据范围和敏感等级；
- Operations 与 Maintenance 的角色、分配、审批和审计数据按 application ID 隔离；
- 三端分别构建，Client 初始资源不包含内部工作台功能代码。

### 4.3 登录和错误行为

- 未登录访问受保护页面：返回当前 audience 的登录流程，并保留 `next` 目标；
- 无当前应用登录资格：登录返回 403，不能借另一个 audience 的 Cookie 进入；
- 已登录但无模块权限：菜单隐藏，直接访问显示无权限页，API 返回 403；
- 未知 Host 或错误 audience 路由：返回 404；
- 401：当前会话失效，回到本应用登录页；
- 409：并发、重复审批、旧版本或状态冲突，展示具体业务原因；
- 422：输入不符合业务合同，保留用户原输入并展示原因；
- 429：登录或敏感操作达到频率限制，提示稍后重试；
- 503：外部服务未配置、Worker 未启用或安全 Gate 未满足，不生成假成功。

## 5. 身份、账号和会话功能

### 5.1 Client 身份流程

- Client 只接受邀请注册；国际手机号和邮箱均必填，邮箱验证前身份保持 pending；
- 支持登录、忘记密码、重置密码、24 小时邮箱验证和非枚举验证邮件重发；
- 登录失败和找回密码均使用通用响应，不泄露邮箱是否存在；
- Client 会话最长 7 天，闲置超过 24 小时失效；
- 用户可在“账号安全”修改姓名、邮箱、时区和密码；
- Client 可以自行启用 TOTP；启用前为可选，启用后每次登录必须提供动态验证码或一枚未使用的 recovery code；
- Client 可以在验证当前 TOTP/recovery code 后轮换 recovery codes；明文只显示一次，旧码立即失效；
- 修改密码会撤销所有会话；修改登录标识需校验当前密码，并撤销其他会话；
- 用户可以查看经过脱敏的设备和会话列表，并撤销本人非当前会话。
- 同一账号最多 5 个并发设备；同设备重登轮换 Session，第 6 台当前失败关闭而不静默挤出；
- 新设备和 IP 网段变化产生站内/Email 安全通知，用户可一键撤销包括当前设备在内的全部 Client 会话。

### 5.2 Operations / Maintenance 身份流程

- 内部端只有登录入口，不提供公开注册；
- 首次登录必须完成 TOTP 注册和六位动态码确认；
- 系统只在注册时展示 8 枚 recovery codes，后续不可回显；
- 内部会话最长 12 小时，闲置超过 1 小时失效；
- 关键操作要求最近 15 分钟内完成 MFA；
- 内部账号冻结、密码重置或撤权后，相关会话会被撤销；
- 浏览器不能通过 HTTP bootstrap 创建或重置管理员，首次内部管理员只能通过一次性 CLI 流程建立。

### 5.3 密码与登录保护

- 新密码使用 Argon2id；历史 PBKDF2 密码在成功登录后渐进升级；
- 登录按邮箱哈希与 audience、IP/部署连接桶实施并发安全限流；
- 忘记密码使用更严格的频率限制；
- 会话 Cookie 为 `HttpOnly`、`SameSite=Strict`，生产环境要求 `Secure`；
- 跨 audience Cookie 不能认证另一个应用。

## 6. Client 客户端功能

### 6.1 导航和稳定路由

| 路由 | 页面 | 主要功能 | 主要权限/条件 |
| --- | --- | --- | --- |
| `/` | 公开着陆页 | Riverton 产品介绍、策略边界和登录入口 | 公开，不启动客户会话树 |
| `/login` | 登录/邀请注册/找回 | 当前 audience 身份流程 | 公开页面；注册只允许 Client |
| `/dashboard` | 客户交易总览 | 展示三卡 Paper 权益、收益、运行状态、会员、积分、账单和通知摘要 | 已登录；按 Client 权限过滤 |
| `/legal/consent` | 商业披露 | 阅读并确认当前七类正文 | 已登录，独立于商业权限 Gate |
| `/membership` | 会员中心 | 查看计划、当前权益、创建人工付款订单 | `client.membership.view/order` |
| `/membership/orders` | 会员订单 | 查看订单号、计划快照、付款说明和真实状态 | `client.membership.view` |
| `/performance-statements` | 绩效账单 | 查看周 Paper 分成列表 | `client.membership.view` |
| `/performance-statements/[id]` | 账单详情 | 查看三卡拆分、高水位、费率和时间线 | 本人账单 |
| `/credits` | AI 积分 | 查看可用、预留、累计发放/消耗和不可变流水 | `client.credits.view` |
| `/paper` | 模拟组合 | 查看三张官方组合汇总、持仓、运行状态 | `client.paper.view` |
| `/paper/[portfolioId]` | 组合详情 | 查看单卡现金、权益、盈亏、持仓和成交 | 本人组合 |
| `/trading-hall` | 七智能体交易大厅 | 三卡、七角色、决策轮、Paper 和 Demo 证据 | `client.paper.view` |
| `/workspace` | 策略与 Agent | AI 助手、策略研究、策略 DSL、回测和版本历史 | 登录、`client.paper.view` |
| `/wallet` | 钱包与账本 | 只读服务余额和历史账本 | `client.wallet.view` |
| `/wallet/deposits` | 优盾 USDT 充值 | 创建真实订单、专属地址、链上与复核状态；未配置失败关闭 | `client.wallet.view`、`client.deposit.create` |
| `/notifications` | 通知中心 | 收件箱、已读、偏好、免打扰和渠道状态 | 已登录 |
| `/account/security` | 账号安全 | 资料、密码、设备会话和撤销 | 已登录 |
| `/support` | 支持与公告 | 公开客服渠道、公告和维护状态 | 已登录，披露 Gate 豁免 |

### 6.2 商业披露和 Trial

平台维护以下七类版本化正文：

1. 服务主体 `service_entity`；
2. 服务地区 `jurisdiction`；
3. 隐私政策 `privacy`；
4. 服务条款 `terms`；
5. 风险披露 `risk_disclosure`；
6. Paper 模拟收费说明；
7. 退款或不退款规则。

功能规则：

- 七份正文必须属于同一已发布 bundle，正文长度和 SHA-256 必须一致；
- 客户逐份阅读后一次性保存当前版本确认；
- 系统保存 document ID、版本、内容哈希、确认时间、可信代理解析的 IP 和 user-agent 摘要；
- 任一正文缺失、未发布或未确认时，新会员订单失败关闭；计划浏览、既有 Paper 数据与账户自助不被全局阻断；
- 确认成功后启动 3 天 Trial，而不是在邀请或登录时提前启动；
- 平台发布新版本后，客户需要确认新 bundle 才能继续商业功能。

### 6.3 会员计划与订单

四档计划完全由服务端合同返回，客户端不硬编码价格：

| 计划 | 价格 | 权益期 | 一次性 Credits | Paper 分成费率 |
| --- | ---: | ---: | ---: | ---: |
| 月卡 `monthly_v1` | USD 28 | 30 天 | 1,000 | 20% |
| 季卡 `quarterly_v1` | USD 58 | 90 天 | 3,000 | 20% |
| 年卡 `annual_v1` | USD 198 | 365 天 | 12,000 | 20% |
| 终身 `lifetime_v1` | USD 588 | 无到期 | 36,000 | 16% |

客户流程：

1. 查看当前计划和本人 entitlement；
2. 选择计划并创建订单；
3. 系统保存计划版本、金额、币种、权益天数、Credits 和费率快照；
4. 页面展示订单号和人工付款说明；
5. 页面不生成收款地址、二维码、倒计时或链上监听文案；
6. Operations maker 录入外部付款凭证并提交；
7. 不同 checker 批准后，系统在一个事务中激活权益、发放 Credits、写商业账本、事件、通知和审计；
8. 客户查看最终状态和时间，不把“已提交审批”显示成“已收款”。

会员订单状态：

```text
AWAITING_EVIDENCE → SUBMITTED → ACTIVATED
                            ├→ REJECTED
AWAITING_EVIDENCE/SUBMITTED └→ CANCELLED
```

权益状态包括 `TRIAL`、`ACTIVE`、`GRACE`、`READ_ONLY`、`EXPIRED`、`CANCELLED`。

### 6.4 AI Credits

Credits 是 AI 使用额度，不是 USDT、现金、Paper 本金或交易所余额。

- 展示可用余额、已预留余额、累计发放、累计消耗和版本号；
- 分录类型包括 `GRANT`、`RESERVE`、`SETTLE`、`RELEASE`、`ADJUSTMENT`、`EXPIRY`；
- 会员激活或续费一次性发放对应 Credits；
- 付费 AI 请求在访问模型前按 `token-cost-v1` 费率预留；
- 只有供应商返回可靠 request ID、输入 token 和输出 token usage 时才结算；
- 实际用量低于预留时释放差额；失败时释放预留；
- 同一 Idempotency-Key 重放不重复调用供应商或扣减；
- 未配置模型费率、模型无法计量或余额不足时，系统明确拒绝请求；
- Credits 不允许为负；运营调整必须 maker-checker。

### 6.5 策略与 Agent 工作区

`/workspace` 保留 AgentNovas 原有策略研究能力，并置于 Client audience 会话和 Paper 权限之后，嵌入统一客户 Shell：

- 策略大厅展示官方策略、七阶段状态和真实记录入口；
- Agent 对话提供持久化会话、结构化回复和策略草稿保存；
- 行情页读取当前市场报价、K 线、关注列表和外部新闻可用性，不以静态 fallback 冒充实时行情；
- 交易中心复用官方 Paper 组合与成交体验，不连接客户交易所；
- 会员和账号安全入口复用当前服务端权益及身份状态；
- 持久化 AI 对话和消息历史；
- 流式显示模型回复和生成进度；
- 从服务端拥有的对话历史构造上下文，不接受浏览器伪造历史；
- 将符合合同的模型回复转换成私有策略草稿；
- 对策略 DSL 进行严格字段、方向、周期、风险和代码注入校验；
- 使用真实市场数据或明确的受控输入执行确定性回测；
- 展示收益、回撤、交易、数据来源、参数和警告；
- 支持多 Agent 研究运行、澄清问题、候选方案、事件进度和保存；
- 保存策略时创建不可变版本；
- 从历史版本恢复时创建新版本，不覆盖旧版本；
- 客户不能在工作区连接交易所、上传密钥或启动真实订单。

Maintenance 发布的模型 Profile 是唯一模型配置来源。Client 只能看到安全投影中的模型名称，不能读取 provider 密钥、完整端点或模型配置基表。

### 6.6 Paper 模拟组合

每个有效会员恰好获得三张相互隔离的组合：

- AI 稳健型：初始 `10,000 USDT`；
- AI 平衡型：初始 `10,000 USDT`；
- AI 激进型：初始 `10,000 USDT`；
- 三张同时运行时总初始模拟本金为 `30,000 USDT`。

每张组合独立维护：

- 现金、持仓、成本基础和最新估值；
- 已实现毛收益、模拟手续费、已实现净收益和未实现收益；
- BTC/USDT、ETH/USDT、SOL/USDT 的只多现货持仓；
- Paper 买入/卖出成交、价格、数量、名义金额和费用；
- 策略版本、决策轮 ID、`traceId` 和成交时间；
- Runtime 状态、部署 ID、模式、最后决策和周期序号；
- `ACTIVE`、`CLOSE_ONLY`、`READ_ONLY` 三种组合状态。

客户可以启动或停止允许的官方 Paper 策略，但不能修改本金、策略风险参数、持仓、成交或账本。会员到期后停止新开仓；存在持仓时只允许退出，清仓后进入只读。

### 6.7 七智能体交易大厅

交易大厅将每个策略决策拆成固定七阶段：

| 顺序 | 角色 | 核心问题 | 固定输出 |
| ---: | --- | --- | --- |
| 1 | 市场分析师 | 现在是什么市场？ | 市场分析报告 |
| 2 | 技术分析师 | 具体信号是否成立？ | 技术信号报告 |
| 3 | 策略研究员 | 如果交易，应该怎样做？ | 候选策略方案 |
| 4 | 反方审查员 | 这个方案为什么可能是错的？ | 反方审查报告 |
| 5 | 首席风控官 | 这笔交易是否被允许？ | 风险审批单 |
| 6 | AI 决策官 | 综合所有意见，最终怎么办？ | AI 最终决策单 |
| 7 | 交易执行员 | 如何生成 Paper 回执并记录独立 Demo 证据？ | 交易执行回执 |

交易大厅展示：

- 当前产品边界：现货、只多、无杠杆、无真实路由；
- 三张策略卡的版本、状态、执行模式、数据状态和持仓数；
- 七个角色的最近结论和更新时间；
- 决策轮列表和单轮七事件详情；
- 证据、确定性结论、可选 LLM 解释和解释生成状态；
- 决策轮是否 `complete`、`partial` 或 `legacy`；
- Paper 回执和独立的平台 Demo 安全摘要；
- 历史旧事件只作为 `legacy_audit` 证据，不伪装成完整七阶段。

风控和成交由确定性程序执行。LLM 只能提供研究或解释，不能越过风险拒绝、改变订单参数或直接发送订单。

### 6.8 钱包、充值和账本

- `/wallet` 展示历史平台服务余额、可用/冻结金额和不可变账本流水；
- 钱包、Credits、Paper 本金和平台 Demo 资金分别解释，不能合并成“总资产”；
- `/wallet/deposits` 仅从优盾签名接口生成专属 USDT 地址；验签回调进入人工复核，不提前显示到账；
- 页面无创建充值、链上地址、二维码、确认数监听或提现入口；
- 客户与 Operations 都可查询自身/授权范围内的优盾订单；只有 Operations 双审可入账。

### 6.9 通知中心

- 查看站内收件箱和通知分类；
- 标记单条或允许范围内的通知为已读；
- 保存站内和 Email 偏好；
- 以账户 IANA 时区保存成对免打扰时段，支持 DST 和跨午夜窗口；
- 站内通知即时可用；Email Worker 在免打扰结束后继续处理；
- 不可关闭的安全通知会明确说明原因；
- 保存失败不覆盖页面原值，动态结果通过 `aria-live` 宣告；
- Telegram/WhatsApp 显示“未接入、不可验证”。

## 7. 三张官方策略

### 7.1 统一边界

- 目标市场：USDT 现货；
- 允许标的：BTCUSDT、ETHUSDT、SOLUSDT；
- 方向：long-only；
- 杠杆、做空、funding、永续和客户交易所密钥：全部不允许；
- 最大同时持有资产：2；
- 行情、风控、持仓和成交由服务器计算；
- 三卡参数以 `packages/contracts/src/trading-hall.ts` 为唯一真源。

### 7.2 参数对比

| 参数 | AI 稳健型 | AI 平衡型 | AI 激进型 |
| --- | --- | --- | --- |
| 定位 | 低频参与明确趋势 | 趋势与震荡自适应 | 捕捉放量突破与动量 |
| 标的 | BTC、ETH | BTC、ETH、SOL | BTC、ETH、SOL |
| 市场状态周期 | 4h | 4h | 1h |
| 决策周期 | 1h | 1h、15m | 15m |
| 执行观察周期 | 5m | 5m | 5m |
| 典型持有 | 6 小时至 3 天 | 2 小时至 2 天 | 30 分钟至 12 小时 |
| 常规母单目标 | 3–5 | 5–8 | 5–10 |
| 单资产上限 | 15% | 25% | 35% |
| 总配置上限 | 25% | 50% | 70% |
| 单笔风险 | 0.3% | 0.5% | 0.8% |
| 日亏损停机 | 1% | 2% | 3% |
| 最大回撤 | 6% | 10% | 15% |
| 每日新开仓上限 | 2 | 4 | 6 |

## 8. 客户 Paper 与平台 Demo 的隔离

| 维度 | 客户 Paper | 平台 Demo |
| --- | --- | --- |
| 所有者 | 单个客户、单张官方策略 | 平台统一测试账户 |
| 初始资金 | 每卡 10,000 USDT 模拟本金 | 交易所测试环境资产 |
| 目的 | 形成客户模拟持仓、成交和绩效 | 验证测试环境是否接受策略意图 |
| 是否影响客户权益 | 是，影响客户 Paper 页面和模拟绩效 | 否 |
| 是否进入分成计算 | 是，只计算已平仓 Paper 净收益 | 否 |
| 失败影响 | 按 Paper 风控和状态处理 | 只记录 provider-specific failure，不改变 Paper |
| UI 文案 | “Paper 模拟成交” | “平台测试账户，不代表客户真实成交” |
| 密钥 | 客户不提供任何密钥 | 平台密钥加密保存，浏览器只见 `hasSecret` |

支持的测试环境：

- OKX Demo，强制模拟交易标记；
- Binance Spot Testnet，只允许测试网现货域名；
- Bybit Demo，只允许隔离 Demo Trading 域名。

安全约束：

- 生产交易、提现、划转、杠杆和衍生品 endpoint 不在 allowlist；
- 每个 provider、策略卡和决策轮使用确定性 clientOrderId；
- 默认单笔测试名义金额不超过 10 USDT；
- 单 provider 每日测试名义金额不超过 100 USDT；
- provider 和策略卡均有 kill switch；
- 超时后先查询已存在订单，不盲目重试；
- 未配置、暂停、未验证、失败、重试等待、对账等待和隔离状态分别展示；
- CI 只运行净化 fixture，不发送真实外部请求。

## 9. 周 Paper 盈利分成

### 9.1 计算口径

- 周期：UTC 周一 00:00:00 至周日 23:59:59；
- 范围：客户三张官方策略在该周期内已平仓的 Paper 成交；
- 净收益：已实现毛收益减 Paper 开仓和离场模拟手续费；
- 不计算未实现收益、平台 Demo 盈亏、funding、杠杆、做空或客户钱包；
- 三张策略先分别列示，再按客户合并；
- 计费基数：`max(0, 累计净已实现收益 - 已结算高水位)`；
- 亏损自然结转，重新超过高水位前不产生新费用；
- 月、季、年计划费率 20%，终身计划 16%；
- 使用账单周期对应的 entitlement 和计划快照，后续改价不影响历史。

### 9.2 状态与复核

```text
生成并提交 SUBMITTED
  ├─ 无费用 → CLOSED_NO_FEE
  ├─ 业务拒绝 → REJECTED
  └─ 业务批准 → APPROVED → INVOICED
                              ├─ 付款拒绝/补证
                              └─ 付款复核 → PAID
```

- maker 幂等生成上一完整周；
- 不同 checker 批准计算结果，批准只形成应收；
- 另一角色记录外部付款凭证；
- 不同 checker 复核付款后才标记 `PAID` 并提交新高水位；
- 存在已批准未支付账单时，不生成重叠账单；
- 重算通过 revision 和 replacesStatementId 保留历史，不覆盖原账单；
- 客户详情展示创建、业务审批、应收、付款证据和支付结论时间线。

## 10. Operations 运营端功能

### 10.1 导航和职责

| 路由 | 页面 | 功能 |
| --- | --- | --- |
| `/` | 运营概览 | 基于真实查询展示客户、充值、审批和业务状态，不用静态 KPI 回退 |
| `/customers` | 客户管理 | 客户列表、搜索、筛选、详情、脱敏、备注、冻结/恢复、归属 |
| `/organization` | 组织架构 | 组织树、成员、邀请、启停、上下级关系和邀请码 |
| `/team` | 团队目标 | 日常任务、每日简报、月度目标、跟进历史和受控 CSV |
| `/data-center` | 数据中心 | 客户、会员、Paper、应收等真实运营指标和 drill-down |
| `/membership-orders` | 会员订单 | 凭证录入、提交、checker 决定和激活回执 |
| `/performance-statements` | 周分成 | 生成、业务审批、付款证据、付款复核和争议证据 |
| `/credits` | Credits | 客户余额、流水、调整申请和审批 |
| `/deposits` | 充值订单 | 优盾真实列表、详情、脱敏、maker 申请与 checker 原子入账 |
| `/ledger` | 账本查询 | 不可变交易、分录详情、币种/类型/时间筛选和游标分页 |
| `/finance` | 财务结算 | 会员订单、Paper 应收和账本的真实业务投影 |
| `/approvals` | 审批中心 | 跨业务安全投影，决定仍由各领域事务执行 |
| `/access` | 角色权限 | 权限目录、模板、角色、发布、分配和敏感变更 |
| `/access/audit` | 授权审计 | Operations audience 授权事件筛选和详情 |
| `/account/security` | 账号安全 | MFA、recovery codes、密码和会话 |

### 10.2 客户管理

- 服务端分页、搜索和状态筛选；
- 列表与详情使用同一 data scope；
- 默认对邮箱、地址、交易哈希和敏感字段脱敏；
- 只有 `ops.deposits.pii_reveal` 等精确权限可以查看相应完整字段；
- 备注为追加式历史，记录作者和时间；
- 冻结、恢复和归档要求原因，并撤销相应会话或能力；
- 客户归属变更使用 maker-checker、版本锁和完整历史链；
- 不提供不可恢复的客户物理删除。

### 10.3 组织和邀请

- 查看 assignment-bound scope 内的组织树和成员；
- 创建内部或客户邀请时只生成一次性 set-password 链接；
- API、通知和页面不返回临时密码；
- 成员停用可恢复，不能通过物理删除绕过审计；
- 上下级变更检查关系环、跨组织和授权范围；
- 高风险关系变更先提交，交由不同 checker 决定；
- 邀请码具有有效期、撤销、使用次数和审计记录。

### 10.4 会员付款复核

maker 可以：

- 查看 scope 内订单和不可变计划快照；
- 录入脱敏外部付款 reference、金额、币种、时间和原因；
- 提交订单进入复核。

checker 可以：

- 查看凭证摘要和订单版本；
- 批准或拒绝其他人提交的订单；
- 查看激活事务结果。

系统保证：

- 申请人不能自审；
- 同一凭证、幂等键或并发决定不会重复激活；
- 权益、Credits、账本、事件、outbox 和审计同事务；
- 页面区分“审批已记录”和“会员已激活”。

### 10.5 Credits 调整

- 查看客户 available/reserved 和不可变流水；
- maker 选择客户、方向、金额、来源并输入原因；
- 不同 checker 审批；
- 调整后余额不得为负；
- 批准事务写 Credits 分录、账户版本、商业账本和审计；
- 人工调整不能伪造模型 token usage。

### 10.6 充值历史和人工操作

- Beta 不允许创建新充值订单；
- Operations 只查询历史订单、统计、渠道、网络、状态和交易哈希；
- 列表和详情使用一致的 PII 脱敏策略；
- maker 可以为历史订单提交人工调查或处理请求并填写原因；
- 不同 checker 可以批准或拒绝；
- 审批结果只表示申请已记录，不表示链上资金或账本已自动变更。

### 10.7 账本与财务

- 账本按类型、币种、时间和 data scope 查询；
- 使用游标分页和稳定 tie-breaker；
- 金额使用十进制定点字符串，不用浮点数处理商业金额；
- 同币种借贷必须平衡；
- 来源幂等，账户版本使用 CAS；
- 已落账交易禁止更新和删除，纠错通过 reversal；
- 只返回当前 scope 安全分录，不泄露其他客户 counterparty；
- 财务页面聚合会员订单、Paper 应收和账本事实，不执行真实银行付款。

### 10.8 RBAC 和审批中心

- 查看 Operations 权限目录和角色模板；
- 创建角色草稿、配置权限和 data scope；
- 发布非敏感角色；
- 敏感角色和敏感授权进入变更申请；
- checker 批准后才生效；
- 分配可以限定 organization、organization set、team tree 和 direct reports；
- 删除最后一个 assignment 会保留撤权 tombstone，不恢复 legacy 权限；
- 申请人不返回自审按钮，服务端也再次拒绝；
- `/approvals` 只做跨域队列投影，具体决定回到会员、Credits、分成、组织或授权事务。

## 11. Maintenance 运维端功能

### 11.1 导航和职责

| 路由 | 页面 | 功能 |
| --- | --- | --- |
| `/` | 系统概览 | 数据库、Worker、队列、邮件、支付和配置摘要 |
| `/models` | 模型与 Agent | LLM Profile、不可变修订、测试、回滚和角色绑定 |
| `/integrations` | 服务集成 | Email、支付、Demo 和公共数据源总览 |
| `/integrations/sources` | 数据与新闻 | 固定公共只读源的配置、健康、陈旧和安全测试 |
| `/integrations/email` | 邮件服务 | 域名、Key、Webhook、模板、suppression、allowlist 和最近测试 |
| `/integrations/payments` | 优盾充值服务 | 安全配置投影、币种映射、连通测试、启停；无提现能力 |
| `/integrations/demo-exchanges` | Demo 交易所 | 测试账户安全视图、验证、暂停和 kill switch |
| `/health` | 系统健康 | Worker heartbeat、队列年龄、数据库、迁移和外部服务状态 |
| `/safety` | 紧急暂停 | 暂停或恢复官方 Paper 新开仓 |
| `/settings` | 平台与客服 | 客户端公开品牌、客服入口和维护公告 |
| `/settings/disclosures` | 商业披露 | 七类正文草稿、提交、第二人发布和 readiness |
| `/releases` | 版本发布 | 候选版本、验证、环境 current、部署和回滚证据 |
| `/access` | 角色权限 | Maintenance 权限、角色、分配和敏感审批 |
| `/access/audit` | 授权审计 | Maintenance 授权事件 |
| `/audit` | 技术审计 | 模型、Demo、集成、设置、安全和身份事件 |
| `/account/security` | 账号安全 | MFA、recovery codes、密码和会话 |

### 11.2 模型 Profile 和 Agent 绑定

- 创建模型 Profile 时校验 provider、model、允许的 HTTPS endpoint 和密钥；
- 私有地址、回环、危险重定向和 DNS rebinding 目标被拒绝；
- 保存后页面只显示 provider 名、模型名、`hasSecret` 和状态；
- 完整 endpoint、API Key 和加密引用不回显；
- 每次编辑创建不可变修订；
- 回滚通过复制历史快照创建新修订，不改旧记录；
- Research Agent 与 Runtime 解释 Agent 分开绑定；
- 读取权限和修改权限分离；
- 连通测试要求原因，并记录成功、失败和安全错误码；
- 硬风控和交易结论不由模型 Profile 控制。

### 11.3 Email 集成

页面分别展示：

- 域名是否验证；
- API Key 是否存在；
- Webhook 是否配置且签名验证可用；
- 模板是否齐全；
- suppression 是否生效；
- Beta allowlist 是否配置；
- Notification Worker 是否 enabled、alive、healthy；
- 是否获得真实发送授权；
- 最近测试时间和结果。

状态必须区分：

- `not_configured`：缺必要配置；
- `configured_not_sent`：已配置但当前测试或策略没有发送；
- `enabled`：允许 Worker 处理；
- `alive/healthy/stale`：真实 Worker 运行证据；
- `sent/delivered/bounced/complained`：只来自真实 provider 回执。

所有用户事务邮件统一由 `noreply@agentnovas.com` 发出。账户安全、密码重置、会员和运营通知共用同一可审计 outbox，但按模板和通知类别隔离。运维端测试必须先写入真实队列，`queued` 只表示请求已记录；`sent`、`delivered`、`bounced`、`complained` 和 `suppressed` 只能由 Worker 或已验证的 Resend Webhook 推进。

`support@agentnovas.com`、`security@agentnovas.com`、`billing@agentnovas.com` 和 `operations@agentnovas.com` 是保留联系身份，不等于已开通的收件邮箱。只有企业邮箱路由与真实收件验收完成后，产品页面才可以把相应地址作为客户支持渠道展示。

### 11.4 支付集成

- 查看 provider、环境、渠道、网络、配置和 `hasSecret`；
- 不展示密钥、Webhook 原文或完整私有端点；
- 当前 Beta 的 effective status 必须为 disabled；
- 测试开关关闭时返回真实 503，不生成成功提示；
- 浏览器不能启用自动支付、自动扣款、链上地址或 Payment Worker。

### 11.5 数据、新闻和 Demo 集成

- 数据和新闻来源由代码固定目录定义，浏览器不能提交任意 URL；
- 状态区分 configured、enabled、health、stale 和最近延迟；
- 安全测试只访问固定 HTTPS 公共只读端点；
- Demo 账户只展示 provider、环境、权限检查、`hasSecret`、最近验证和错误码；
- 验证、暂停、恢复和 kill switch 需要精确权限和操作原因；
- Demo 外部写入还需要部署环境显式授权，页面权限本身不能绕过开关。

### 11.6 Worker 和系统健康

系统观测以下 Worker：

- Notification Worker；
- Demo Execution Worker；
- Strategy Research Worker；
- Strategy Runtime Worker；
- 保持关闭的 Payment Worker。

每个 Worker 上报实例、commit SHA、启动时间、heartbeat、最后成功/失败、当前任务和队列年龄。页面区分：

- `configured`：配置存在；
- `enabled`：策略允许启动；
- `alive`：最近有 heartbeat；
- `healthy`：工作结果和队列在阈值内；
- `stale`：heartbeat 或队列年龄超出阈值。

公开 `/api/health/live` 和 `/api/health/ready` 只返回粗粒度结果；详细数据库、队列、迁移和集成诊断只在 Maintenance 展示。

### 11.7 紧急暂停

- 只作用于官方 Paper 新开仓；
- 不自动平仓、不触碰客户真实账户；
- 有持仓的组合仍允许按确定性规则退出；
- 平台 Demo 有独立 provider/card kill switch；
- 启用和解除均要求 recent MFA、幂等键、原因和审计；
- 暂停状态不能被普通会员刷新或 Runtime 重启自动清除。

### 11.8 商业披露发布

- Maintenance maker 编辑平台身份和七类正文；
- 系统校验正文完整、长度、locale、版本和 SHA-256；
- maker 提交不可变快照；
- 不同 checker 批准后，新 bundle 生效，旧 bundle 进入 retired；
- 客户确认记录仍指向历史版本，不被覆盖；
- 申请人不能自审；提交和审批要求 recent MFA；
- readiness 页面直接指出缺失项，不使用假“已就绪”。

## 12. 版本发布管理

### 12.1 功能定位

`/releases` 是发布证据控制面。它保存已经由 CI/CD 或运维流程产生的事实，不从浏览器执行 `git push`、构建、数据库迁移、切流或回滚命令。

### 12.2 版本身份

每个候选版本必须包含：

- 以 `v` 开头的有效 SemVer tag；
- `beta` 或 `stable` channel；
- 40 位 Git commit SHA；
- 64 位构建产物 SHA-256；
- 形如 `0041_release_version_management` 的 migration version；
- 发布说明和登记原因；
- 登记人和时间。

Tag 与 commit 是版本身份真源；系统记录不能创建、移动或改写 Git tag。

### 12.3 权限和工作流

| 权限 | 能力 |
| --- | --- |
| `maint.releases.view` | 查看 runtime 身份、版本历史、验证和环境 current |
| `maint.releases.manage` | 登记候选版本和外部部署/回滚结果 |
| `maint.releases.approve` | 批准或拒绝其他人登记的候选版本 |

工作流：

1. maker 登记版本身份；
2. 不同 reviewer 录入验证证据 SHA-256、可选 GitHub Actions run URL 和原因；
3. 批准后版本从 `draft` 进入 `verified`，拒绝则进入 `rejected`；
4. 只能为 verified 版本登记 staging 部署结果；
5. production 成功必须已有同版本 staging 成功事实；
6. 每次部署或回滚追加不可变记录；
7. environment current 只由成功事实推进；
8. 新版本成为 current 后，旧版本进入 `superseded`；
9. 回滚成功后记录 `rolled_back` 和 previous release 关系。

版本状态包括 `draft`、`verified`、`rejected`、`deployed`、`superseded`、`rolled_back`。

系统拒绝：

- maker 自审；
- 同一 tag 指向不同 commit/artifact/migration；
- 未验证版本部署；
- 没有 staging 成功证据的 production 成功；
- production 回滚到从未在 production 成功过的版本；
- 更新或删除历史版本、验证和部署记录；
- 并发或重放导致重复状态推进。

## 13. RBAC 和数据范围

### 13.1 权限模型

权限按 audience 和动作拆分，例如：

- Client：会员查看/下单、Credits 查看、Paper 查看/管理、钱包查看；
- Operations：客户 view/manage、会员 evidence/approve、Credits adjust/approve、分成 generate/approve/payment、账本 view、角色 manage/assign/approve；
- Maintenance：模型管理、Agent 绑定、Email、Demo、紧急暂停、披露、版本、技术审计和角色审批。

敏感权限要求 recent MFA、原因、审计和必要时 maker-checker。

### 13.2 数据范围

Operations 支持：

- `SELF`：仅本人资源；
- `DIRECT_REPORTS`：直属下级；
- `TEAM_TREE`：授权团队树；
- `ORGANIZATION`：一个组织；
- `ORGANIZATION_SET`：显式组织集合；
- `PLATFORM`：平台范围。

列表、详情、计数、导出和审批目标必须使用同一 scope resolver。平台级权限也不能越过角色明确绑定的 organization/application 约束。

### 13.3 显式撤权

- 内部端没有显式 published assignment 时不回退 legacy 全权；
- 删除最后一个 assignment 会写撤权 tombstone；
- 角色发布、分配、撤权和敏感决定全部进入授权审计；
- Operations 和 Maintenance 的授权数据不能交叉读取。

## 14. API、安全和数据一致性

### 14.1 中央 API Policy

每个 method/path 必须登记以下属性：

- 允许 audience；
- public/session/machine 认证；
- MFA 和 recent MFA；
- 必需权限；
- data scope resolver；
- PII 等级；
- read/write/critical 敏感度；
- 幂等要求；
- 限流和请求体大小。

未登记 handler 会使 CI 失败。2026-08-23 的 inventory 检查覆盖 258 个 method route。

### 14.2 写请求保护

- 浏览器敏感写请求校验严格 Origin；
- 反向代理头只有在显式可信边界内才生效；
- 严格 schema 拒绝多余字段；
- 高风险写入要求 Idempotency-Key；
- request ID 贯穿响应和审计，关键业务同时携带 trace ID；
- 错误统一为 `{ error: { code, message, details? }, requestId }`；
- 未捕获异常不向浏览器暴露环境变量、SQL 或内部堆栈。

### 14.3 数据和迁移

- `postgres/migrations` 是生产迁移唯一真源；
- migration registry 保存版本、checksum、应用时间和 commit SHA；
- advisory lock 防止并发部署；
- 每个迁移文件独立事务；
- 已应用迁移不重复执行；checksum 不一致立即失败；
- 账本只追加、同币种平衡、来源幂等、账户加锁、禁止更新/删除，只能 reversal；
- 审计和 outbox 与业务状态在同一事务中提交；
- Web、Client、Operations、Maintenance 和 Worker 可以使用不同最小权限数据库角色。

## 15. 审计和可观测性

### 15.1 审计

系统记录：

- 登录、MFA、密码、会话和身份事件；
- 角色、assignment、撤权和敏感权限审批；
- 客户状态、组织关系和归属变更；
- 会员凭证、订单决定和权益激活；
- Credits 调整、预留和结算；
- Paper 分成生成、审批、付款和高水位；
- 模型 Profile、修订、回滚和 Agent 绑定；
- Email、数据源、Demo 和平台设置测试/变更；
- 紧急暂停；
- 商业披露发布；
- 版本验证、部署和回滚证据。

审计日志禁止保存密钥、完整 PII、Webhook 原文、临时 token 或 recovery codes。

### 15.2 指标和告警

需要观测：

- API 请求量、错误率、p50/p95/p99；
- 401/403、跨 audience 拒绝和 unknown Host；
- 数据库连接池、事务失败和迁移状态；
- Notification/Demo/Research/Runtime 队列深度和最老任务年龄；
- Worker heartbeat 和 stale；
- Email delivery、bounce、complaint 和 suppression；
- Demo provider 成功率、延迟、重复单和熔断；
- 邀请接受、披露确认、Trial、会员激活和到期；
- Credits 发放、消耗、释放和余额不足；
- Paper 决策轮、成交、未成交解释、策略停机；
- 分成生成、审批、付款和争议。

## 16. 前端体验和质量

### 16.1 通用状态

所有主要页面应具备：

- 骨架或明确加载状态；
- 无数据空状态；
- 请求失败和重试；
- 无权限状态；
- 提交中和重复提交保护；
- 409/422 的业务原因；
- 外部服务 503 的真实未配置说明；
- AbortController 或等价机制，避免旧请求覆盖新状态。

### 16.2 响应式和可访问性

- 320、768、1024、1440 像素视口无非预期横向溢出；
- 宽表格在窄屏使用可读卡片或受控横向滚动；
- 对话框支持 ESC、focus trap 和关闭后回焦；
- 移动端导航使用可关闭抽屉；
- 页面具有 skip link、语义标题和表单标签；
- 动态结果使用 `aria-live`；
- serious/critical axe 问题为 0；
- 浏览器 console error/warning 为 0。

### 16.3 性能

- 每端初始 JavaScript 不超过 200 KiB gzip；
- CSS 不超过 50 KiB gzip；
- 单张首屏图片不超过 200 KiB；
- Client 不加载 Operations/Maintenance 工作区；
- 登录页在 audience Server Component 层分发，不加载已认证应用树；
- 页面工作区使用 route-level lazy loading；
- 发布 Gate 要求 LCP ≤ 2.5 秒、CLS ≤ 0.1、TBT ≤ 200 毫秒。

## 17. 明确关闭或退休的功能

以下能力即使存在历史代码或表结构，也不属于当前可用产品：

- 非优盾充值、静态收款地址、二维码、未验签自动监听与无人复核入账；
- Credits 充值；
- 自动支付、自动扣款、自动退款和自动对账副作用；
- Payment Worker；
- 客户交易所账户、API Key 和 BYOK；
- 真实现货、永续、杠杆、做空、funding、提现和划转；
- 社区策略市场、作者分润和公开跟单；
- 浏览器执行生产部署、迁移、切流或回滚；
- Telegram/WhatsApp 验证；
- 演示验证码、假地址、假二维码、假 KPI、假 Worker、假连接和假成交；
- 将平台 Demo 结果或 Paper 收益描述为客户真实投资结果。

恢复任一退休功能必须单独建立 PRD、Spec、API Policy、数据迁移、安全评审、发布 Gate 和回滚方案，不能只恢复旧菜单。

## 18. 标准验收旅程

### 18.1 Client 旅程

1. 使用邀请链接设置密码；
2. 登录 Client；
3. 阅读并确认七类商业披露；
4. 系统启动 3 天 Trial；
5. 查看三张 10,000 USDT Paper 组合；
6. 查看七阶段决策轮和 Paper 回执；
7. 创建会员订单；
8. Operations 双审后看到权益激活和 Credits；
9. 执行可计量 AI 请求并看到预留、结算或释放；
10. 查看 Demo 安全摘要且理解不代表真实成交；
11. 设置通知和免打扰；
12. 查看周 Paper 绩效账单；
13. 到期后验证停止新开仓和只读/只平仓状态。

### 18.2 Operations maker 旅程

1. 登录并完成 MFA；
2. 在授权 scope 内查看客户和订单；
3. 录入会员付款凭证并提交；
4. 确认自己没有自审按钮；
5. 发起 Credits 调整；
6. 生成上一完整周分成；
7. 录入分成付款凭证；
8. 查询账本、财务和审计记录。

### 18.3 Operations checker 旅程

1. 登录并完成 recent MFA；
2. 审批其他人提交的会员订单；
3. 验证只激活一次且 Credits 只发放一次；
4. 审批 Credits 调整并验证余额非负；
5. 审批分成计算，只形成应收；
6. 在另一付款复核步骤后确认 `PAID` 和高水位更新；
7. 验证重复、并发和自审请求返回 409/403。

### 18.4 Maintenance 管理员旅程

1. 登录、完成 MFA 并检查账号会话；
2. 查看 Worker、队列、数据库和迁移状态；
3. 创建模型 Profile，保存后确认密钥不可回显；
4. 创建修订、绑定 Agent、测试并执行不可变回滚；
5. 检查 Email、Payment、数据源和 Demo 的真实状态；
6. 测试固定数据源或 Demo 账户，不泄露密钥；
7. 启用和解除 Paper 新开仓紧急暂停；
8. 提交商业披露，由不同人员批准；
9. 登记候选版本，由不同人员验证；
10. 先登记 staging 成功，再登记 production 结果；
11. 查询授权审计和技术审计。

## 19. 发布条件和环境责任

代码进入部署流程前必须通过：

- 单元、合同和 PostgreSQL 集成测试；
- TypeScript 和 ESLint；
- 三端 production build；
- API inventory 和权限目录一致性；
- 仓库密钥扫描和生产依赖审计；
- Playwright 四身份、Host/Cookie audience 隔离和 axe；
- Bundle 预算和三轮 Lighthouse；
- fresh migration、N-1、重复执行、checksum、并发和恢复验证；
- 版本登记、独立验证、staging 事实和发布/回滚证据。

目标环境仍需负责：

- 独立数据库、最小权限角色和备份；
- Cookie/加密/幂等/代理信任等生产秘密；
- DNS、TLS、反向代理和 Host 映射；
- Email 域名、Webhook、suppression、allowlist 和真实 smoke；
- Demo 测试凭证、固定域名验证和明确外部写入授权；
- 日志、指标、告警和首小时值班；
- current/previous 原子发布和五分钟内应用回滚能力。

没有上述外部事实时，系统必须保持未配置或关闭状态，而不是用本地测试结果冒充生产就绪。

## 20. 相关专项文档

- 产品合同：`PRD.md`
- 七智能体合同：`SEVEN_AGENT_TRADING_HALL.md`
- 系统边界：`../specs/SYSTEM_SPEC.md`
- Client：`../specs/CLIENT_APP_SPEC.md`
- Operations：`../specs/OPERATIONS_APP_SPEC.md`
- Maintenance：`../specs/MAINTENANCE_APP_SPEC.md`
- 版本管理：`../specs/RELEASE_VERSION_MANAGEMENT_SPEC.md`
- API：`../api/API_CATALOG.md`、`../api/openapi-controlled-beta.yaml`
- 旧后台迁移：`../architecture/CAPABILITY_MIGRATION_MATRIX.md`
- 发布验收：`../quality/ACCEPTANCE_AND_RELEASE_GATES.md`
- 质量证据：`../quality/QUALITY_RELEASE_EVIDENCE.md`
- 运营手册：`../runbooks/commercial-beta-operations.md`
- 运维手册：`../runbooks/commercial-beta-maintenance.md`
- 发布与回滚：`../runbooks/commercial-beta-release-and-rollback.md`
