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

### T1.7：权限配置交互减负

**状态：** 已完成。Operations 与 Maintenance 共享权限中心的角色创建、模板发布、草稿角色发布
和用户分配均改为页面内审计原因并单击提交，不再使用二次确认弹窗。敏感权限仍只创建
maker/checker 申请；审批决定、角色撤销、恢复码与设备会话等独立高风险动作仍保留显式确认。

**验收：** 普通配置按钮仅在审计原因有效时启用；同一原因可连续用于本轮配置；敏感角色和分配
不能绕过服务端 RBAC、recent MFA 与双人审批；浏览器实际创建/发布普通角色时无 dialog。
**验证：** UI 合同 RED/GREEN、全量测试、TypeScript、ESLint、安全门禁、三端云端 production
build，以及隔离 PostgreSQL + 真实 Chromium 18 场景。
**依赖：** T1.3 与既有 Access Center/RBAC 基线。
**规模：** S。

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

**T2.11a 实施证据（2026-08-24）：** Runtime Worker 先严格校验 provider 响应，再过滤
`closeTime > evaluatedAt` 的当前未收盘尾项；引擎校验策略 timeframe 与本轮 K 线身份一致，按
`timeframe + 30s` 派生 cadence 准入。stale/invalid 只拒绝 entry，exit 继续生成意图。新增 7 项
纯函数/引擎测试，PostgreSQL Runtime 22/22（含真实未收盘尾项）和全量 1364/1364 通过；
TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、secret scan 与 production audit 通过。
`ssh an-saas` 以提交 `9403899` 的 3070 文件精确归档和 Node 22.21.1 完成 Client 68、
Operations 62、Maintenance 51 页 production build；本切片无 UI/auth 变化，不重复使用窄浏览器
测试冒充全平台 Gate，最终阶段仍须在最新产物重跑三端空浏览器登录。

### T2.3：主备源切换和价格/时间/完整性校验

**描述：** 支持账户一致源、独立选择、策略级源和 Coinbase fallback。

**状态：** 部分完成。T2.3a provider 无关单周期仲裁合同已实现；T2.3b 有状态切换、真实
provider adapter、账户/策略偏好和 Coinbase fallback 仍等待 P-01/P-03 与供应商 fixture。

**分阶段：**

- T2.3a：先交付 provider 无关的单周期主备仲裁合同，使用显式 source 顺序和阈值，严格校验
  canonical scope、provider symbol、服务端时间、新鲜度、价格偏差和各 provider sequence；
  无法确认完整性时失败关闭新开仓。
- T2.3b：真实 provider adapter 确定后补齐有状态防抖/切回、gap/reset/replay、容量与故障注入。
- T2.4/T2.5：另行实现账户一致源、用户独立偏好、策略级版本绑定和加密 Coinbase fallback。

**验收：** 偏好优先级确定；不可用源准确降级；策略读取绑定版本。
**验证：** API/UI contract、切换 E2E、stale Gate。
**依赖：** T2.2。
**规模：** M。

**T2.3a 实施证据（2026-08-24）：** 纯合同按显式来源顺序校验 provider symbol、canonical
scope、服务端时间/新鲜度、每 provider sequence 和精确十进制价格。只有唯一最高实时共识簇，
或由另一个 provider 的 fresh reference 验证的候选可接管；2 对 2 冲突簇、自身参考价、未来接收
事件、stale/duplicate/out-of-order/scope mismatch 均失败关闭。定向 46/46、全量 1378/1378、
TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、secret scan、production dependency
audit 0 和差异检查通过。实现提交 `ef18d71`；云端以 `122317a` 精确快照和 Node 22.21.1 完成
Client 68、Operations 62、Maintenance 51 页 production build、production-only audit 0 和真实
nginx 语法检查。无网络、数据库、route、UI 或真实 provider 变更，因此不重复运行浏览器专项。

### T2.4：加密行情源选择与策略级绑定

**描述：** 支持行情源跟随交易账户或独立选择，并把解析结果固定到具体策略/部署版本；不把
provider 字段写入策略 DSL，也不允许浏览器自报授权、健康或执行资格。

**状态：** 进行中。T2.4a provider-independent 纯合同已完成；T2.4b 的持久化、账户能力
解析、API、UI、Runtime 身份与历史迁移等待 P-01 和 provider/account capability registry。

**分阶段：**

- T2.4a：严格选择意图、服务端账户/capability 快照、稳定 blocked reason、不可变解析绑定和
  deterministic fingerprint；只允许 display/research，不授权订单且不含默认 fallback。
- T2.4b：保存版本化选择/解析策略，接入 Client 与 Runtime，把 binding/policy fingerprint 纳入
  决策轮、回测、验证和行情快照证据；旧记录明确 `legacy_unpinned`。

**验收：** 账户归属/状态/只读能力和 provider/scope/usage 失败关闭；修改当前偏好不能静默改变
既有绑定；不同绑定不共享同一 Runtime 决策轮；同 DSL 换源必须重测。
**验证：** 纯合同 RED/GREEN、PostgreSQL 不可变/并发、API/UI contract、Runtime 回放与浏览器。
**依赖：** T2.1、T2.2、T2.3；T2.4b 另依赖 P-01。
**规模：** M。

**T2.4a 实施证据（2026-08-24）：** 新增选择意图、账户与 capability 快照、稳定阻断原因、
不可变解析绑定和双 fingerprint 合同。账户一致模式要求归属、启用、只读和 provider 完全匹配；
独立选择不得夹带账户，`customer_account` 数据源必须有精确账户证据，公共/授权源不得伪造账户。
policy 与 binding instance 使用版本化 tuple 哈希，字段顺序不改变结果；任何输出均明确
`authorizesOrders=false`，不提供隐藏默认或 Coinbase 特例。17 项新测试与相关行情定向 48/48，
完整测试 1411/1411 及类型、Lint、架构、安全、secret 与依赖门禁通过。实现提交 `c9d1d90`；
T2.4b 继续等待 P-01/provider registry，不因纯合同完成而解锁持久化、UI、Runtime 或 G2。

### T2.5：Coinbase 加密 fallback

**描述：** 在 P-01 冻结后，把 Coinbase 作为加密市场的显式默认 fallback，完成授权、symbol、
限流、健康、主备顺序和故障恢复；不能把该默认套用到股票、外汇或贵金属。

**验收：** fallback 优先级有产品结论；只有通过 T2.3 完整性校验才接管；恢复不抖动。
**验证：** Coinbase sandbox/fixture、限流/断线/价格冲突故障注入、UI。
**依赖：** P-01、T2.2b、T2.3b、T2.4。
**规模：** M。

### T2.6–T2.9：六个股票市场行情

**描述：** 按 P-03 覆盖美国、A 股、港股、韩股、日股、澳股六个市场，逐市场完成指数、热门股、
全市场搜索和 K 线；首期以 15 分钟延迟提供，运维端可控可见性，实时行情只能在授权后通过独立升级
Gate。市场不按“优先/随后”改变冻结范围，provider、交易日历、时区、停牌、复权和 symbol 仍逐市场验证。

**验收：** 授权与 SLA 记录；交易日历/时区、停牌、复权和 provider symbol 正确；UI 市场切换完整；
延迟数据与实时升级状态明确区分，未通过 Gate 不得伪装实时。
**验证：** provider sandbox、节假日/午休/停牌/复权测试、延迟与实时状态、浏览器。
**依赖：** P-03、T2.1/T2.2。
**规模：** M/市场。

### T2.10：外汇和贵金属行情基础

**描述：** 在 P-02 冻结后接入只读报价、交易时段和合约元数据，暂不自动下单。

**验收：** 报价/点差/时区准确；无交易场所时只读；不复用加密 symbol 假设。
**验证：** provider fixture、周末/隔夜边界、UI。
**依赖：** P-02、T2.1。
**规模：** M。

### Checkpoint P2

- [ ] G2 按市场通过。
- [ ] 旧加密/Paper 行情回归全绿。

## 7. Phase 3：配置、计费、主题和语言

### T3.0：Maintenance 配置与控制交互减负

**状态：** 已完成。Maintenance 普通配置、测试、发布、模型回滚、商业披露、充值启停、Demo 安全控制和紧急暂停均使用页面内影响说明与审计原因并单击执行，应用内不再使用确认弹窗。密钥/会话凭证展示等独立安全流程不在本任务范围。

**验收：** Maintenance 工作区源码和真实浏览器均无确认 dialog；普通与高风险动作按钮只有在页面内原因有效、业务前置条件满足时才可执行；每次请求仍携带服务端校验的原因；recent MFA、RBAC、maker/checker、幂等、状态机和审计边界不变。
**验证：** UI 合同、TypeScript、ESLint、Maintenance production build，以及隔离 PostgreSQL + 真实 Chromium 配置保存、紧急暂停/恢复和逐页无弹窗回归。
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
3. `T3.1c-Brand/Domain`、`Prompt/Skill`、`Pricing`：分别在 P-10/P-11、
   `docs/product/PROMPT_SKILL_V1_REQUIREMENTS_CONFIRMATION.md` 的 PS-01–PS-06、P-07/P-08
   参数确认后接入，禁止占位值生效。

**当前状态：** T3.1c-FF1 与 FF2 已完成（2026-08-24）；品牌/域名、Prompt/Skill 与 Pricing 配置族仍为 Target/Blocked。Prompt/Skill 的发布治理已经确认，但具体角色范围、Skill 执行模型、安全包络、测试器、新任务生效和删除语义仍待 PS-01–PS-06 冻结。注册族固定为 `client.strategy_research` 与 Client audience；schema v1 保留严格 `{enabled:boolean}` 全局语义，schema v2 提供单条显式 targeting 规则。服务端生成确定性测试证据，Client 只通过最小权限 current 网关读取，并在 GET/POST 共用“环境 Gate AND active 配置”的判定。没有 active 版本时保持现有环境开关行为；active 配置只能进一步收窄，不能打开被环境或能力 Gate 禁用的功能。Maintenance 使用受限字段与页面内原因直接操作，无二次弹窗。

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

### T3.9：Maintenance AI 用量分析

**分阶段：** T3.9a 先交付可信用量与运行记录分析；P-08 参数已经冻结，但固定对话 Credits consumer、模型/功能价格分档和计费模式切换作为独立 T3.9b 实现，不属于当前 S0。两者不得混写为同一完成状态。

**T3.9a 状态：** 已完成（2026-08-24）。Maintenance `/ai-usage` 与 `GET /api/maintenance/ai-usage` 基于 `client_ai_inference_requests.created_at` 的 UTC 请求创建 cohort，统计已完成 Credits 预留并建立 inference 记录的总体。看板提供可信成功 Token、settled Credits、已记录非取消失败率，按组织请求级快照（区分 `captured_at_request`、`legacy_current_backfill`、`legacy_unattributed`）、稳定伪名用户、固定模型 revision、Agent、功能和日期分组；默认 30 天、最大 90 天，高基数维度最多返回请求量 Top 50。

**语义边界：** preflight 拒绝、用户取消和处理中请求不进入失败率分母，用户取消也不进入分子，因此该指标不是系统或 provider 可用率。API 不返回原始用户 ID、客户 PII、AI 内容、错误原文或模型凭证；敏感只读权限为 `maint.ai_usage.view`。当前全局 MFA Gate 默认关闭，不增加登录或操作弹窗；正式生产重新开启后仍按权限策略要求 recent MFA。日期筛选在原页面单击应用，不使用确认弹窗。

**验收：** UTC 两端完整且最多 90 天；成功 Token 与 settled Credits 口径精确；组织历史质量可辨；用户只返回稳定伪名；历史按请求固定 revision；非法日期返回 400；无会话/无权限分别返回 401/403；Client/Operations 不含该页面。
**验证：** 全量逻辑测试 1430/1430、TypeScript、ESLint、8 条架构边界、secret scan（3096 个候选文件）、production dependency audit 0；`ssh an-saas` Node 22.21.1 完成 Client 67、Operations 62、Maintenance 52 页 production build，bundle budget、三端 key-custody 与官方 Nginx 配置检查通过；下载云端产物后，本地隔离 PostgreSQL + 真实 Chromium/axe 20/20，覆盖三端空浏览器登录、Maintenance 有权限看板、非法共享日期 URL 可恢复且不产生控制台告警、配置动作零冗余确认弹窗。质量 schema 和 runtime secrets 已清理，本机原 build cache 已恢复。
**依赖：** T4.3a 的可信 usage/取消单终态事实；T3.9a 不依赖固定价格 consumer，T3.9b 采用已经冻结的 P-08 参数并需通过独立实现与 Gate。
**规模：** M。

### T3.10–T3.11：六主题与 i18n 基础

**描述：** 建立三浅三深 token、图表/Logo/状态色和英语默认语言优先级。

**验收：** 六主题完整；偏好 > 浏览器/地区 > 英语；无闪烁和不可读状态。
**验证：** visual regression、contrast、四断点、SSR/hydration。
**依赖：** P-10。
**规模：** M。

**分阶段：** T3.11a 先完成不依赖 P-10 视觉稿的纯 locale allowlist、公开 Client 英语首屏、
匿名保存偏好和浏览器语言解析，只使用 `navigator.languages`，不引入 IP/GPS 定位。T3.11b 再完成
已登录三端、认证/错误页、邮件、格式化器和数据库偏好一致性；其覆盖语言及 Maintenance
`defaultLocale` 是否可覆盖英语仍待需求方确认。六主题继续等待 P-10。

**T3.11a 实施证据（2026-08-24）：** 唯一七语言 allowlist、有界浏览器别名解析、英语 fallback、
匿名 localStorage 偏好和公开 Client 动态字典已实现；不使用 IP/GPS/时区推断。自动加载与人工选择
有竞态保护，硬编码中文可见/aria 标签已进入七语言字典。定向 31/31、全量 1385/1385、TypeScript、
全仓 ESLint、8 条架构边界、三端 key-custody、secret scan、production audit 0 和差异检查通过；
实现提交 `81b86bc`。本证据不覆盖 T3.11b 或六主题。

云端 `d6b6c5f` 精确快照由 Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页
production build、production audit 0 和真实 nginx 检查。云端 standalone 下载摘要一致后，本地
隔离 PostgreSQL + 真实 Chromium 18/18 通过，覆盖语言优先级/持久化/非法值及三端登录无回归；
测试 schema、运行时秘密和临时构建产物均已清理。

**T3.11b1 边界：** 先用 forward migration 把新账号 `users.locale` 默认改为 `en-US`，并以
`NOT VALID` 七语言 CHECK 约束未来写入，不批量修改或假定既有账号值是显式偏好。实际 PostgreSQL
必须证明历史未知值保留、新非法值拒绝、七语言通过和迁移可重放；用户修改 API 与三端消费留给
语言范围确认后的 T3.11b2。

**T3.11b1 实施证据（2026-08-24）：** migration `0073`、SQLite/Drizzle 默认和实际 PostgreSQL
测试已完成，实现提交 `bfeb9bb`。定向 locale 合同/数据库 8/8、完整 0000–0073 migration 链相关
3/3、全量 1386/1386 及 TypeScript、全仓 ESLint、架构边界、key-custody、secret scan、production
audit 0、差异检查全部通过；没有改写历史账号，也没有开放尚未确认的用户偏好 API。

云端 `93d63fe` 精确快照由 Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页构建，
production audit 0、官方 nginx 1.29.8 检查通过；源码归档摘要在本地与云端一致。纯数据库切片不重复
声明浏览器证据，紧邻 T3.11a 的完整 Chromium 18/18 继续有效，最终收口仍须在最新整体产物重跑。

### Checkpoint P3

- [ ] 配置/价格历史与审批 Gate 通过。
- [ ] 六主题和英语主旅程通过无障碍/性能基线。

## 8. Phase 4：AI 助手与策略市场

> **编号映射（重要）：** 本节的 `T4.x` 是计划编号，与 `todo.md` 看板的 `4.x` **不是同一套编号**，
> 不能按数字直接对应。以下是唯一映射表；新增条目必须同时登记两侧编号，避免做错任务。
>
> | 本计划 | 看板 `todo.md` | 内容 |
> | --- | --- | --- |
> | T4.1 | 4.1 | AI 助手统一入口与信息架构收敛（P-04 已确认不做 QuantDinger 移植参考） |
> | T4.1a | 4.4a | 可编辑结构化策略候选（已完成） |
> | T4.1b | 4.2 | 已确认旧界面元素退役（已完成） |
> | T4.1c | 4.3a | AI 普通对话取消、重试与 Credits 单终态（已完成） |
> | T4.1d | 4.13 | 工作记录详情与 Maintenance 受控导出（进行中） |
> | T4.2 | 4.5、4.6 | 策略准入门槛版本化与投稿/审核/上架状态机（等待 P-05） |
> | T4.3 | 4.7、4.8 | 策略广场浏览/详情与作者、绩效分成、分账合同（P-06 已确认） |
> | T4.4 | 4.9、4.10、4.11 | 跟单参数、四方停止路径与 Paper/Demo 端到端闭环 |

### T4.1：AI 助手统一入口与信息架构收敛

**描述：** P-04 已冻结不做 QuantDinger 移植参考。按 AgentNovas 自有七阶段决策链、受限策略 DSL、
确定性校验、回测和准入合同收敛 AI 助手信息架构，保留对话、快捷问题和持久历史。

**验收：** 统一入口与信息架构逐项验收；Credits 规则按独立 P-08/T3.9b 边界处理；错误/取消/重试无重复扣费。
**验证：** contract、usage/ledger、浏览器。
**依赖：** T3.2；不依赖第三方移植仓库、演示或差异清单。
**规模：** M。

### T4.1a：可编辑结构化策略候选（对应任务看板 T4.4a）

**状态：** 已完成。T4.4 总任务继续进行，4.4b 等待 T2.4/P-01。

**描述：** 在不等待第三方移植参考与真实 provider 的前提下，补齐 PRD 已明确的结果闭环：研发
时间线提供文字建议，候选公开完整 DSL，客户首次保存前可编辑 JSON 参数；服务端重新执行 V1–V3
白名单校验。任何语义修改都丢弃原回测资格并保存为 `UNVERIFIED`，格式变化不误降级。

**验收：** 相同规范化输入幂等返回同一不可变版本；已保存候选不能用不同 DSL 静默重放；编辑后
UI 不保留 verified 样式；非法 JSON/DSL 不入库；只允许 shadow/paper，真实订单仍不可达。

**验证：** 纯合同、PostgreSQL 并发/重放、UI 合同、四断点/axe 和 production Chromium。
**依赖：** 已完成 DSL V1–V3、多 Agent 候选与策略草稿；4.4b 的 provider 字段另依赖 T2.4/P-01。
**规格：** `docs/specs/EDITABLE_STRATEGY_CANDIDATE_SPEC.md`。
**规模：** 先服务端、后 UI 两个 M 以下纵向增量。

**实施证据（2026-08-24）：** 服务端提交 `cffdd4b`，Client 提交 `795f552`，浏览器/质量夹具提交
`e020240`、`31a8c0f`、`19e516e`。完整 DSL 由服务端重新规范化；格式等价保留标签，语义修改保存为
`manual + UNVERIFIED`，原评分/回测不再展示；候选保存用事务锁、不可变版本重放和冲突失败关闭。
最终 `npm test` 1394/1394 及全部静态/安全门禁通过。`ssh an-saas` Node 22.21.1 三端 production
build 为 68/62/51 页；同一云端 standalone 在 MFA 关闭、外部写入禁用、隔离 PostgreSQL 下真实
Chromium 18/18，通过三端登录、候选编辑/刷新/零真实订单请求和 Maintenance 无确认弹窗回归。

### T4.1b：已确认旧界面元素退役（对应任务看板 T4.2）

**状态：** 已完成（2026-08-24）。

**边界：** Client 行情页不再展示、读取或写入观察名单；对应 API 从 Client 路由和最小数据库
授权中移除，但历史 `market_watchlist` 表与数据暂不做破坏性迁移。`/assistant` 不提供分析标的
选择和旧 8 卡片，只保留 4 个必要快捷问题；`/studio` 的账户、合约、周期和方向仍是确定性研究
输入，不属于应删除的助手分析标的控件。

行情页继续通过同源报价、K 线与新闻 API 展示可验证的新鲜度，不在真实 provider adapter 尚未
完成时从浏览器直连外部 WebSocket。该边界与生产 CSP、`MARKET_DATA_CONTRACT_SPEC.md` 以及
M-02 的 `PARTIAL` 状态保持一致。

**验证：** 静态合同锁定 UI/API/inventory/数据库授权边界；生产 Chromium 覆盖搜索、品种索引、
四断点、axe、无观察名单请求和无外部网络；三端空浏览器登录及 Maintenance 无确认弹窗一并回归。

### T4.1c：AI 普通对话取消、重试与 Credits 单终态（对应任务看板 T4.3a）

**状态：** 已完成（2026-08-24）。T4.3 总任务继续进行；P-08 参数已冻结，固定 Credits consumer 和模型/功能分档归入尚未实现且不属于当前 S0 的 T3.9b。

**边界：** Client 只接收服务端签发的 inference ID，不能选择用户、reservation 或 Credits 数值。
`POST /api/ai/inferences/:id/cancel` 按当前会话用户过滤所有权；跨租户与不存在统一 404。取消、完成和
失败在 inference/reservation 行锁下竞争唯一终态：未结算预留只释放一次，完成先发生则保留回复和
实际结算，已结算但结果不完整必须进入人工核对，迟到 provider 结果不能重开已取消请求。

Client 收到 SSE meta 后直接显示“取消生成”，单击即中止当前流并确认服务端终态，不增加确认弹窗；
结果不确定时“重试原请求”继续复用原 Idempotency-Key，不会再次调用模型、写入用户消息或重复扣费。
provider 外部 AbortSignal 与既有 45 秒超时组合，首次生成及 DSL 修复调用均可中止。

**规格：** `docs/specs/AI_CONVERSATION_CANCEL_RETRY_SPEC.md`。
**验证：** provider/route/UI 合同、PostgreSQL 所有权与并发竞态、全量测试、静态/安全门禁、云端三端
production build，以及 MFA 默认关闭、外部写入禁用的三端真实 Chromium 19/19。

**实施证据：** 主实现提交 `b8b1bda`；首次 production Chromium 发现 AI 页眉 2.71:1 对比度并由
`2faf8d8` 修正为高对比度 token。最终 `npm test` 1418/1418；固定 Node 22.21.1 云端构建为
Client 67、Operations 62、Maintenance 51 页，production audit 0，最终浏览器 19/19。

### T4.1d：工作记录详情与受控导出（对应任务看板 T4.13）

**状态：** 进行中。该能力不依赖 P-01–P-12，不改变真实订单硬关闭边界。

**目标合同：** Client 通过 `/work-records` 查看属于自己的历史决策轮，并进入稳定详情页查看完整七阶段公开对话、固定策略名称与版本、行情快照摘要、客户组合准入、模拟订单意图、成交回执和审计标识。公共决策内容按 ADR-0018 共享，客户准入和成交必须按当前用户所有权隔离；纯 hold 轮也必须可见。Maintenance 仅通过独立敏感权限、近期 MFA 策略和页面内审计原因导出脱敏安全投影，不获得客户业务原表或原始用户 ID。

**增量任务：**

1. WR1 合同/查询：定义有界 DTO、稳定不透明游标、最多 50 条分页和详情 404 语义；Client 查询以订阅 `started_at/ended_at` 限制共享轮时间范围，以 `deployment.owner_user_id` 限制组合数据。
2. WR2 Client API：新增 `GET /api/work-records` 与 `GET /api/work-records/:id`，统一 `client.paper.view`、`no-store`、参数上限和安全错误信封；同步 inventory、OpenAPI 与合同测试。
3. WR3 Client UI：新增 `/work-records` 与 `/work-records/:id`，提供加载、错误、空态、分页、七阶段记录、行情/风控/意图/成交与“公共决策、个人准入”说明；覆盖 320/768/1024/1440、键盘和 axe。
4. WR4 Maintenance 投影：新增 security-barrier 安全视图，只暴露伪名用户和 allowlist 字段；Maintenance DB role 只获得该视图 SELECT，新敏感权限不得覆盖显式撤权墓碑。
5. WR5 Maintenance 导出：使用 `POST /api/maintenance/work-records/export`，日期最多 31 天、最多 1,000 条、请求体严格、same-origin、幂等与页面内 3–500 字审计原因；返回无公式注入风险的 JSON，不落本地文件、不回显原始用户 ID/PII/模型凭证/错误原文。

**当前进度：** WR1、WR2、WR3 与六个月数据库删除保护已完成。共享轮严格匹配订阅期间固定版本；只有纯 `hold` 且无客户周期才显示“无需准入”，其他缺周期轮显示“未记录”。订阅区间由数据库校验客户/订阅/部署/版本/卡片/品种/模式一致性并拒绝重叠，启停使用同一 advisory lock 串行化；列表查询使用热路径索引和 5 秒只读事务超时。

WR3 已交付 `/work-records` 列表与 `/work-records/:id` 详情：详情按“公共决策 → 行情摘要 →
七阶段 → 你的组合准入 → 模拟意图/成交 → 审计边界”排序，准入五种状态逐一区分文案，
明示 `realOrderRoutingEnabled=false`；列表用「加载更多」累积不透明游标并按 `recordId` 去重。
工作区经 `next/dynamic` 懒加载，Client 初始 JS 仅 +79 字节。新增两条契约测试锁定
“白名单与分发是两份真源”和“无需准入 ≠ 未记录”。WR4–WR5 仍待后续切片。

**验收：** 跨客户 IDOR 返回统一 404；纯 hold 与有组合准入两类记录均可追溯；列表分页不重复不遗漏；导出调用写入追加式审计且重放不重复生成审计事件；记录保留合同至少六个月，任何清理器不得提前删除关联决策、事件、意图和回执。

**验证：** 纯合同、PostgreSQL ownership/时间窗/并发/保留、API Policy/RBAC/最小权限、TypeScript、ESLint、架构与 secret Gate、云端三端 production build、本地真实 Chromium/axe 三端登录和工作记录主旅程。
**依赖：** 已完成 ADR-0018、共享决策轮、官方 Paper 意图/回执和三端 RBAC；无产品参数阻断。
**规格：** `docs/specs/STRATEGY_WORK_RECORDS_SPEC.md`。

### T4.2：策略准入与投稿状态机

**描述：** 结构化策略、至少 180 天历史回测、至少 30 笔成交、正收益、按风险等级的 10%/15%/20% 最大回撤边界、人工审核、披露和版本重审。不设置强制模拟盘运行时长。

**验收：** 任一门槛未达时明确标记 `NOT_QUALIFIED` 且不能上架或跟单；重大更新新建版本；审核禁止自审；运营端调整阈值不得放宽冻结的 P-05 边界。
**验证：** domain/state tests、PostgreSQL concurrency、四角色浏览器。
**依赖：** P-05、T4.1。
**规模：** M。

### T4.3：策略广场与作者/费用合同

**描述：** 浏览、详情、作者、投稿、20% 实盘绩效分成、UTC 自然周、高水位线和作者/平台 50%/50% 分账合同；不收固定策略订阅费。

**验收：** 策略/费用/风险版本快照；按客户-策略维护高水位线，亏损周不收费且先补回历史高水位线；已结算费用不退款；S0 Paper-only 结果只作“模拟、不可提现、未实际结算”展示，不产生真实商业或资金账本副作用；下架不改历史订阅；退款/争议有状态。
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
