# AgentNovas / Riverton Capital 项目文档

## 文档目的

本目录是产品、研发、运营、运维、测试和上线协作的共同真源。AgentNovas 是技术平台与代码品牌，Riverton Capital 是面向客户的产品品牌。`product/PRD.md` 已更新为需求方确认的完整三端交易平台目标；当前已部署实现仍是受控 Beta/Paper 基线。文档描述目标能力时必须标注实现状态，禁止把规划、真实交易目标、paper、Demo、已配置或环境开关写成已经上线/真实成交。

责任人采用角色而非个人信息：产品负责人维护 PRD 与商业披露合同，架构负责人维护 System Spec/ADR/API Policy，三端负责人维护对应 App Spec，QA/Release 负责人维护 Gate 与证据，Ops/Maint 值班角色维护 Runbook。代码与测试证据优先于无证据状态标记。

实施快照（2026-08-22）：`v1.0.0-beta.5` 已以四张 `linux/amd64` 版本化容器部署到自托管目标；Client 公开着陆页、认证交易工作台和 FORCE RLS 身份 gateway 通过真实账号回归，Operations、Maintenance、PostgreSQL 健康，Notification Worker 运行但 Email send 关闭。`beta.4` 因生产 Credits smoke 发现旧身份表依赖而被 Gate 拦截，未登记为 current；beta.5 修复后完整复验。Payment、Demo、策略外部执行、LLM 和优盾仍保持 disabled/unconfigured，不生成假地址、假成交或假成功。完整发布身份、镜像、迁移、账号/浏览器证据和 `beta.3` 回滚目标见 `releases/2026-08-22-v1.0.0-beta.5-deployment.md`。

## 阅读路径

| 角色 | 建议顺序 |
| --- | --- |
| 新成员、跨团队对齐 | `DOCUMENT_STATUS_MATRIX.md` → `product/PRD.md` → `product/FULL_PLATFORM_V3_FUNCTIONAL_DESCRIPTION.md` |
| 产品、业务负责人 | `product/PRD.md` → `review/FULL_PLATFORM_V3_READINESS_2026-08-23.md` → `roadmap/FULL_PLATFORM_V3_ROADMAP.md` → `../tasks/plan.md` |
| 前后端研发 | `specs/V3_SYSTEM_TARGET_SPEC.md` → 对应 V3 App Spec → 当前 `api/API_CATALOG.md` → ADR |
| 运营、风控、财务 | `specs/V3_OPERATIONS_APP_TARGET_SPEC.md` → V3 Gate → `../tasks/todo.md` |
| 运维、安全 | `specs/V3_MAINTENANCE_APP_TARGET_SPEC.md` → ADR-0019/0020/0021/0022/0023 → V3 Gate → 当前 Runbook |
| QA、交付 | `quality/FULL_PLATFORM_V3_GATES.md` → V3 Roadmap → 当前证据/Runbook |
| 发布值班、事故负责人 | `runbooks/commercial-beta-release-and-rollback.md` → 当前版本 `releases/` 部署记录 |
| Phase 9 演练主持人 | `runbooks/phase9-operational-drills.md` → `releases/2026-08-26-r4-preview-operational-drill.md` |

## 核心文档

- `DOCUMENT_STATUS_MATRIX.md`：全部文档的 Target、Current、Foundation、Historical 与 Retired 分类。
- `product/PRD.md`：需求方已确认的完整三端平台产品真源，覆盖行情、AI、策略市场、真实交易目标、权限注册链接、运营和运维；高风险能力仍受 ADR、安全评审和发布 Gate 约束。
- `product/PROMPT_SKILL_V1_REQUIREMENTS_CONFIRMATION.md`：Prompt/Skill 高层发布治理已经确认后，仍需需求方冻结的六项运行时实施边界与推荐回复格式。
- `product/FULL_PLATFORM_V3_FUNCTIONAL_DESCRIPTION.md`：V3 跨团队功能说明。
- `product/FUNCTIONAL_DESCRIPTION.md`：当前 Beta/Paper 已实现功能基线。
- `product/SEVEN_AGENT_TRADING_HALL.md`：由《七智能体动态策略系统_用户说明书》提炼的交易大厅产品真源。
- `specs/V3_SYSTEM_TARGET_SPEC.md`：V3 系统、数据、执行、安全和发布目标。
- `specs/V3_CLIENT_APP_TARGET_SPEC.md`、`V3_OPERATIONS_APP_TARGET_SPEC.md`、`V3_MAINTENANCE_APP_TARGET_SPEC.md`：三端目标规格。
- `specs/SYSTEM_SPEC.md` 与现有三端 App Spec：当前 Beta/Paper 可达合同和硬关闭边界。
- `specs/RELEASE_VERSION_MANAGEMENT_SPEC.md`：SemVer、不可变验证/部署证据、环境 current 与回滚状态机。
- `specs/VERSIONED_CONFIGURATION_FRAMEWORK_SPEC.md`：通用配置 draft/test/approve/schedule/activate/rollback 合同；T3.1a 内核/API、T3.1b 工作台/最小权限自动激活 Worker、功能开关全局 v1 与定向 v2 已实现，其余配置族仍为 Target/Blocked。
- `specs/MARKET_DATA_CONTRACT_SPEC.md`：T2.1/T2.2a/T2.3a/T2.11a 多市场合同；provider 独立类型、当前四市场兼容 API、流状态机、单周期仲裁及 Runtime candle stale Gate 已实现，真实供应商、WebSocket adapter 与 stream 综合准入仍待授权和优先级结论。
- `specs/MARKET_SOURCE_BINDING_SPEC.md`：T2.4 行情源选择与策略级绑定合同；provider-independent 选择/解析、不可变绑定和双 fingerprint 已实现，持久化、UI 与 Runtime 接入等待 P-01/provider registry。
- `specs/AI_CONVERSATION_CANCEL_RETRY_SPEC.md`：T4.3a 普通对话取消、provider abort、原请求安全重放和 Credits 唯一终态合同；固定 Credits 数值与模型/功能分档仍等待 P-08。
- `specs/MAINTENANCE_AI_USAGE_ANALYTICS_SPEC.md`：T3.9a Maintenance AI 用量安全聚合合同；按 UTC 请求创建 cohort 展示可信成功 Token、settled Credits、已记录非取消失败率和脱敏多维分析，固定价格仍等待 P-08。
- `architecture/CAPABILITY_MIGRATION_MATRIX.md`：Current→V3 详细能力矩阵，覆盖 route、数据库、三端页面、Worker/Execution Service、测试、Gate、共享热点与退休项。
- `review/FULL_PLATFORM_V3_READINESS_2026-08-23.md`：V3 当前准备度、主要差距和风险优先级。
- `review/SYSTEM_ASSESSMENT_2026-08-20.md`：历史商业 Beta 基线评估。
- `api/API_CATALOG.md`：接口目录、audience、鉴权与迁移状态。
- `api/openapi-controlled-beta.yaml`：受控测试阶段核心接口合同。
- `quality/FULL_PLATFORM_V3_GATES.md`：V3 按能力解锁的强制 Gate。
- `quality/ACCEPTANCE_AND_RELEASE_GATES.md`：当前 Beta 发布门禁。
- `roadmap/FULL_PLATFORM_V3_ROADMAP.md`：V3 分阶段升级路线图。
- `roadmap/CONTROLLED_BETA_ROADMAP.md`：历史 Beta 路线图。
- `runbooks/commercial-beta-operations.md`：邀请、付款复核、credits、分成和争议处理。
- `runbooks/commercial-beta-maintenance.md`：MFA 恢复、Demo 熔断、Email suppression、密钥与事故。
- `runbooks/commercial-beta-release-and-rollback.md`：发布、首小时监控、回滚和数据恢复。
- `runbooks/udun-deposit-gateway.md`：优盾商户配置、币种映射、回调、复核、停用和事故处理。
- `runbooks/production-accounts-and-configuration.md`：三端验收账号、凭证取回、配置审计、Resend、优盾、LLM 与 Demo 的安全配置步骤和填空脚本。
- `runbooks/phase9-operational-drills.md`：客服、风控、财务、事故、provider 故障与密钥泄露的人员演练步骤、SLA、停止条件和证据模板。
- `releases/2026-08-22-v1.0.0-beta.5-deployment.md`：当前 `v1.0.0-beta.5` 的 Client 工作台、身份/数据库边界、真实账号 smoke、浏览器证据、配置事实和 `beta.3` 回滚目标。
- `releases/2026-08-22-v1.0.0-beta.3-deployment.md`：前一成功版本 `v1.0.0-beta.3` 的公开着陆页修复、真实部署过程和历史回滚目标。
- `releases/2026-08-22-v1.0.0-beta.2-deployment.md`：前一版本 `v1.0.0-beta.2` 的真实部署过程、证据、异常和历史回滚目标。
- `../tasks/plan.md` / `../tasks/todo.md`：V3 分阶段实施计划与唯一任务看板。

## 决策记录

- `adr/0005-riverton-three-app-rbac-wallet.md`：三应用、RBAC、充值账本底座。
- `adr/0006-platform-product-and-funds-boundaries.md`：技术平台、产品品牌及两类资金边界。
- `adr/0007-seven-agent-decision-chain.md`：七智能体职责、确定性内核和审计边界。
- `adr/0008-invited-paid-beta-boundary.md`：5–20 人最小商业闭环与硬关闭范围。
- `adr/0009-customer-paper-platform-demo-separation.md`：客户 paper 与平台 Demo 证据隔离。
- `adr/0010-manual-membership-and-paper-performance-fees.md`：会费、credits 和 paper 分成人工双审。
- `adr/0011-central-api-policy-and-explicit-access.md`：机器可读 API Policy、显式授权和 scope。
- `adr/0012-postgres-migrations-ledger-and-worker-evidence.md`：迁移、账本与 Worker 运行证据。
- `adr/0013-product-owned-commercial-disclosures.md`：平台自维护七份商业披露、发布双审和确认 Gate。
- `adr/0014-immutable-release-version-management.md`：发布身份、独立复核、追加式环境证据与控制面边界。
- `adr/0015-udun-deposit-only-gateway.md`：优盾充值专用通道、回调证据与双人复核入账边界。
- `adr/0016-versioned-container-delivery.md`：三端 standalone 镜像、SemVer、secret、数据库和原子切流/回滚边界。
- `adr/0017-client-dashboard-and-scoped-commercial-disclosures.md`：公开 `/`、认证 `/dashboard`、统一客户交易 Shell 和作用域化披露 Gate。
- `adr/0018-shared-decision-rounds-and-per-portfolio-admission.md`：共享决策轮与按组合准入。
- `adr/0019-ga-execution-service-and-key-custody.md`：Execution Service、密钥托管、订单与对账基础。
- `adr/0020-live-accounting-and-the-named-gate.md`：live book 与单一实盘 Gate。
- `adr/0021-full-platform-v3-gated-upgrade.md`：V3 完整目标与分阶段、按能力解锁的升级决策。
- `adr/0022-client-email-and-five-device-security.md`：Client 邮箱验证、五设备、提醒和撤销边界。
- `adr/0023-deferred-mfa-enforcement-rollout.md`：MFA 能力保留、当前关闭与正式生产启用门禁。

## 状态标签

文档统一使用以下标签：

- `CURRENT`：当前代码已有，并通过与风险相称的验证。
- `PARTIAL`：已有部分实现，但仍缺关键合同、权限、数据或验收。
- `TARGET`：已对齐的目标设计，尚未完成。
- `BLOCKED`：受外部服务、法规、安全评审或明确授权限制。
- `RETIRED`：明确下线，不再迁移。
- `HISTORICAL`：保留历史证据，不作为当前实施指令。

## 当前运行时不可变边界

这些边界描述当前生产基线，不否定 PRD V3 的目标；只有对应 V3 Gate 通过并形成新发布证据后才能逐项改变：

- 当前不启用真实现货/永续订单；客户交易凭证和 Execution Service 基础存在，但未通过 live Gate 时不得发送真实订单。
- 客户充值仅允许优盾 deposit-only 通道；未验签或未双人复核不得入账。提现、划转、自动扣款、真实退款仍不可达。
- 真实 Email 与 staging Demo smoke 必须满足外部依赖并获显式授权；CI 只使用净化 fixture。
- Credits、历史服务钱包、客户 paper 本金和平台 Demo 资金完全隔离。
- 密钥、完整私有端点、Webhook payload 和凭证不得进入浏览器、日志、文档或 Git。
