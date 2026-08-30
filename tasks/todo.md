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
- [!] P-01：首期五家交易所优先顺序、MetaMask 用途。
- [!] P-02：外汇/贵金属场所、产品、杠杆、服务地区。
- [!] P-03：A/HK/KR/JP 数据供应商、授权和 SLA。
- [!] P-04：QuantDinger 仓库、演示和可移植版本。
- [!] P-05：策略回测、模拟盘时长、收益/回撤门槛。
- [!] P-06：跟单订阅、收益分成、作者/平台分账和退款。
- [!] P-07：四档套餐 USDT 价格、权益、Credits 和生效日。
- [!] P-08：每次 AI 对话 Credits 值和模型/功能分档。
- [!] P-09：提现/划转网络、限额、白名单、服务费、审批和退款。
- [x] P-10：冻结 Riverton 经典、海湾、松林三组调色板及明暗配对；六主题三端测试站视觉验收已完成。
- [!] P-11：正式域名冻结日。
- [!] P-12：目标验收日期和业务节点。
- [x] 生成 Current → V3 代码/数据库/页面/route/Worker/测试详细矩阵（203 route 文件、268 method route、72 页面 pattern、73 迁移和 7 个后台进程均已核对）。
- [x] 用户已确认需求并授权按分阶段计划推进；每个高风险能力仍需独立 Gate，不等于生产发布批准。
- [x] 0.4 仓库密钥扫描器安全处理 Git 返回的嵌套工作树目录候选，恢复标准 `quality:secret-scan` 门禁且不吞掉普通文件读取错误。

## M1：三端极简安全版

- [x] M1.0 基线审计并同步 PRD、三端 Target Spec、Gate、路线图、能力矩阵和 P-01–P-12 依赖状态。
- [x] M1.1 三端 Shell 与五中心路由；旧稳定地址映射到 Hub/Tab，非法 Tab 回退安全默认值。
- [x] M1.2 三端数据看板仅保留有来源、口径、时间和状态的决策数据。
- [x] M1.3 三端统一设置、六主题、分端语言和 audience 隔离的服务端偏好。
- [x] M1.4 现有功能归位、Client 通知与设备过滤、法律确认按业务节点收口并删除假入口。
- [x] M1.5 `an-saas` 全量质量、三个测试域名部署和三端浏览器/四断点/无障碍联测。

## 当前切片：优盾充值服务完整闭环

- [x] 官方协议差异、完成规格、威胁模型和 ADR-0027。
- [x] RED→GREEN：form-urlencoded/JSON 回调、协议字段版本、支持币种匹配、回调探测、订单先预留和动态网络测试。
- [x] Payment Secret Broker、浏览器加密、配置队列、原子受管文件和最小权限角色。
- [x] Maintenance 只写商户配置、测试证据、回调可达与原子激活 Gate。
- [x] Client 动态网络、建址状态机、地址复制和自动刷新；Operations 不确定状态筛选与统计。
- [x] `an-saas` 远端全量质量、四镜像构建、三端测试站部署与浏览器验收；状态为 `ready_for_live_test`。
- [!] 真实优盾测试商户配置与 1 USDT/TRC20 小额链上闭环；等待操作者通过只写页面提供外部参数并明确执行。

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
    - [-] 3.1c-Brand/Domain 品牌消费者可按已冻结 P-10 推进；正式域名消费者仍等待 P-11。
    - [!] 3.1c-Prompt/Skill Prompt 与技能配置族 schema、测试器和消费者，等待 PS-01–PS-06 实施边界确认。
    - [!] 3.1c-Pricing 价格与 Credits 消费者，等待 P-07/P-08。
- [ ] 3.2 品牌、域名、协议和多语言配置。
- [x] 3.3 模块/用户组织/版本/百分比/定时功能开关。
- [!] 3.4 技能和 Prompt 草稿、测试、双审、历史和回滚，治理能力已确认，运行时消费合同等待 PS-01–PS-06。
- [ ] 3.5 月/季/年/终身套餐版本和 USDT 价格。
- [ ] 3.6 固定对话 Credits 价格与不可变流水。
- [ ] 3.7 人工退款状态机和原渠道结果。
- [ ] 3.8 优惠码/折扣码/优惠券规则。
- [-] 3.9 Token 用户/组织/模型/Agent/日期/功能/费用/失败率统计。
  - [x] 3.9a Maintenance `/ai-usage` 只读分析：按 UTC 请求创建 cohort 汇总已预留 inference，提供可信成功 Token、settled Credits、已记录非取消失败率，以及组织请求级快照（含 legacy 证据质量）、稳定伪名用户、模型 revision、Agent、功能和日期维度；最多 90 天、各高基数维度 Top 50，页面内直接应用日期且无确认弹窗；全量 1430/1430、云端三端 production build 与本地真实 Chromium/axe 20/20 已通过。
  - [!] 3.9b 固定对话费用及模型/功能价格分档，等待 P-08；不得把当前可信 Token 用量和 settled Credits 描述为已确认固定价格，也不得把已记录 cohort 的非取消失败率描述为系统/provider 可用率。
- [x] 3.10 经典/海湾/松林三组调色板明暗配对；三端语义 token、首帧恢复、Logo/状态色和六主题测试站视觉 Gate 已完成。
- [-] 3.11 分端默认语言、浏览器解析和 audience 偏好持久化。
  - [x] 3.11a 公开 Client 着陆页：allowlist、保存偏好 > 浏览器语言 > 英语、无 IP 定位和匿名持久化。
  - [-] 3.11b 已登录偏好与全站一致性。
    - [x] 3.11b1 新账号数据库默认英语、七语言写入约束且不改写既有账号。
    - [-] 3.11b2 已登录三端 audience 偏好、应用 Shell/Hub 覆盖与语言范围已完成；认证/错误页/邮件的逐文案人工语言审校仍待后续 Gate。
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
    - [x] 4.13a-UI `/work-records` 列表/详情、导航、四断点、键盘和 axe。
  - [x] 4.13b Maintenance 脱敏导出：独立敏感权限、security-barrier 安全投影、伪名用户、31 天/1,000 条上限、页面内审计原因、same-origin/幂等与追加式审计。
  - [x] 4.13c 至少六个月保留合同、PostgreSQL/API 安全测试、四断点/axe、云端三端构建和本地真实浏览器三端登录/主旅程 Gate。
    - [x] 4.13c-DB 六个月最低删除保护、所有权/空档/固定版本/纯 hold/非 hold 缺准入/IDOR/分页 PostgreSQL 回归。
    - [x] 4.13c-E2E 最终三端完整 production Chromium 登录/主旅程、四断点、axe、audience 隔离和工作记录导出总 Gate。

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

- [x] 8.0 ADR-0024、威胁模型、独立凭证域、精确 run/OIDC、target fencing/journal/stop、Auditor 与失陷降级已通过多轮 fresh-context 复审；Current 仍只登记证据。
- [x] 8.1 固定仓库/workflow/ref/environment/action 合同。
  - [x] 8.1a 纯 domain contract：严格公共 DTO、服务端 dispatch envelope、完整 snapshot/receipt、状态优先级、exact policy/operation binding、owner epoch/journal sequence 和参数注入拒绝。
  - [x] 8.1b PostgreSQL 命令/审批/lease/delivery/provider/target/stop 追加事实、窄 gateway、RLS/ACL、最小角色与并发/乱序测试。
  - [x] 8.1c 默认关闭的独立 Worker、GitHub App 短期令牌、binding drift、persist-before-POST、崩溃恢复与固定 dispatch adapter。
- [x] 8.2 默认关闭的短期凭证适配器，Maintenance 无长期 token。
- [-] 8.3 staging 触发、回调验签和追加证据；T8.2a Ingress/reconciliation、T8.2b target gateway/OIDC/journal/receipt、T8.2c 分离 WebAuthn verifier/control 与 Maintenance 控制 API/UI、T8.2d1 专用 workflow/独立 Auditor/v4 Auditor-trust-bound reservation/restore/manifest、T8.2d2a staging/production provider/进程/恢复隔离与启动 preflight、T8.2d2b 三域 Web-only preview 替换、default-off config audit 与容器 backup/role-policy 发布门禁已完成；下一步 T8.2d2c 是经授权的真实 provider fixture、演练与 G7。
- [ ] 8.4 production 双审和同制品 staging 前置。
- [ ] 8.5 rollback 合法目标和数据库兼容检查。
- [ ] 8.6 参数注入、回放、乱序、失败和控制面失陷测试。
- [B] 8.7 G7 和应急回退到“只登记证据”。

## Phase 9：全平台收口与发布

- [x] 9.0 在 `an-saas` 隔离 preview 完成当前工作树候选的数据库备份、迁移/角色策略、四镜像构建、三域替换、回滚点和 HTTPS/Host/audience/浏览器/日志验收；2026-08-27 又以 `preview-7c047b6-wt-20260827T013000Z` 刷新到当前 88 个 migration 与 T8.2d2a 代码，正式服务未变。
- [x] 9.1 Current Spec、API Catalog、OpenAPI、ADR、Runbook 全部回填真实状态；已消除工作记录、充值和 77 迁移/154 表恢复证据的陈旧冲突。
- [x] 9.2 全量 unit/contract/PostgreSQL/security/browser/axe/performance：1449/1449、20/20 canonical Chromium/axe、三次 Lighthouse 与全部静态/安全 Gate 绑定 r4 候选通过。
- [x] 9.3 migration fresh/N-1/rerun/concurrent/backup/restore/rollback：77 个迁移、154 张基础表在 `an-saas` 隔离 PostgreSQL 16.14 完成，临时资源已清理。
- [x] 9.4 secret/PII/dependency/container/DB role 和网络边界审计：仓库 3117 个候选文件 0 secret finding、42/42 PII/API 策略定向测试；r4 三端只读/non-root/cap-drop/no-new-privileges/loopback，六条实际连接命中六个最小角色，preview 与 production DB 容器/卷/网络隔离。开发工具链原 17 项临时例外已于 2026-08-27 清零：完整 audit 0、1449/1449、20/20 browser、三端 build/Bundle、Lighthouse 13.4.1、type/lint/架构边界与 release evidence 均通过。
- [ ] 9.5 客服、风控、财务、事故、provider 故障和密钥泄露演练：六场 Runbook/记录表已就绪，隔离技术注入 105/105 通过；真实人员、响应时长和 director/recorder 签字尚未执行，不能以自动测试代替。
- [x] 9.6 已冻结 r4 首轮 canary 的 provider/product/capability 清单：只开三端受控 Web/站内/Paper 已存数据与管理面，无真实 provider、外部 Worker、充值、邮件、Demo、模型推理、真实订单、资金出站或 CI/CD trigger。
- [x] 9.7 r4 P0 preview Web-only canary、首小时监控、停止条件和复盘完成：108/108 HTTP 200、p95 194 ms、72/72 容器样本健康、0 restart/5xx/error marker。开发依赖清零后，r5 dependency-only refresh 又完成 9/9 初始 HTTPS smoke、12/12 Host 失败关闭和 60/60 稳定性采样（p95 172 ms、0 restart/5xx/error marker）；preview KEEP，production/付费 Beta HOLD。
- [ ] 9.8 用户批准发布；未经授权不推送、不创建 PR、不开放生产能力。
