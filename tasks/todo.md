# AgentNovas 全平台 V3 任务看板

分支：`codex/platform-v3-doc-sync`
状态说明：`[x]` 已完成并有证据；`[-]` 正在进行；`[ ]` 未开始；`[!]` 等待需求方/外部条件；`[B]` 安全或规则阻断。

## Phase 0：文档、参数与计划

- [x] V3 PRD、冲突解释和待补参数清单。
- [x] ADR-0021、完整功能说明、System/Client/Operations/Maintenance Target Spec。
- [x] V3 Gate、路线图、准备度评估和文档状态矩阵。
- [x] Current 文档添加 Target/Current/Historical 适用范围说明。
- [x] API target families 和 V3 能力迁移差异登记。
- [x] 分阶段 `tasks/plan.md` 与本任务看板。
- [x] P-01：八家交易所顺序（追加 gate.io/bitget/HTX）；MetaMask 首期不接入。
- [x] P-02：外汇/贵金属只做行情展示，不开放交易。
- [x] P-03：六个股票市场，首期延迟 15 分钟，运维端可控可见性并可升级实时；供应商技术选型后报确认。
- [x] P-04：不做 QuantDinger 移植参考，AI 助手按现有方向演进。
- [x] P-05：回测 ≥180 天、不设模拟盘改强制人工审核、≥30 笔、收益为正；回撤按风险等级 10/15/20% 且运营端可调。
- [x] P-06：只收 20% 分成、无订阅费、作者平台五五、UTC 周 + 高水位线、已结算不退。
- [x] P-07：59/129/499/1999 USDT；积分 1000/3000/12000/36000；费率 20/19/18/16% 运营端可调需双审。
- [x] P-08：默认每次对话 1 积分并保留用量结算（运维端可切换）；策略生成 10 积分；模型 1×/2×。
- [x] P-09：平台服务余额提现纳入范围；三条链；单笔 1 万、日 10 万 USDT；白名单 + 24 小时冷静期；双人复核；费率 0% 透传链上费（见 ADR-0024，G5 前接口仍固定拒绝）。
- [x] P-10：先按现有品牌色派生三浅三深，设计稿到位后替换；默认深色。
- [x] P-11：维持现有三域名并即日冻结。
- [x] P-12：不设日期，按 Gate 推进。
- [x] 生成 Current → V3 代码/数据库/页面/route/Worker/测试详细矩阵（203 route 文件、268 method route、72 页面 pattern、73 迁移和 7 个后台进程均已核对）。
- [x] 用户已确认需求并授权按分阶段计划推进；每个高风险能力仍需独立 Gate，不等于生产发布批准。

## Phase 1：身份、权限与注册链接

- [x] 1.1 从 Operations 导航和页面退休组织架构树/关系编辑。
- [x] 1.2 保留并回归 assignment-bound 组织/分公司 scope。
- [x] 1.3 新增角色权限注册链接迁移、约束和 token hash。
- [x] 1.4 实现主管→员工、经理→主管/员工链接权限。
- [x] 1.5 实现分公司总经理和总公司总经理链接权限。
- [x] 1.6 实现重复使用、手动作废和重生成撤销旧链接。
- [x] 1.7 实现自助注册原子创建身份、assignment、scope 和审计。
- [x] 1.8 实现链接泄露响应、限流、会话排查和账号停用。
- [x] 1.9 分离客户可复用邀请和内部角色 token。
- [x] 1.10 Client 手机号/邮箱必填、邮箱验证、国际手机号。
- [x] 1.11 Client 5 设备限制、新设备/网段变化通知和全量退出（城市级定位待需求方确认）。
- [-] 1.12 完成 G1、PostgreSQL 并发和多身份浏览器验收（本地关闭态 18/18、扩展 MFA 开启态 3/3 与同库开→关→开 9 旅程通过；真实邮件与目标环境生产 Gate 仍待）。
- [x] 1.13 增加 `MFA_ENFORCEMENT_ENABLED`：当前默认关闭、能力和数据保留、三端 UI/API 显示真实状态。
- [-] 1.14 正式生产前将三端 MFA 同时开启并完成首次绑定、验证、恢复码、recent MFA、密码重置及回滚 Gate（本地全部通过；仅目标环境三端一致性与生产变更证据待）。
- [x] 1.15 Operations 客户 PII 字段权限与列表/详情/CSV 导出使用同一脱敏投影。
- [x] 1.16 Operations/Maintenance 权限配置改为页面内审计原因并单击提交；角色、模板、发布和分配不再二次弹窗，敏感授权仍走双人审批。

## Phase 2：多市场行情

- [-] 2.1 provider/market/symbol/calendar/capability 合同。
  - [x] 2.1a provider 独立值类型、严格校验和行情新鲜度安全派生。
  - [x] 2.1b 当前行情目录与 instruments API 加法式兼容升级。
  - [!] 2.1c 真实 provider/授权/优先级注册，等待 P-01/P-03。
- [-] 2.2 WebSocket sequence、延迟、stale、重连和缓存。
  - [x] 2.2a provider 独立 sequence、连接状态、重连退避和缓存展示状态机。
  - [!] 2.2b 真实 WebSocket adapter、provider sequence scope 和容量验证，等待 P-01/P-03。
- [-] 2.3 主备源切换和价格/时间/完整性校验。
  - [x] 2.3a provider 无关单周期仲裁：显式优先级、symbol/scope、时间、新鲜度、精确价格偏差、唯一共识簇和 sequence 失败关闭。
  - [!] 2.3b 有状态防抖/切回、provider gap/reset/replay、容量和真实故障注入，等待 2.2b/P-01/P-03。
- [-] 2.4 加密行情账户一致源、独立选择和策略级绑定。
  - [x] 2.4a provider-independent 选择/解析/不可变绑定纯合同。
  - [!] 2.4b 持久化、账户能力解析、API、UI、Runtime 和历史迁移，等待 P-01/provider registry。
- [ ] 2.5 Coinbase 加密 fallback。
- [ ] 2.6 A 股主要指数、热门股、全市场搜索、K 线和实时行情。
- [ ] 2.7 港股同等能力。
- [ ] 2.8 韩股同等能力。
- [ ] 2.9 日股同等能力。
- [ ] 2.10 外汇/贵金属只读行情基础。
- [-] 2.11 陈旧行情阻断自动新开仓。
  - [x] 2.11a 当前 Runtime 只使用已收盘 K 线，并按周期 cadence 失败关闭陈旧/非法行情的新开仓。
  - [!] 2.11b 接入真实 stream envelope 的 latency/stale/sequence 综合准入，等待 2.2b/P-01/P-03。
- [ ] 2.12 完成每市场 G2、压测和故障注入。

## Phase 3：Maintenance 配置、计费、主题与语言

- [x] 3.0 Maintenance 配置、测试、发布、回滚、集成启停和紧急控制全部改为页面内影响说明与审计原因并单击执行，不使用确认弹窗；高风险服务端 Gate 保持不变。
- [-] 3.1 通用配置 draft/test/approve/schedule/activate/rollback。
  - [x] 3.1a 不含秘密的不可变配置版本、测试、独立审批、调度、激活/回滚内核与 Maintenance API。
  - [x] 3.1b Maintenance 配置发布工作台、时区预览和最小权限到期激活器。
    - [x] 3.1b-UI `/configurations` 工作台、全流程内联审计原因且无确认弹窗、四断点/axe/真实 Chromium。
    - [x] 3.1b-Worker 到期扫描、租约、最小数据库权限、幂等恢复和告警。
  - [-] 3.1c 品牌/域名/协议、功能开关、Prompt/技能和价格配置族逐项接入。
    - [x] 3.1c-FF1 `client.strategy_research` 全局开关 v1：严格 schema、服务端确定性测试、最小权限 current 消费者、运行时双 Gate 和回滚证据。
    - [x] 3.1c-FF2 用户/组织/应用版本/百分比/独立时窗 targeting：严格 schema v2、稳定分桶、服务端上下文、最小权限 current 消费者和回滚证据。
    - [!] 3.1c-Brand/Domain 品牌与域名消费者，等待 P-10/P-11。
    - [-] 3.1c-Prompt/Skill Prompt 与技能配置族。PS-01–PS-06 已于 2026-08-24 全部按推荐方案冻结。
      - [x] PS1 家族合同：10 个角色（7 研发 + 3 运行时解释）Prompt v1 与声明式 Skill v1 严格 schema、双预算（字符 + UTF-8 字节）、安全包络不可覆盖、固定注入样例的确定性测试器；纯合同，无运行时消费者，active 不代表已接管 Prompt 解析。
      - [ ] PS2 运行时消费者与任务固定：解析器改读 active current，并按 PS-05 把 configurationVersionId + payloadSha256 固定到新建任务；已排队、执行中和历史任务不受激活或回滚影响。
      - [ ] PS3 Maintenance 工作台：草稿、顶层差异、确定性测试证据、独立审批、调度、回滚与页面内审计原因，无确认弹窗。
    - [!] 3.1c-Pricing 价格与 Credits 消费者，等待 P-07/P-08。
- [ ] 3.2 品牌、域名、协议和多语言配置。
- [x] 3.3 模块/用户组织/版本/百分比/定时功能开关。
- [-] 3.4 技能和 Prompt 草稿、测试、双审、历史和回滚。治理能力与 PS-01–PS-06 实施边界均已确认；合同层（PS1）已完成，工作台与运行时消费者见 3.1c-Prompt/Skill 的 PS2/PS3。
- [ ] 3.5 月/季/年/终身套餐版本和 USDT 价格。
- [ ] 3.6 固定对话 Credits 价格与不可变流水。
- [ ] 3.7 人工退款状态机和原渠道结果。
- [ ] 3.8 优惠码/折扣码/优惠券规则。
- [-] 3.9 Token 用户/组织/模型/Agent/日期/功能/费用/失败率统计。
  - [x] 3.9a Maintenance `/ai-usage` 只读分析：按 UTC 请求创建 cohort 汇总已预留 inference，提供可信成功 Token、settled Credits、已记录非取消失败率，以及组织请求级快照（含 legacy 证据质量）、稳定伪名用户、模型 revision、Agent、功能和日期维度；最多 90 天、各高基数维度 Top 50，页面内直接应用日期且无确认弹窗；全量 1430/1430、云端三端 production build 与本地真实 Chromium/axe 20/20 已通过。
  - [!] 3.9b 固定对话费用及模型/功能价格分档，等待 P-08；不得把当前可信 Token 用量和 settled Credits 描述为已确认固定价格，也不得把已记录 cohort 的非取消失败率描述为系统/provider 可用率。
- [ ] 3.10 三浅三深六主题和图表/Logo/状态色。
- [-] 3.11 英语默认、浏览器/地区推断和偏好持久化。
  - [x] 3.11a 公开 Client 着陆页：allowlist、保存偏好 > 浏览器语言 > 英语、无 IP 定位和匿名持久化。
  - [-] 3.11b 已登录偏好与全站一致性。
    - [x] 3.11b1 新账号数据库默认英语、七语言写入约束且不改写既有账号。
    - [!] 3.11b2 已登录三端、认证/错误页/邮件一致性及 Maintenance override，等待语言范围确认。
- [ ] 3.12 完成配置、计费、主题无障碍与性能 Gate。

## Phase 4：AI 助手与策略市场

- [ ] 4.1 QuantDinger 差异清单和验收样例。
- [x] 4.2 移除观察名单、分析标的选择和旧 8 卡片。
- [-] 4.3 AI 对话、固定 Credits、取消/重试/幂等。
  - [x] 4.3a 普通对话服务端取消、provider abort、同 key 安全重放、Credits 单终态和无弹窗 Client 交互。
  - [!] 4.3b 固定 Credits 数值与模型/功能分档消费者，等待 P-08，不以当前按可信用量结算冒充固定价格。
- [-] 4.4 文字建议、可编辑参数和结构化策略输出。
  - [x] 4.4a 候选完整 DSL 编辑、服务端重校验、语义修改降级与不可变保存。
  - [!] 4.4b 新市场/provider 字段和完整结果浏览器验收，等待 T2.4/P-01 后续输入。
- [ ] 4.5 策略回测、模拟盘和准入规则版本。
- [ ] 4.6 客户草稿、投稿、审核、上架、下架和重大版本重审。
- [ ] 4.7 策略浏览、筛选、卡片、详情、作者和风险披露。
- [ ] 4.8 订阅费、收益分成和作者/平台分账快照。
- [ ] 4.9 跟单账户、金额、仓位、止盈止损、杠杆、最大亏损。
- [ ] 4.10 用户/运营风控/自动风控/全局熔断停止路径。
- [ ] 4.11 在 Paper/Demo 完成端到端跟单，不发送真实订单。
- [ ] 4.12 完成 G3 和策略市场浏览器验收。
- [x] 4.13 工作记录详情与 Maintenance 受控导出。
  - [x] 4.13a Client 历史列表/详情：公共七阶段、固定策略版本、行情摘要、个人准入、模拟意图/成交和审计标识；所有权、订阅时间窗、游标分页与统一 404 失败关闭。
    - [x] 4.13a-BE 不可变订阅区间、Client 列表/详情 API、安全投影、固定版本、统一 404、热路径索引/超时和 API/Nginx/OpenAPI 合同。
    - [x] 4.13a-UI `/work-records` 列表/详情、Client 导航入口、懒加载（初始 JS +79 字节）、「加载更多」游标累积去重、准入五态逐一区分、四断点/键盘/axe 与 20/20 真实 Chromium 通过。
  - [x] 4.13b Maintenance 脱敏导出：迁移 0076 建 security-barrier 安全视图（21 个 allowlist 字段、单向伪名）并把 7 张工作记录原表从运维端角色撤权；独立敏感权限 `maint.work_records.export`、same-origin、Idempotency-Key、8 KiB 严格 body、31 天/1,000 条上限与 `truncated` 标注、不落导出文件、审计只记查询摘要与条数；Maintenance `/work-records` 只有导出页，路由合同拒绝逐条详情。
  - [x] 4.13c 至少六个月保留合同、PostgreSQL/API 安全测试、四断点/axe、云端三端构建和本地真实浏览器三端登录/主旅程 Gate。
    - [x] 4.13c-DB 六个月最低删除保护、所有权/空档/固定版本/纯 hold/非 hold 缺准入/IDOR/分页 PostgreSQL 回归。
    - [x] 4.13c-E2E 本地真实 Chromium 21/21：Client 主旅程与 Maintenance 导出旅程均已覆盖；导出用例实际提交一次导出并断言请求体只含 from/to/reason、Idempotency-Key、attachment/no-store/x-export-retention 响应头、单向伪名、`recorded` 与 `not_required` 两种准入状态共存、零确认弹窗、四断点与 axe。质量夹具新增工作记录链（挂在 clientSecurity，避免污染主客户「恰好三张组合」不变量）。

## Phase 5：真实现货与自动跟单

- [ ] 5.1 交易所余额/持仓与 live book 持续对账。
- [ ] 5.2 分叉检测、账户/品种阻断和安全平仓规则。
- [ ] 5.3 Client live activation 记录和 blocker UI。
- [ ] 5.4 客户凭证只读+交易权限和 IP 白名单验证。
- [ ] 5.5 按 P-01 完成首个 provider 生产现货认证。
- [ ] 5.6 最小额、撤单、部分成交、超时查单、手续费和精度测试。
- [ ] 5.7 自动跟单扇出、限流、幂等和单账户失败隔离。
- [ ] 5.8 回执、reconcile、live book、绩效和收费一致性。
- [ ] 5.9 provider/account/strategy kill switch 和恢复演练。
- [ ] 5.10 小范围 canary 与首小时监控。
- [ ] 5.11 按交易所逐个重复 G4A，不使用全局开关。

## Phase 6：永续、外汇和贵金属执行

- [B] 6.1 USDT 永续专项 ADR/Spec 和项目硬边界更新授权。
- [B] 6.2 杠杆、保证金、position mode、reduce-only、funding、标记价格。
- [B] 6.3 强平、ADL、极端行情和独立账本/绩效。
- [B] 6.4 永续逐 provider testnet/canary/G4B。
- [!] 6.5 外汇/贵金属执行场所和产品合同。
- [ ] 6.6 外汇/贵金属专项适配、风控、对账和 Gate。

## Phase 7：提现、划转和服务费

- [B] 7.1 独立资金产品 ADR、Spec、威胁模型和合规评审。
- [B] 7.2 独立服务、密钥域、DB role 和网络边界。
- [B] 7.3 地址白名单、冷静期、限额、风险筛查和 maker/checker。
- [B] 7.4 服务费、退款、账本和链上确认状态机。
- [B] 7.5 replay、错链、手续费不足、provider 故障和恢复演练。
- [B] 7.6 小额 canary 和 G5；未全部通过时 endpoint 持续不可达。

## Phase 8：Maintenance CI/CD 控制面

- [B] 8.1 固定仓库/workflow/ref/environment/action 合同。
- [B] 8.2 短期凭证适配器，Maintenance 无长期 token。
- [B] 8.3 staging 触发、回调验签和追加证据。
- [B] 8.4 production 双审和同制品 staging 前置。
- [B] 8.5 rollback 合法目标和数据库兼容检查。
- [B] 8.6 参数注入、回放、乱序、失败和控制面失陷测试。
- [B] 8.7 G7 和应急回退到“只登记证据”。

## Phase 9：全平台收口与发布

- [ ] 9.1 Current Spec、API Catalog、OpenAPI、ADR、Runbook 全部回填真实状态。
- [ ] 9.2 全量 unit/contract/PostgreSQL/security/browser/axe/performance。
- [ ] 9.3 migration fresh/N-1/rerun/concurrent/backup/restore/rollback。
- [ ] 9.4 secret/PII/dependency/container/DB role 和网络边界审计。
- [ ] 9.5 客服、风控、财务、事故、provider 故障和密钥泄露演练。
- [ ] 9.6 明确本次启用的 provider/product/capability 清单。
- [ ] 9.7 canary、首小时监控、停止条件和复盘。
- [ ] 9.8 用户批准发布；未经授权不推送、不创建 PR、不开放生产能力。
