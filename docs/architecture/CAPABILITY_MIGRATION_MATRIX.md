# AgentNovas Current → V3 详细能力迁移矩阵

> 文档状态：`TARGET_TRUTH/PARTIAL_CURRENT`。本文把需求方已确认的 V3 目标逐项映射到当前代码、数据库、三端页面、后台进程和测试证据；它不把 `TARGET`、`PARTIAL` 或 `BLOCKED` 能力描述成已上线。产品范围以 [`../product/PRD.md`](../product/PRD.md) 为准，执行顺序以 [`../../tasks/plan.md`](../../tasks/plan.md) 为准。

- 更新日期：2026-08-24
- 基线分支：`codex/platform-v3-doc-sync`
- 基线提交：`7279688`（另有两处用户本地改动未纳入本矩阵）

## 1. 状态与证据口径

| 状态 | 判定标准 |
| --- | --- |
| `CURRENT` | 当前代码可达，数据与权限合同明确，并有与风险相称的自动化或浏览器证据。 |
| `PARTIAL` | 有可复用资产，但缺少 V3 合同、消费者、供应商、真实环境或完整 Gate。 |
| `TARGET` | 已确认目标，当前没有足够实现；表名、route 名只在已有资产时列出，不虚构最终接口。 |
| `BLOCKED` | 受 P-01–P-12、专项 ADR、安全/合规评审、外部供应商或真实环境 Gate 阻断。 |
| `RETIRED` | V3 明确不再提供或继续保持不可达；不得通过隐藏入口恢复。 |

“存在表或 route”不等于功能完成；`DISABLED/BETA` route、未启用 Worker、Paper/Demo 回执和未通过 live Gate 的 Execution Service 只能证明基础存在。

## 2. 可复核的 Current 资产清单

| 资产维度 | Current 数量 | 口径与结论 |
| --- | ---: | --- |
| API route 实现文件 | 203 | `app/api/**/route.*.ts` 的唯一源文件数。 |
| HTTP method route | 268 | `API_ROUTE_INVENTORY` 唯一 `method + path` 条目；Client 116、Operations 114、Maintenance 86，跨 audience 条目会分别计数，因此三项之和大于 268。 |
| API mutation | 154 | 非 `GET/HEAD/OPTIONS` inventory 条目；其中 183 个全部 method route 被标为 sensitive。 |
| API 当前硬关闭 | 61 | inventory `authentication=disabled`；不能按“已有 route”计作 V3 完成。 |
| 页面路由合同 | 72 个 pattern | Client 27、Operations 24、Maintenance 21；动态 `:id` 按一个 pattern 计。Next build 输出的总 route 数包含 API，不作为页面数量。 |
| PostgreSQL 迁移 | 73 | `0000`–`0072`；完整迁移链在一次性 schema 应用后查询 catalog。 |
| PostgreSQL 对象 | 153 tables、5 views、67 routines、50 triggers、10 policies | 153 tables 包含迁移登记表 `_agentnovas_migrations`，即 152 个业务/平台表；另有 5 sequences。 |
| 长驻后台进程 | 7 | Research、Runtime、Notification、Payment、Configuration Activation、Demo Worker 和 Execution Service；Payment 默认 disabled，Execution Service 不代表 live 已解锁。 |
| 自动测试目录文件 | 272 | 270 个可执行 `*.test.mjs/*.spec.ts` 加 2 个 Playwright 支持模块；基线完整 Node 套件 1364/1364，三端真实浏览器 Gate 另行运行。 |

### 2.1 页面合同

| 应用 | Current 路由 pattern | V3 解释 |
| --- | --- | --- |
| Client（27） | `/`、认证/验证/重置、`/dashboard`、`/legal/**`、`/account/security`、`/market`、`/assistant`、`/studio`、`/backtests/**`、`/trading-hall/**`、`/paper/**`、会员/Credits/账单、钱包、通知和支持 | 公开入口、账户安全、AI/Paper/商业闭环可复用；策略广场、跟单配置、真实交易中心、提现仍缺目标页面。 |
| Operations（24） | 认证/账户、客户、运营账号、团队、数据中心、会员/账单/Credits/充值/账本/财务/审批、授权审计、kill switch、live routing、注册链接 | 组织树已退出稳定路由；客户交易风控、作者/策略审核和完整真实交易报表仍需扩展。 |
| Maintenance（22） | 认证/账户、模型、AI 用量、四类集成、健康/准备度/安全、设置/披露、配置版本、发布、授权审计和技术审计 | 配置发布内核与 T3.9a 只读 AI 用量分析已形成页面；品牌/i18n、Prompt/技能、固定价格、完整任务管理和 CI/CD trigger 尚未形成最终页面。 |

### 2.2 后台进程与执行边界

| 进程 | Current | V3 去向 | 状态 |
| --- | --- | --- | --- |
| Strategy Research Worker | 自托管研究编排、状态机和持久化 | AI 策略生成与测试队列；需迁移 QuantDinger 差异和新市场合同 | `PARTIAL/BLOCKED` |
| Strategy Runtime Worker | 确定性策略周期、风险 Gate、Paper/受控 live wiring | 跟单编排；不得直接获得客户凭证明文 | `PARTIAL` |
| Notification Worker | inbox/email、偏好、suppression、heartbeat | 三端业务/交易/安全通知 | `CURRENT/PARTIAL` |
| Payment Worker | 默认 disabled，当前不是收费路径 | 不复用为提现或自动退款；是否保留由新支付设计决定 | `RETIRED`（当前合同） |
| Configuration Activation Worker | 最小权限、到期扫描、幂等激活、heartbeat | 品牌/开关/Prompt/技能/价格统一版本生效器 | `CURRENT/PARTIAL` |
| Platform Demo Worker | 与客户 Paper 分离的测试账户、意图和回执 | provider 认证和执行演练，不得冒充客户 live | `CURRENT`（Demo） |
| Execution Service | 独立凭证边界、Binance/OKX adapter、风控、回执和对账基础 | 唯一客户凭证解密与真实订单进程；逐 provider 解锁 | `PARTIAL/BLOCKED` |

### 2.3 升级中必须保留的 Current 业务闭环

| ID | Current 能力 | 现有资产 | V3 处置 |
| --- | --- | --- | --- |
| B-01 | Client 公开着陆页与登录后工作台分离 | `/`、`/dashboard`、公开 legal、Client shell 和 wrong-audience routing tests | `CURRENT`；继续扩展品牌/SEO/i18n，不把登录用户送回营销页。 |
| B-02 | Client 消息中心、偏好与支持 | notification inbox/preferences、Notification Worker、`/notifications`、`/support` | `CURRENT/PARTIAL`；扩展交易/安全消息，Telegram/WhatsApp 验证仍不可伪造。 |
| B-03 | 优盾 deposit-only、钱包和不可变账本 | Client deposit/wallet route，Operations deposit/ledger，provider event/action/ledger tables，双审与验签测试 | `CURRENT`；与未来提现/划转严格分离，未配置或未知结果失败关闭。 |
| B-04 | 会员订单、Credits、Paper 绩效账单 | Client 会员/Credits/账单页，Operations maker-checker，entitlement/ledger/high-water-mark | `CURRENT/PARTIAL`；保留 Beta 闭环，V3 价格、退款、优惠和作者分账另行版本化。 |
| B-05 | 官方策略卡 Paper 与平台 Demo 隔离 | official paper portfolio/fill、Demo account/intent/receipt、Client 安全摘要、Maintenance 控制 | `CURRENT`（非 live）；继续作为 G3/G4 前置证据，绝不显示为客户真实成交。 |
| B-06 | Operations 客户生命周期、备注、归属与冻结 | customer/attribution/note/status route，scope/PII projector，Operations `/customers`，审批和审计 | `CURRENT`；未来交易账户/持仓只加入授权安全投影，不回显 Secret。 |
| B-07 | Operations 概览、数据中心、团队任务和月度目标 | Operations `/`、`/data-center`、`/team`，真实聚合/分页/CSV/scope tests | `CURRENT`；补 V3 交易/风险指标时保留模拟与真实口径分离。 |
| B-08 | Operations 会员、Credits、充值、财务和跨领域审批 | `/membership-orders`、`/performance-statements`、`/credits`、`/deposits`、`/finance`、`/approvals` | `CURRENT`；审批投影不拥有领域副作用，旧通用 collections/payout 继续退休。 |
| B-09 | Maintenance 模型 Profile、Agent 绑定和安全测试 | model/profile/binding route、`/models`、密钥不回显、版本/回滚/审计测试 | `CURRENT`；Prompt/Skill 独立接入配置框架，旧单一 LLM 配置不恢复。 |
| B-10 | Maintenance 邮件、支付、Demo 和只读数据源集成 | 四类 integrations 页面、固定目标测试、configured/enabled/healthy 分离 | `CURRENT/PARTIAL`；每个新 provider 使用专用安全投影，浏览器不得提交任意私有 URL。 |
| B-11 | Maintenance health/readiness/safety/audit | Worker heartbeat、DB/queue 状态、Paper 与 Demo 独立停控、技术审计与授权审计 | `CURRENT/PARTIAL`；补市场/live/CI SLO 与 runbook，不扩大 Maintenance 客户数据面。 |

## 3. Phase 1：身份、权限和注册链接

| ID | V3 能力 | Current 资产（route / DB / UI / process / test） | 目标位置 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- | --- |
| I-01 | 三端 audience、Cookie、Session 和 DB 角色隔离 | auth/access route、`applications/users/sessions/system_role_identities`；三端登录页；Host/Cookie/DB boundary tests | 保持共享认证内核、按 audience 失败关闭 | `CURRENT` | 生产部署仍需三端环境值一致性检查。 |
| I-02 | Operations 五级角色、权限和 assignment-bound scope | access/role/assignment route；`roles/role_permissions/user_role_assignments/organizations`；Access Center；RBAC/scope PostgreSQL tests | Operations 平面账号与授权中心 | `CURRENT` | 新业务 route 必须复用同一 scope/字段权限投影。 |
| I-03 | 不展示组织架构树与关系编辑 | `/organization` 已从稳定 page contract 退休；成员写 route 返回 410；后端归属事实保留 | 无目标页面；仅后端 scope/归属 | `RETIRED`（UI） | 待观测旧调用量后清理遗留组件，不删除历史归属数据。 |
| I-04 | 角色/权限链接、自助注册、注册即授权 | `/api/invitations/staff-link`、`/api/organization/staff-register`；`internal_registration_links/_uses`；Operations `/invitations`；并发/越级/泄露浏览器测试 | Operations 注册链接工作台 | `CURRENT` | 真实生产邮件不是内部链接前置；G1 只剩目标环境证据。 |
| I-05 | Client 可复用邀请、重生成撤销旧链接 | `/api/invitations/link` 与内部 token 分离；邀请/审计表和合同测试 | Operations `/invitations` 的客户邀请分区 | `CURRENT/PARTIAL` | 补完整目标生产域名链接与真实邮件/落地页证据。 |
| I-06 | Client 邮箱验证、国际手机号、5 设备、全退 | register/verify/session route；`auth_tokens/sessions/notification_*`；Client 认证与安全页；完整迁移/浏览器测试 | Client 账户安全 | `CURRENT/PARTIAL` | 第 6 台设备交互和城市级异地定义仍待产品确认。 |
| I-07 | MFA 能力保留、当前关闭、生产三端统一开启 | TOTP/recovery/recent-MFA route 与表；三端 MFA UI；开→关→开 9 旅程、开启态 3/3 | 三端账户安全和发布 Gate | `PARTIAL` | 目标环境真实邮件、批准变更、回滚与三端一致性，未通过前生产默认关闭。 |
| I-08 | Operations 客户 PII 字段权限、同源列表/详情/导出 | customer route、统一 PII projector、`0068` 权限；Operations 客户页；PostgreSQL/Chromium 正反例 | Operations 客户域 | `CURRENT` | 新增交易账户/持仓字段时必须扩展同一投影和审计。 |
| I-09 | 内部账号停用/恢复、Session 与链接撤销 | member status route、tombstone/assignment/session/token 数据；Operations `/accounts`；身份生命周期测试 | Operations 运营账号 | `CURRENT` | 不做破坏历史链的物理删除。 |
| I-10 | 高风险原因、recent MFA、幂等、双审和审计 | 中央 API policy、approval/access-change、audit hash/anchor；Operations/Maintenance 审批页；policy/security tests | 所有后续 mutation 的强制横切层 | `CURRENT`（基础） | 每个新功能逐项登记 permission/scope/PII/body/rate/audit。 |

## 4. Phase 2：多市场行情

| ID | V3 能力 | Current 资产 | 目标位置 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- | --- |
| M-01 | 统一 market/provider/symbol/calendar/capability 合同 | contract v1 严格 normalizer/event envelope/freshness；四市场/40 标的 catalog；加法式 instruments API；既有 snapshots/freshness tests | `packages/contracts` + `lib/market-catalog` + Client market API；后续 Maintenance source catalog | `CURRENT/PARTIAL` | 合同底座已完成；真实 provider 授权/fixture 仍待 P-01/P-03，WebSocket/偏好/主备属 M-02–M-04。 |
| M-02 | WebSocket sequence、≤500ms、10 秒恢复 | provider 独立 sequence/连接/重连/cache 纯状态机；Runtime 已过滤未收盘 K 线并以 cadence stale Gate 阻断新开仓、保留退出；尚无真实 WebSocket adapter | 市场数据服务、Runtime admission 与 Client 实时连接层 | `PARTIAL` | P-01/P-03、供应商 sequence/reset fixture、stream latency 综合准入、容量与故障注入；10 秒当前仅为退避上限/恢复目标。 |
| M-03 | 主备源、stale 标记和开仓阻断 | freshness/cache/risk 基础存在；source integration 只能测试固定只读目标 | 市场服务 + Runtime/Execution deterministic Gate | `PARTIAL` | 每市场主备、序列/价格/时间校验和恢复条件。 |
| M-04 | 加密行情源随账户或策略独立绑定；Coinbase fallback | provider-independent 选择/解析/不可变绑定与双 fingerprint 纯合同已完成；尚无持久化、UI、Runtime 与真实 provider registry | Client `/market`、策略部署绑定与 Runtime 决策证据 | `CURRENT/PARTIAL` | T2.4b 依赖 P-01 和账户/provider registry；Coinbase 只作加密 fallback，不能进入公共默认。 |
| M-05 | A/HK/KR/JP 指数、股票搜索、K 线、实时行情 | 无满足 V3 授权与 SLA 的完整供应商实现 | 市场服务、Client `/market`、Maintenance `/integrations/sources` | `BLOCKED` | P-03 供应商、授权、SLA；A/HK 先行，KR/JP 后续但仍属目标。 |
| M-06 | 外汇/贵金属只读行情 | 当前无冻结的场所/产品/杠杆与数据源合同 | 同 M-05，执行能力另属 Phase 6 | `BLOCKED` | P-02；先只读行情，不能由行情存在推导可交易。 |
| M-07 | G2 多市场压测和故障注入 | 有 market data 单元测试，尚无各市场真实 provider Gate | `tests` + 独立质量 runner | `TARGET` | M-01–M-06 完成后逐市场验收。 |

## 5. Phase 3：Maintenance 配置、计费、主题与语言

| ID | V3 能力 | Current 资产 | 目标位置 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 配置 draft/test/approve/schedule/activate/rollback | 5 组追加式表、Maintenance API、`/configurations`、Activation Worker、最小权限 DB gateway、PostgreSQL/Chromium tests | 通用配置控制面 | `CURRENT`（内核） | 具体 family 仍需独立 schema/tester/consumer。 |
| C-02 | 配置与控制无确认弹窗，原因内联单击执行 | Maintenance 普通配置、测试、模型回滚、商业披露、版本证据、充值启停、Demo 安全控制和紧急暂停均使用页面内影响说明与审计原因；应用内无确认 dialog | Maintenance 各工作台 | `CURRENT` | recent MFA、RBAC、maker/checker、幂等、状态机和审计仍是强制安全边界；后续页面不得恢复重复确认。 |
| C-03 | 全局策略研究功能开关 | `feature_flag/client.strategy_research` v1；严格 schema、确定性 tester、最小权限 active consumer、双 Gate | `/configurations` + strategy research route | `CURRENT` | v1 全局 bool 保持兼容；环境 Gate 始终是上限。 |
| C-04 | 用户/组织/版本/百分比/独立时窗 targeting | schema v2 单规则；服务端用户/组织/部署版本/时间；稳定 SHA-256 分桶；严格规范化、测试、current、回滚和无弹窗 UI | feature flag family v2 + strategy research consumer | `CURRENT` | 多规则优先级不属于 v2；未来扩展必须新建 schema。 |
| C-05 | 品牌、Logo、域名、协议、多语言配置 | platform settings 与 disclosure 基础；没有六主题素材和正式域名消费者 | Maintenance settings/configurations + 三端 public config | `BLOCKED` | P-10/P-11；域名还影响 Cookie/CORS/TLS/邮件链接。 |
| C-06 | Prompt/技能 CRUD、测试、双审、历史和回滚 | 7 个研究 prompt role、3 个 runtime explanation role、模型 Profile/绑定；没有 Skill 领域模型 | versioned configuration family + Maintenance models/configurations | `BLOCKED` | 发布治理已确认；`PROMPT_SKILL_V1_REQUIREMENTS_CONFIRMATION.md` 的 PS-01–PS-06 尚需冻结 Skill 执行模型、可编辑范围、安全包络、测试、新任务生效与删除语义。 |
| C-07 | 月/季/年/终身套餐、USDT 价格、权益版本 | `commercial_plan_versions` 和当前 Beta 四档基础；P-07 唯一参数源为 `packages/contracts/src/product-parameters.ts`，历史订单/权益/收费事实必须 pin 不可变版本或参数快照 | Maintenance 计费配置 + Client 会员 | `PARTIAL/BLOCKED` | P-07 参数已冻结；仍缺完整价格消费者、双审发布/回滚和目标 Gate，不能覆盖历史版本。 |
| C-08 | 固定对话 Credits、不可变流水和用量分析 | AI reservation/ledger、可信 usage、取消单次 release、完成/取消竞态与同 key 重放；P-08 唯一参数源为 `packages/contracts/src/product-parameters.ts`；T3.9a `/ai-usage` 和 Maintenance-only GET 按 UTC 请求创建 cohort 聚合已预留 inference，提供可信成功 Token、settled Credits、已记录非取消失败率、组织请求级快照/legacy 质量、稳定伪名用户、模型 revision、Agent、功能和日期；90 天/Top 50 有界 | Maintenance `/ai-usage` + Client AI；T3.9b 固定 Credits consumer/价格分档/`provider_usage` 模式切换 | `CURRENT/PARTIAL/BLOCKED` | P-08 参数已冻结，但 T3.9b 固定 Credits/模型功能分档/`provider_usage` runtime consumer 与切换、价格版本引用和独立 Gate 尚未完成；这些不属于当前 S0，也不是后续 S0 增量；当前可信用量结算不是固定价或可切换模式。 |
| C-09 | 人工退款、原渠道结果、优惠码/券 | 当前人工付款与审批基础；没有 V3 退款/优惠规则模型 | Client 订单 + Operations 复核 + Maintenance 规则 | `TARGET/BLOCKED` | P-07/P-09 及退款状态/渠道/provider 合同。 |
| C-10 | 三浅三深、英语默认、偏好优先级 | 当前主题/局部 locale 基础 | 三端 token、图表、邮件/错误页和偏好持久化 | `BLOCKED` | P-10 设计稿/品牌 token；需 320/768/1024/1440 与 axe Gate。 |

## 6. Phase 4：AI 助手、工作记录和策略市场

| ID | V3 能力 | Current 资产 | 目标位置 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- | --- |
| A-01 | AI 助手普通对话和策略生成 | 持久化 conversation/message、SSE、Credits reservation/settle/release、稳定重放、服务端取消与 provider abort；Client `/assistant` 无弹窗取消；旧元素已退役并保留 4 个快捷问题 | 统一 Client AI 助手 | `CURRENT/PARTIAL` | 普通对话取消/重试/幂等已闭环；统一入口/信息架构和固定 Credits 仍待 P-04/P-08。 |
| A-02 | QuantDinger 移植与差异验收 | 当前研究/DSL/AI 基础；未取得指定仓库和可移植版本 | AI assistant/research modules | `BLOCKED` | P-04 仓库、演示和验收样例。 |
| A-03 | 文字建议、可编辑参数、结构化策略 | DSL v1–v3、strategy candidates/versions/validations 与确定性校验 | Client AI/studio + strategy domain | `PARTIAL` | 新市场/provider 字段、版本兼容与端到端浏览器旅程。 |
| A-04 | 回测、模拟盘准入和风险门槛版本 | backtest/Paper/Research 基础和多类测试 | Client `/backtests` + admission service | `PARTIAL/BLOCKED` | P-05 时长、收益/回撤门槛；不能用开发默认值代替。 |
| A-05 | 客户投稿、平台审核、上/下架、重大版本重审 | `community_strategies/strategy_change_requests/author_earnings` 等历史基础；marketplace route 当前 disabled | Client 策略广场 + Operations 策略审核 | `PARTIAL/TARGET` | 重建 V3 状态机、权限、风险披露和 G3；旧 disabled route 不直接复活。 |
| A-06 | 跟单配置、不可变快照、Paper/Demo 先验收 | 官方卡 Paper subscription、portfolio/fills 和 pause/stop 已可达 | Client 策略详情/跟单配置 + Runtime | `PARTIAL` | 新策略版本/账户/费用/风险快照和 Paper/Demo E2E。 |
| A-07 | 订阅费、收益分成、作者/平台分账 | 当前会员、Paper performance fee、高水位与 revenue allocation 基础 | 策略商业合同 + Operations/Client | `PARTIAL/BLOCKED` | P-06；作者、平台、退款和历史版本快照。 |
| A-08 | 完整决策/行情/风控/订单工作记录，保留 ≥6 月 | decision rounds/events/runtime explanations/audit 基础，Client trading hall 可见部分状态 | Client 工作记录详情 + Maintenance 受控导出 | `PARTIAL` | 统一 trace、保留策略、脱敏导出与浏览器验收。 |

## 7. Phase 5–8：真实交易、衍生品、资金出站和发布

| ID | V3 能力 | Current 资产 | 目标位置 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- | --- |
| L-01 | Execution Service 独立凭证和唯一订单边界 | `scripts/execution-service.mjs`、独立协议/credential access/handler、key-custody quality Gate | 独立 Linux service 与专用 DB/network role | `PARTIAL/BLOCKED` | 生产密钥域、轮换、网络、审计和 provider 认证。 |
| L-02 | 客户交易账户、只读+交易权限、IP 白名单 | `exchange_accounts` 与 verification/credential 基础；Client route 当前 disabled | Client 交易中心 + Execution Service | `PARTIAL/BLOCKED` | P-01、每 provider 权限/API/IP 验证；浏览器永不取回 Secret。 |
| L-03 | 五家首期 provider | Binance/OKX adapter 与测试基础；Coinbase/Crypto.com/Kraken 未达到执行合同 | Execution provider ports/adapters | `BLOCKED` | P-01 优先顺序、沙箱/生产认证；每家独立 G4A。 |
| L-04 | balance/position/live book 持续对账 | live book/reconciliation tables、worker/repository 与测试基础 | Execution Service reconciliation | `PARTIAL` | 真实 provider unknown/partial fill/fee/precision/timeout 故障注入。 |
| L-05 | pre-trade risk、account/provider/strategy/global kill switch | kill switch、live routing、emergency close 和 Operations/Maintenance UI 基础 | 确定性 risk kernel + 双控制面 | `PARTIAL` | live 账户/策略 scope、恢复审批和生产演练。 |
| L-06 | 真实现货与自动跟单扇出 | named gate 和意图/回执基础；当前真实订单硬关闭 | Runtime → Execution Service；Client/Operations 只看安全投影 | `BLOCKED` | G4/G4A、单 provider canary、首小时监控；不设置一次性全局解锁。 |
| L-07 | USDT 永续 | 历史 backtest/表存在，但项目规则仍硬关闭真实永续 | 独立 derivatives domain/service | `BLOCKED` | 需专项 ADR、position mode/margin/funding/mark/reduce-only/liquidation Gate 和明确授权。 |
| L-08 | 外汇/贵金属执行 | 无冻结场所、产品、杠杆和监管范围 | 独立 provider capability，不复用加密结论 | `BLOCKED` | P-02 与专项 ADR/Gate。 |
| F-01 | 提现、划转、服务费 | withdrawal authority rejection、deposit-only 和不可变账本基础；无可达出站路径 | 独立资金服务、密钥域、账本和双审 | `BLOCKED` | P-09、托管/AML/制裁/网络/白名单/限额/退款/事故规则及 G5。 |
| R-01 | 不可变发布身份、验证、部署/回滚证据 | release tables/API、Maintenance `/releases`；只登记事实 | 保持 current 控制面 | `CURRENT` | 不得宣称已能触发部署。 |
| R-02 | Maintenance 受限 CI/CD workflow trigger | 当前明确不执行 Shell/SSH/DB script | 固定 workflow API、短期凭证、回调和审计 | `BLOCKED` | 新 ADR/威胁模型、人员分离、artifact/migration/rollback 校验和 G7。 |

## 8. Phase 9：后续体验、运维和正式发布收口

> **当前范围边界（2026-08-25）：** 本节是完整 V3 的后续迁移矩阵，不是当前发布范围。当前只推进 S0 受控 Paper/Demo 商业平台；Spot Live、USDT Perpetual、Withdrawal/Transfer 和 Maintenance CI/CD trigger 均保持关闭并分别进入后续独立切片。

| ID | V3 能力 | Current 资产 | 状态 | 剩余条件 |
| --- | --- | --- | --- | --- |
| X-01 | 三端 320/768/1024/1440、键盘、axe、资源预算 | 当前主要页面 Playwright quality helper 和三端 suite | `CURRENT/PARTIAL` | 所有新增 V3 页面逐页纳入，不以代表页替代关键旅程。 |
| X-02 | API/登录/Worker/交易/模型/支付/DB 任务可观测 | health/readiness/audit/heartbeat 基础 | `PARTIAL` | live/provider/market/SLO 指标、告警、runbook 和首小时监控。 |
| X-03 | 任务管理与分阶段推进 | `tasks/plan.md`、`tasks/todo.md`、Gate/roadmap | `CURRENT`（工程任务真源） | 产品参数继续由 P-01–P-12 冻结；每个切片本地提交和证据同步。 |
| X-04 | 三端真实浏览器登录与 MFA 发布专项 | 本地关闭态、开启态和 rollout runner 已完成 | `PARTIAL` | 生产候选必须在目标环境重跑真实邮件、三端登录和 MFA Gate。 |
| X-05 | 正式域名、Nginx/TLS、备份恢复、灰度与回滚 | 自托管容器、Nginx、迁移/恢复脚本和历史发布证据 | `PARTIAL/BLOCKED` | P-11/P-12、完整 G8 和每个高风险能力的独立 Gate。 |

## 9. 共享热点与强制迁移顺序

| 热点 | 影响 | 约束 |
| --- | --- | --- |
| `app/api` + `lib/api-route-inventory.ts` | 所有新/改 API | route、audience、auth/MFA、permission、scope、PII、Origin、幂等、body/rate/audit 同批提交；generator `--check` 必须通过。 |
| `app/riverton-route-contract.ts` + 三端 dispatcher/navigation | 所有新页面 | page contract、导航、wrong-audience 404、响应式/axe/浏览器覆盖同批更新。 |
| PostgreSQL migrations + production role policy | 所有持久化能力 | 只新增前向迁移；fresh/rerun/concurrent/N-1/最小权限/回滚证据，禁止改写已发布迁移。 |
| versioned configuration framework | 开关、品牌、Prompt/技能、价格 | 每个 family 必须有严格 schema、可信 tester、最小权限 consumer 和历史 pin；active 不等于业务已生效。 |
| market data → deterministic risk → Runtime → Execution Service | 行情、策略、跟单、订单 | stale/invalid 数据在进入执行前阻断；LLM 不获得校验、风控或订单权。 |
| ledger/audit/idempotency | 计费、资金、交易、审批、发布 | 追加事实、未知结果不成功、自审阻断、跨域 correlation；不可覆盖历史。 |

推荐迁移顺序保持：身份/G1 收口 → 多市场只读行情/G2 → 配置与体验基础 → AI/策略 Paper/Demo/G3 → 单 provider 现货/G4A → 逐 provider 扩展 → 永续/G4B → 资金出站/G5 → CI/CD/G7 → 全平台 G8。任何后阶段代码存在都不能绕过前置 Gate。

## 10. 明确退休或待删除资产

| 资产 | Current 处置 | 删除/收口条件 |
| --- | --- | --- |
| Operations 组织树、关系图和关系编辑入口 | 页面与写 route 已退休，后端 scope/归属保留 | 旧调用量为零、平面账号目录覆盖、浏览器与 scope 回归通过；只删 UI/越权写入口，不删历史事实。 |
| 一次性内部成员邀请/临时密码主流程 | 仅作历史兼容，V3 主流程为权限注册链接 | 所有待激活历史账号完成迁移或过期，审计与 rollback 方案批准。 |
| 客户 BYOK/私有 LLM endpoint | 硬关闭 | 保持 `RETIRED`，除非新 PRD/ADR/威胁模型明确重启。 |
| legacy 策略部署、客户永续账户和模拟订单 route | `DISABLED/BETA` | 新策略/跟单/Execution 合同完成后观测并删除；不得直接取消 disabled。 |
| 旧通用 finance collections/settlements/payout | 硬关闭或由领域化会员/账单流程取代 | 新计费/分账/资金合同完成并迁移历史读路径。 |
| Payment Worker 自动入账 | 默认 disabled，不是当前收费路径 | 新支付/退款设计决定复用或删除；不得用于提现。 |
| HTTP automation runtime | 410/disabled，使用独立 Worker | 外部调用归零并完成 Worker 运行证据后删除。 |

## 11. 可审查的下一切片与规模

规模按独立可提交、可回滚纵向切片估算，不按整阶段给虚假工期：`S` 为合同/单消费者，`M` 为 route+DB+UI+测试，`L` 为跨服务/provider/Gate；`L` 必须继续拆分。

| 顺序 | 切片 | 规模 | 当前依赖 |
| ---: | --- | --- | --- |
| 1 | G1 目标环境真实邮件、三端 MFA rollout 与回滚证据 | M | 生产变更窗口/真实邮件授权 |
| 2 | Prompt/Skill 可编辑边界确认与 family v1 | M | 需求方对 C-06 五项确认 |
| 3 | market/provider/symbol/calendar schema 与只读 API | M | P-01/P-03 可分市场冻结 |
| 4 | 单一市场 WebSocket + stale Gate | L，拆 provider 接入/前端/风险三片 | M-01 和 provider sandbox |
| 5 | QuantDinger 差异清单与 AI 入口收敛 | M | P-04 |
| 6 | 策略投稿→审核→Paper 上架纵向切片 | L，拆状态机/审核/Client 三片 | P-05/P-06 |
| 7 | 首个 provider 账户 readiness + reconcile | L，按 provider 拆 | P-01、密钥与网络环境 |
| 8 | 单 provider 现货最小 canary | L，继续拆订单/恢复/监控 | G4/G4A |

## 12. 矩阵验证命令

```bash
npm run icons:generate
node scripts/generate-api-route-inventory.mjs --check
node --experimental-strip-types --test tests/riverton-page-routing.test.mjs tests/e2e/stable-route-coverage.unit.test.mjs
node --experimental-strip-types --test tests/postgres-migration-chain.test.mjs tests/architecture-boundaries.test.mjs
git diff --check
```

数据库对象数来自把 73 个真实迁移应用到一次性 PostgreSQL schema 后查询 `pg_class`、`pg_proc`、`pg_trigger` 和 `pg_policies`；查询结束已删除 schema。API 数量来自生成后的 inventory，而不是手工统计本文件。
