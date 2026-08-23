# Implementation Plan：AgentNovas 全平台 V3 升级

状态：Phase 1 进行中；T1.1–T1.6 已实现，G1 真实邮件与生产 MFA 开启态验收待完成
工作分支：`codex/platform-v3-doc-sync`
需求真源：`docs/product/PRD.md`
路线图：`docs/roadmap/FULL_PLATFORM_V3_ROADMAP.md`
质量门禁：`docs/quality/FULL_PLATFORM_V3_GATES.md`

## 1. 目标

在不破坏当前受控 Beta/Paper 可运行基线的前提下，把系统分阶段升级为完整三端交易平台。每个阶段提供可运行的纵向切片、独立 Gate 和回滚点；真实现货、永续、提现/划转和 CI/CD 触发分别解锁。

用户已授权按本计划实施并在当前分支本地提交。外部产品参数未冻结的阶段仍保持阻断，
不得用假设替代 P-01–P-12 的需求方结论。

## 2. 已冻结架构决定

- 自托管 Linux、Node.js 22.21+、PostgreSQL、Nginx、Certbot；不增加 Cloudflare Runtime 或 Redis。
- Client、Operations、Maintenance 的 audience、Cookie、Host、RBAC、DB role 和 secret 独立。
- Operations 不展示组织架构，后端保留 scope/归属事实。
- 内部人员使用角色/权限链接自助注册；token 只存摘要、不能越级、全生命周期审计。
- MFA 能力与凭证完整保留，当前默认不强制；正式生产按 ADR-0023 三端统一开启并通过专项 Gate。
- LLM 不拥有确定性校验、风控或订单执行权。
- Execution Service 是唯一长期持有客户交易凭证解密能力的进程。
- Paper、Demo、Live 使用不同 book 和证据，不混写。
- Maintenance 未来只触发固定 CI/CD workflow，不执行任意服务器命令。
- 历史 ADR/发布记录不可改写；改变决定使用新 ADR。

## 3. 项目级完成定义

每个任务完成必须同时满足：

1. PRD/Spec/API/状态机和数据模型一致。
2. 中央 API Policy、RBAC、scope、PII、MFA、幂等、限流和审计完整。
3. 成功、拒绝、重复、并发、超时、provider 失败和恢复有自动测试。
4. 三端 build、type、lint、相关 PostgreSQL/浏览器 Gate 通过。
5. 迁移支持 fresh、rerun、N-1、backup/restore 和回滚。
6. UI 没有假数据、假成功、不可达按钮或错误状态语义。
7. Runbook、监控、告警、任务状态和证据链接同步。

## 4. Phase 0：产品冻结与工程基线

### T0.1：同步 V3 文档体系

**描述：** 建立 PRD、ADR、V3 功能说明、系统/三端 Spec、Gate、路线图、准备度评估和文档状态矩阵。

**验收：**

- [x] Target、Current、Foundation、Historical 分类明确。
- [x] 当前硬关闭与最终目标不再互相覆盖。
- [x] `tasks/plan.md` 与 `tasks/todo.md` 成为任务真源。

**验证：** `git diff --check`、Markdown 链接检查、目标关键词一致性检查。
**依赖：** 无。
**涉及：** `docs/**`、`tasks/*.md`。
**规模：** M（文档专项）。

### T0.2：冻结 P-01–P-12 产品参数

**描述：** 由产品、业务、财务、安全和合规补齐交易所优先级、供应商、策略门槛、价格、费率、提现规则、主题和日期。

**验收：**

- [ ] 每项参数有唯一结论、责任人和生效版本。
- [ ] 未决项明确延期阶段，不以“后续再说”进入实现。
- [ ] 收费、退款、风险和服务地区形成版本化合同输入。

**验证：** PRD 第 15 节零空白；G0 评审签署。
**依赖：** T0.1。
**涉及：** `docs/product/PRD.md`、商业披露/价格文档。
**规模：** S（决策为主）。

### T0.3：生成 Current → V3 代码能力矩阵

**状态：** 已完成。矩阵已同步到 `7279688`：203 个 route 文件、268 个 method route、72 个页面 pattern、73 个迁移的最终 PostgreSQL catalog、7 个后台进程和测试目录 270 个文件（268 个可执行 test/spec、2 个支持模块）；P-01–P-12 未决项继续明确标为 `BLOCKED`，不影响盘点完成，也不解除下游 Gate。

**描述：** 对 route、DB、页面、Worker、Execution Service 和测试逐项标记 `CURRENT/PARTIAL/TARGET/BLOCKED/RETIRED`。

**验收：**

- [x] 每个 V3 功能映射到现有资产或明确新建位置。
- [x] 共享热点、迁移顺序和删除项可审查。
- [x] 估算基于任务切片而不是整阶段猜测。

**验证：** route inventory、schema inventory、页面清单与矩阵数量一致。
**依赖：** T0.2。
**涉及：** `docs/architecture/CAPABILITY_MIGRATION_MATRIX.md`、`docs/api/API_CATALOG.md`。
**规模：** M。

### Checkpoint P0

- [ ] G0 通过。
- [ ] 用户确认 Phase 1 范围、资源和顺序。
- [ ] 当前 Beta 全量 Gate 保持绿。

## 5. Phase 1：身份、权限和注册链接

### T1.1：退休 Operations 组织架构 UI

**状态：** 已完成（导航/深链退休；平面运营账号目录替代；后端 scope 事实保留）。

**描述：** 从导航、页面和写 API 移除组织树/关系编辑；保留后端 scope、分公司和客户归属事实。

**验收：** Operations 无组织树入口；现有 scope 查询不扩大；旧深链返回明确 retired/404。
**验证：** route/menu contract、五种 scope PostgreSQL 测试、四身份浏览器回归。
**依赖：** P0。
**可能涉及：** Operations UI、route dispatcher、API Policy、scope tests。
**规模：** M。

### T1.2：角色权限注册链接合同与迁移

**状态：** 已完成（迁移 0065、不可变专用角色、摘要 token、使用事实与生产 DB ACL）。

**描述：** 新增 role link、hash、状态、使用事实、撤销和重生成数据模型。

**验收：** token 高熵且只存摘要；角色/权限/范围不可静默修改；重生成原子撤销旧链接。
**验证：** migration fresh/rerun/concurrent、约束故意违例、secret scan。
**依赖：** T1.1。
**可能涉及：** PostgreSQL migration、contracts、domain/service tests。
**规模：** M。

### T1.3：五级链接管理与自助注册

**状态：** 已完成（生成/复制/撤销/重生成/注册/限流/MFA 引导/泄露响应）。

**描述：** 完成生成、复制、作废、注册、即时 assignment、MFA 引导和泄露响应。

**验收：** 不可越级；注册事务无半成品；无需人工审批；所有事件审计。
**验证：** 每级角色正/反例、并发注册、旧链接拒绝、浏览器旅程。
**依赖：** T1.2。
**可能涉及：** Operations API/UI、auth gateway、RBAC service、audit。
**规模：** M。

### T1.4：Client 注册与 5 设备会话

**状态：** 已完成核心实现与自动化验证；城市级定位和第 6 台交互策略见 ADR-0022 待确认，G1 真实环境证据归 T1.12。

**描述：** 手机号/邮箱必填、邮箱验证、国际手机号、5 设备上限、设备通知和全量退出。

**验收：** 第 6 个设备按合同处理；登录提醒真实；Session 撤销跨设备生效。
**验证：** auth contract、并发 Session、邮件关闭降级、浏览器多上下文。
**依赖：** P0。
**可能涉及：** auth routes、session service、Client UI、notification outbox。
**规模：** M。

### T1.5：MFA 分阶段强制开关

**状态：** 已完成实现；本地关闭态 18/18、扩展开启态 3/3 和同一数据库开→关→开 9 旅程均通过，正式生产目标环境 Gate 仍待。

**描述：** 保留 TOTP/recovery 全部能力与数据，通过 fail-closed 服务端开关推迟到正式生产强制。

**验收：** 关闭态不产生 MFA 半会话或死路径；开启态恢复内部首次绑定、已绑定验证和 recent MFA；三端状态一致且可回滚。
**验证：** 关闭/开启纯函数、完整迁移链 PostgreSQL 密码重置、18 场景浏览器关闭态；扩展开启态真实 Chromium 覆盖三端绑定与验证、Client/Operations 密码重置、旧会话撤销、Operations/Maintenance recent MFA 过期；同库专项覆盖三端开→关→开、关闭期直登、重开后旧 Session 拒绝和凭据保留。生产前仅剩目标环境三端一致性与变更回滚证据。
**依赖：** T1.3/T1.4。
**涉及：** auth/access-control、MFA API/UI、env、ADR-0023、发布 Gate。
**规模：** S。

### T1.6：Operations PII 字段权限与导出一致性

**状态：** 已完成；四类字段权限、同源列表/详情/CSV 投影、范围交集和敏感访问审计均已落地。

**描述：** 建立客户 PII 字段级读取权限、列表/详情/导出同源投影和脱敏合同，避免页面与 CSV 导出出现权限漂移。

**验收：** 无字段权限时列表、详情和导出采用相同脱敏；有权限只放开合同字段；CSV 继续防公式注入；审计不保存无关明文 PII。
**验证：** maker/checker/权限范围交集正反例、262 条 API inventory、完整迁移 PostgreSQL fixture、CSV 公式注入合同，以及本地生产 standalone 真实 Chromium 角色回归 2/2；三端登录另行复验 1/1。
**依赖：** T1.1、T1.3。
**涉及：** Operations customer APIs/UI、export projection、API Policy、PII tests。
**规模：** M。

### Checkpoint P1

- [ ] G1 通过。
- [x] 组织 UI 退休且 scope/PII 无回归。
- [ ] Beta 会员、Paper、Operations 审批回归全绿。
- [ ] 正式生产 MFA 开启态专项与三端一致性通过。
- [x] Operations PII 字段权限与列表/详情/导出一致性通过。

## 6. Phase 2：多市场行情

### T2.1：市场/provider/symbol/calendar 合同

**描述：** 定义市场、供应商能力、symbol 映射、时区、交易日历、K 线和授权元数据。

**状态：** `PARTIAL_CURRENT`。T2.1a/T2.1b 已完成 provider 独立合同、API 兼容和
新鲜度安全边界；T2.1c 真实 provider 注册仍等待 P-01/P-03，因此 T2.1 总任务保持进行中。

**子任务：**

- T2.1a：公共值类型、严格 normalizer、事件 envelope 和服务端新鲜度/开仓资格派生。
- T2.1b：当前静态目录的市场/标的映射，以及 `/api/market/instruments` 加法式升级。
- T2.1c：真实 provider 授权、能力、symbol/calendar fixture 和优先级注册；等待外部结论。

**验收：** 每市场能力可查询；未知/无授权失败关闭；合同无 provider 特例泄漏到 UI；
旧 `instruments/updatedAt/source` 字段保持兼容；陈旧、非法和超延迟数据不能获得新开仓资格。
**验证：** contract/schema tests、当前 provider fixture、日期/时区/sequence/latency/stale 边界。
**依赖：** T2.1a/T2.1b 只依赖已确认 PRD；T2.1c 依赖 P-01/P-03。
**规模：** M。

**实施证据（2026-08-24）：** 9 项纯合同、7 项目录/API 和 6 项既有行情定向回归通过；
`npm test` 1348/1348、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、secret scan
与 production dependency audit 全通过。`ssh an-saas` 的 Node 22.21.1 精确提交快照完成
Client 68、Operations 62、Maintenance 51 页 production build，并以真实 nginx 1.29.8
完成配置语法检查。API 为纯加法且现有 UI 不消费新字段，本切片按规格不触发视觉专项；三端
空浏览器登录仍以本轮此前同分支 18/18 production Chromium 证据为阶段 Gate，后续 UI 消费
新合同时必须在当前产物重跑。

### T2.2：实时流、stale 与主备切换

**描述：** 实现 WebSocket 聚合、sequence、延迟、断线重连、缓存和切换校验。

**状态：** 部分完成。T2.2a 无 I/O 的 sequence/连接/重连/缓存状态机已实现；真实 adapter、
provider sequence reset 规则、容量和主备切换等待 P-01/P-03 与供应商 fixture。

**子任务：**

- T2.2a：同一 stream scope 的十进制大整数 sequence 严格递增；重复/乱序失败关闭；
  连接状态按新鲜度派生；重连退避上限 10 秒；stale 缓存仅展示。
- T2.2b：每个真实 provider 的 WebSocket adapter、订阅/心跳/sequence scope/reset/replay、
  容量压测和故障注入。
- T2.11a：当前 Runtime 先过滤未收盘 K 线，并由服务端按 timeframe cadence + 30 秒收盘容差
  派生 fresh/stale/invalid；stale/invalid 只阻断新开仓，不吞掉退出意图。
- T2.11b：真实 stream adapter 接入后把 event latency、sequence 和连接状态与 cadence Gate
  合并；在此之前 2.11a 只是必要条件，不冒充 G2。

**验收：** ≤500ms/≤10s 目标可测；陈旧行情阻断新开仓；缓存只展示。
**验证：** 压测、乱序/断线/偏差故障注入、Runtime admission test。
**依赖：** T2.1。
**规模：** M（按 provider 拆分）。

**T2.2a 实施证据（2026-08-24）：** 新增 9 项状态机测试并完成全量 1357/1357、TypeScript、
全仓 ESLint、8 条架构边界、secret scan 和 production dependency audit。实现为纯合同函数，
不读取系统时钟、不建立网络连接、不改变 UI 或数据库；因此本切片不单独触发浏览器和云端构建，
沿用 T2.1 精确提交云端构建作为前一可部署基线，待实际 adapter/UI 消费时重跑三端完整 Gate。

**T2.11a 完成标准：** 官方现货与遗留隔离运行路径不得把 provider 返回的当前未收盘 K 线
当成决策依据；未知周期、非法时间、未来收盘或达到 `timeframe + 30s` 的陈旧已收盘 K 线均
失败关闭新开仓。退出、减仓和平仓不因行情准入标志被静默吞掉。共享决策轮和逐组合准入使用
同一服务端派生状态，七阶段行情证据如实记录 quality/age/threshold，不接受浏览器自报 fresh。

### T2.3：加密行情源选择

**描述：** 支持账户一致源、独立选择、策略级源和 Coinbase fallback。

**验收：** 偏好优先级确定；不可用源准确降级；策略读取绑定版本。
**验证：** API/UI contract、切换 E2E、stale Gate。
**依赖：** T2.2。
**规模：** M。

### T2.4：A/HK 与 KR/JP 股票行情

**描述：** 先 A/HK，再 KR/JP，逐市场完成指数、热门股、全市场搜索、K 线和实时行情。

**验收：** 授权与 SLA 记录；交易日历/时区正确；UI 市场切换完整。
**验证：** provider sandbox、节假日/停牌/复权测试、浏览器。
**依赖：** T2.1/T2.2。
**规模：** M/市场。

### T2.5：外汇和贵金属行情基础

**描述：** 在 P-02 冻结后接入报价、交易时段和合约元数据，暂不自动下单。

**验收：** 报价/点差/时区准确；无交易场所时只读；不复用加密 symbol 假设。
**验证：** provider fixture、周末/隔夜边界、UI。
**依赖：** P-02、T2.1。
**规模：** M。

### Checkpoint P2

- [ ] G2 按市场通过。
- [ ] 旧加密/Paper 行情回归全绿。

## 7. Phase 3：配置、计费、主题和语言

### T3.0：Maintenance 普通配置交互减负

**状态：** 已完成。普通可逆配置和只读连通测试使用页面内审计原因并单击执行，不再逐项弹出确认框；生产发布、模型回滚、充值启停、紧急控制和密钥/会话安全操作继续保留独立确认。

**验收：** 平台设置、模型 Profile/绑定/测试、邮件测试、数据源测试、支付映射/测试和 Demo 连接验证没有二次弹窗；每次请求仍携带服务端校验的审计原因；高风险动作边界不变。
**验证：** UI 合同、TypeScript、ESLint、Maintenance production build，以及隔离 PostgreSQL + 真实 Chromium 保存/逐页无弹窗回归。
**依赖：** Phase 1 身份与 Maintenance RBAC 基线。
**规模：** M。

### T3.1：版本化配置发布框架

**描述：** 统一品牌、域名、协议、功能开关、Prompt、技能和价格的 draft/test/approve/schedule/activate/rollback。

**验收：** 历史不可覆盖；创建者不可自审；回滚引用已验证版本。
**验证：** 状态机、并发、时区、幂等、浏览器。
**依赖：** P0。
**规模：** M（框架）。

#### T3.1a：通用配置发布内核与 API

**状态：** 已完成（2026-08-24）。迁移 0069、纯 domain、事务服务、五个 Maintenance 路径/六个 method、中央 Policy、最小 DB 权限和文档合同均已落地；不包含 UI、自动激活器或具体配置消费者。

**描述：** 建立不含秘密的通用 JSON 配置版本、测试、独立审批、定时、激活和回滚追加事实；提供 Maintenance-only 受控 API，不接入具体业务配置族。

**验收：** 单流版本号并发安全；历史与事实不可修改；创建者不能审批；未测试/未批准/未到期版本不能激活；回滚目标必须同流、已测试、已批准且曾生效；幂等键绑定 actor 与完整命令。
**验证：** domain + PostgreSQL + API policy 合同、fresh/rerun、TypeScript、ESLint、Maintenance production build、secret scan、production dependency audit。
**依赖：** T3.0；不依赖 P-07/P-08/P-10/P-11 的具体数值或素材。
**规模：** M。

#### T3.1b：配置发布工作台与到期激活器

**描述：** 增加 Maintenance 草稿差异、测试证据、双审、时区预览、调度、当前版本和回滚 UI；增加最小权限到期激活 Worker 与告警。

**分阶段：** T3.1b-UI 先交付 `/configurations` 工作台与真实浏览器验收；T3.1b-Worker 再独立交付到期扫描、租约、最小数据库权限和告警。UI 阶段不得把人工登记证据描述成自动测试，也不得声称通用 active 投影已经接管具体运行时消费者。

**状态：** 已完成（2026-08-24）。工作台已提供草稿、顶层差异、测试证据、独立审批、明确 offset/UTC 预览、调度、current、激活与历史回滚控制；全流程使用页面内审计原因直接执行且无确认弹窗。独立 Worker 使用全局租约、数据库当前时间复核、最小 `SECURITY DEFINER` 激活网关、专用 DB role、逐候选失败隔离、心跳和 60/300 秒告警。

**验收：** UI 不回显秘密；移除模态确认不放宽权限、maker/checker、状态机、幂等或审计；Worker 只能激活最新测试通过、已审批且到期的从未生效版本，重放不重复，失败不错误改变 current。
**验证：** Worker 并发/崩溃恢复、角色与函数权限、四断点、axe、真实 Chromium、时区边界和失败注入。
**依赖：** T3.1a。
**规模：** M。

#### T3.1c：具体配置族接入

**描述：** 依次接入品牌/域名/协议、功能开关、Prompt/技能和价格；每族定义独立 schema、测试器、消费者与回滚证据。

**分阶段：**

1. `T3.1c-FF1`：`client.strategy_research` 全局功能开关 v1，严格 `{enabled:boolean}` schema、服务端确定性测试器、Client 最小权限 current 网关和“只能收窄环境 Gate”的消费者。
2. `T3.1c-FF2`：用户/组织/应用版本/百分比/独立时窗 targeting，作为 T3.3 的新 schema 版本单独设计和验收，不改变 FF1 语义。
3. `T3.1c-Brand/Domain`、`Prompt/Skill`、`Pricing`：分别在 P-10/P-11、Prompt/技能 schema、P-07/P-08 参数确认后接入，禁止占位值生效。

**当前状态：** T3.1c-FF1 与 FF2 已完成（2026-08-24）；品牌/域名、Prompt/Skill 与 Pricing 配置族仍为 Target/Blocked。注册族固定为 `client.strategy_research` 与 Client audience；schema v1 保留严格 `{enabled:boolean}` 全局语义，schema v2 提供单条显式 targeting 规则。服务端生成确定性测试证据，Client 只通过最小权限 current 网关读取，并在 GET/POST 共用“环境 Gate AND active 配置”的判定。没有 active 版本时保持现有环境开关行为；active 配置只能进一步收窄，不能打开被环境或能力 Gate 禁用的功能。Maintenance 使用受限字段与页面内原因直接操作，无二次弹窗。

**FF1 验证：** family/服务/PostgreSQL/角色/回滚与 UI 合同、1326 项全量测试、TypeScript、ESLint、架构边界、secret scan、production audit；`ssh an-saas` Node 22.21.1 三端 production build；本地隔离 PostgreSQL + 真实 Chromium 18/18，覆盖三端空浏览器登录和仅提交 `{reason}` 的服务端确定性测试。

**FF2 验证：** 严格 schema/evaluator、服务器拥有的用户/组织/部署版本/时间上下文、稳定 SHA-256 百分比分桶、PostgreSQL v2 current 与 v1 回滚、UI 请求体、TypeScript、ESLint、1333 项全量测试、架构/secret/dependency Gate；`ssh an-saas` 完整提交快照三端 production build；下载同一构建产物后的本地真实 Chromium 18/18，覆盖三端空浏览器登录、v2 草稿、服务端测试和全程无 dialog。

**验收：** 消费者只读取 active 精确版本；历史订单/执行引用版本 ID；具体族不能借通用 JSON 绕过安全 Gate。
**验证：** 每配置族合同、确定性测试证据、消费者 N-1、最小数据库权限、浏览器与回滚演练。
**依赖：** T3.1b；具体族分别受 P-07/P-08/P-10/P-11 阻断。
**规模：** 每族 S/M。

### T3.2：套餐、Credits、退款和优惠

**描述：** 月/季/年/终身 USDT 套餐、固定对话 Credits、人工退款和优惠规则。

**验收：** 历史订单快照不变；退款状态不冒充链上完成；优惠叠加可重放。
**验证：** 财务定点数、并发订单、退款/优惠状态机。
**依赖：** T3.1、P-07/P-08。
**规模：** M。

### T3.3：多粒度与定时功能开关

**状态：** 已完成（2026-08-24）。`client.strategy_research` schema v2 支持内部用户 ID、组织 ID、精确应用 SemVer、稳定灰度百分比与独立启停时窗；v1 全局开关继续兼容。

**验收：** 用户/组织在主体维度内 OR，主体、版本、百分比和时窗跨维度 AND；开始时间包含、结束时间不包含；环境 Gate 永远是上限。浏览器不能提供身份、组织、部署版本或当前时间，非法投影、摘要不一致和网关异常全部失败关闭。
**验证：** family/evaluator/route 合同、PostgreSQL current/rollback/角色、Maintenance UI/请求体、全量门禁、云端三端 production build、本地真实 Chromium 18/18。
**依赖：** T3.1c-FF1。
**规模：** M。

### T3.10–T3.11：六主题与 i18n 基础

**描述：** 建立三浅三深 token、图表/Logo/状态色和英语默认语言优先级。

**验收：** 六主题完整；偏好 > 浏览器/地区 > 英语；无闪烁和不可读状态。
**验证：** visual regression、contrast、四断点、SSR/hydration。
**依赖：** P-10。
**规模：** M。

### Checkpoint P3

- [ ] 配置/价格历史与审批 Gate 通过。
- [ ] 六主题和英语主旅程通过无障碍/性能基线。

## 8. Phase 4：AI 助手与策略市场

### T4.1：QuantDinger 差异与 AI 助手重构

**描述：** 冻结参考版本，移除指定旧元素，保留对话、快捷问题和持久历史。

**验收：** 差异清单逐项验收；固定 Credits 正确；错误/取消/重试无重复扣费。
**验证：** contract、usage/ledger、浏览器。
**依赖：** P-04、T3.2。
**规模：** M。

### T4.2：策略准入与投稿状态机

**描述：** 结构化策略、回测、模拟盘、风险指标、人工审核、披露和版本重审。

**验收：** 未达门槛不能上架；重大更新新建版本；审核禁止自审。
**验证：** domain/state tests、PostgreSQL concurrency、四角色浏览器。
**依赖：** P-05、T4.1。
**规模：** M。

### T4.3：策略广场与作者/费用合同

**描述：** 浏览、详情、作者、投稿、订阅、收益分成和平台/作者分账。

**验收：** 策略/费用/风险版本快照；下架不改历史订阅；退款/争议有状态。
**验证：** ledger/contract/state、Client/Ops 浏览器。
**依赖：** P-06、T4.2、T3.2。
**规模：** M。

### T4.4：Paper/Demo 跟单闭环

**描述：** 先在 Paper/Demo 完成账户、金额、仓位、止盈止损、杠杆、最大亏损、暂停和停止。

**验收：** 参数快照不可变；LLM 不直接执行；异常策略可四方停止。
**验证：** 七阶段、Paper/Demo、风控和浏览器 E2E。
**依赖：** T4.3。
**规模：** M。

### Checkpoint P4

- [ ] G3 通过。
- [ ] 策略市场只运行 Paper/Demo，不产生真实订单。

## 9. Phase 5：真实现货与自动跟单

### T5.1：交易所余额/持仓持续对账

**描述：** 建立交易所事实与 live book 差异检测、阻断和恢复。

**验收：** 客户手动交易/转移后能发现分叉；未知状态阻断新开仓但保留安全退出。
**验证：** 故障注入、账本顺序、人工升级。
**依赖：** P4、ADR-0019/0020。
**规模：** M。

### T5.2：Client live activation 与 blocker

**描述：** 客户确认账户、产品、策略、资金比例、风险和披露版本。

**验收：** 缺任何条件不可激活；状态可撤销；UI 显示明确 blocker。
**验证：** state/API/security/browser。
**依赖：** T5.1。
**规模：** M。

### T5.3：单 provider 真实现货认证

**描述：** 按 P-01 顺序逐家完成最小额、撤单、部分成交、超时查单、手续费、精度、限流和恢复。

**验收：** 仅该 `(provider, production, spot)` 可授权；证据绑定制品与账户。
**验证：** 真实小额 staging/canary、对账、kill switch、事故演练。
**依赖：** T5.2。
**规模：** M/provider。

### T5.4：真实自动跟单灰度

**描述：** 将 Paper 验证过的策略订阅扇出到已激活客户账户。

**验收：** 单账户失败隔离；幂等、部分成交、费用和分账正确；一键停止。
**验证：** canary、并发/限流、reconcile、live book、收费。
**依赖：** T5.3。
**规模：** M。

### Checkpoint P5

- [ ] G4 与单 provider G4A 通过。
- [ ] 只打开明确授权的 provider/product；其他保持 Gate 拒绝。

## 10. Phase 6：永续、外汇和贵金属执行

### T6.1：USDT 永续专项 ADR/Spec

**描述：** 冻结杠杆、保证金、position mode、funding、标记价格、强平、ADL 和风险上限。

**验收：** 获得项目硬边界更新授权；不与现货混账。
**验证：** 威胁模型和 G4B 设计评审。
**依赖：** P5、明确授权。
**规模：** M（设计）。

### T6.2：永续逐 provider 实施与认证

**描述：** 按专项 Spec 逐交易所垂直实现。

**验收：** G4B 每项通过；极端行情/强平/ADL 演练。
**验证：** testnet → 最小 canary → 对账。
**依赖：** T6.1。
**规模：** M/provider。

### T6.3：外汇/贵金属执行专项

**描述：** 按交易场所、合约、杠杆、隔夜费和地区限制独立设计实施。

**验收：** 不复用加密交易假设；真实场所 Gate 通过。
**验证：** sandbox/canary/对账。
**依赖：** P-02、P2/P5。
**规模：** M/provider。

## 11. Phase 7：提现、划转和服务费

### T7.1：资金出站专项产品/安全设计

**描述：** 冻结网络、托管、白名单、限额、冷静期、服务费、审批、退款和责任。

**验收：** 独立 ADR/Spec/威胁模型；交易执行凭证永不具备资金出站权限。
**验证：** G5 设计评审。
**依赖：** P-09。
**规模：** M。

### T7.2：资金服务、账本与对账

**描述：** 独立服务/密钥域、状态机、maker/checker、链上回调和账本。

**验收：** replay/错链/失败/手续费不足无重复出金；链上和账本一致。
**验证：** sandbox、故障注入、恢复和小额 canary。
**依赖：** T7.1。
**规模：** M（按网络拆分）。

## 12. Phase 8：Maintenance CI/CD 控制面

### T8.1：固定 workflow 与短期凭证适配器

**描述：** 限定仓库、workflow、ref、环境和动作，不接受任意命令。

**验收：** Maintenance 无长期 token；参数注入失败；调用幂等。
**验证：** security tests、secret scan、失陷演练。
**依赖：** T3.1。
**规模：** M。

### T8.2：staging/production/rollback 状态闭环

**描述：** 触发、回调验签、人员分离、同制品 staging 前置和追加部署事实。

**验收：** 触发不等于成功；失败不切 current；rollback 目标合法。
**验证：** callback replay/乱序、CI fixture、浏览器。
**依赖：** T8.1。
**规模：** M。

### Checkpoint P8

- [ ] G7 通过。
- [ ] 当前 Runbook 和证据控制面可安全回退。

## 13. Phase 9：全平台发布收口

### T9.1：全量合同、迁移、质量和恢复

**描述：** 更新 Current Spec/API/OpenAPI/Runbook/ADR，执行全量测试、迁移、恢复、回滚和安全扫描。

**验收：** 本次启用能力的全部 Gate 通过，未启用能力明确关闭。
**验证：** quality release pipeline、真实浏览器、恢复/回滚演练。
**依赖：** 计划纳入发布的各 Phase。
**规模：** M。

### T9.2：运营演练与灰度发布

**描述：** 完成客服、风控、财务、事故、密钥泄露、provider 故障和回滚演练，再逐 capability 灰度。

**验收：** 发布清单明确 provider/product/capability；监控和停止条件可执行。
**验证：** canary、首小时监控、复盘。
**依赖：** T9.1。
**规模：** M。

## 14. 并行化规则

可并行：Phase 1 身份、Phase 2 provider 调研、Phase 3 设计 token，在共享 contracts 冻结后分别进行。
必须串行：数据库迁移编号、中央 API Policy、共享 contracts、Execution Service、账本、CI/CD 发布事实。
需要单一 owner：`package-lock.json`、route inventory、共享 RBAC、账本 posting、release workflow。

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 一次性全改导致基线不可用 | 极高 | 按 Phase 纵向切片、每阶段回归和回滚点 |
| 需求参数仍空白 | 高 | G0 阻断对应任务，不由研发猜测 |
| 角色链接泄露批量提权 | 极高 | 越级校验、hash、限流、撤销、审计、泄露响应 |
| 多市场数据授权/质量不确定 | 高 | provider 合同和单市场 Gate |
| 实盘代码存在即被误开 | 极高 | 单一 named gate + provider/product 授权 + 默认关闭 |
| 永续复用现货风控 | 极高 | 独立 ADR/G4B/账本与事故演练 |
| 提现权限进入交易服务 | 极高 | 独立服务、密钥域和数据库角色 |
| CI/CD 控制面变 RCE | 极高 | 固定 workflow、短期凭证、无任意参数、双审 |
| Target 文档被当作生产事实 | 高 | 文档状态矩阵、Current/Target 双层合同 |

## 16. 需要用户/需求方确认

- P-01–P-12 产品参数。
- Phase 1 是否作为首个开发阶段。
- 每阶段资源、负责人和验收日期。
- 真实永续、提现/划转和自动部署是否分别获准立项；未明确授权时保持 `BLOCKED`。
