# AgentNovas 文档状态与同步矩阵

更新日期：2026-08-25
目标分支：`codex/platform-v3-doc-sync`

## 1. 状态说明

| 状态 | 含义 |
| --- | --- |
| `TARGET_TRUTH` | V3 目标产品或目标技术真源 |
| `CURRENT_BASELINE` | 当前已实现/已部署系统的合同或运行手册 |
| `FOUNDATION` | 仍可复用的专项设计基础 |
| `HISTORICAL` | 不改写的发布、评估或阶段记录 |
| `RETIRED` | 仅保留来源，不得作为执行指令 |

当 `TARGET_TRUTH` 与 `CURRENT_BASELINE` 不同时，开发按 Target 设计、按阶段任务迁移；生产运行仍遵守 Current 的失败关闭边界，直到对应 Gate 通过。

## 2. V3 目标真源

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| `README.md` | `TARGET_TRUTH` | 文档入口与阅读路径 |
| `DOCUMENT_STATUS_MATRIX.md` | `TARGET_TRUTH` | 全部文档生命周期与同步规则 |
| `product/PRD.md` | `TARGET_TRUTH` | 完整需求、首期范围、P-01–P-12 冻结参数及 P-07/P-08 真源/快照边界、冲突解释和待补参数 |
| `product/PROMPT_SKILL_V1_REQUIREMENTS_CONFIRMATION.md` | `TARGET_TRUTH/CONFIRMED` | PS-01–PS-06 已冻结；Prompt 版本治理与已接入的 Prompt consumer 仍按独立 Gate 管理，Skill runtime consumer 不属于当前 S0，须通过 T3.10 后再启用 |
| `product/FULL_PLATFORM_V3_FUNCTIONAL_DESCRIPTION.md` | `TARGET_TRUTH` | 跨团队功能说明；S0 仅在独立 G3 证据通过后纳入 Paper/Demo 策略市场、Paper 跟单与明确标注的模拟费用计算，真实跟单与真实商业结算仍由 G4/G4A 及商业/账本 Gate 独立约束 |
| `specs/V3_SYSTEM_TARGET_SPEC.md` | `TARGET_TRUTH` | V3 系统、数据、安全和执行边界；明确 S0 Paper/Demo 跟单、模拟费用计算与 G4/G4A、商业/账本 Gate 的独立边界 |
| `specs/V3_CLIENT_APP_TARGET_SPEC.md` | `TARGET_TRUTH` | Client 目标规格；Paper/Demo 跟单与模拟费用计算可纳入 S0 的前提及真实跟单/结算的后续 Gate 边界 |
| `specs/V3_OPERATIONS_APP_TARGET_SPEC.md` | `TARGET_TRUTH` | Operations 目标规格 |
| `specs/V3_MAINTENANCE_APP_TARGET_SPEC.md` | `TARGET_TRUTH` | Maintenance 目标规格 |
| `specs/VERSIONED_CONFIGURATION_FRAMEWORK_SPEC.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | T3.1 通用发布合同；P-07/P-08 数字以 `packages/contracts/src/product-parameters.ts` 为唯一真源，价格/权益/Credits 历史必须 pin 不可变版本/快照；S0 保留已有独立证据的 Credits 事实但不把模拟费用写入 Credits/服务余额/资金账本；T3.1a 数据/API、T3.1b 工作台/Worker、T3.1c-FF1 全局与 FF2 定向功能开关已实现，其余配置族未完成 |
| `specs/MARKET_DATA_CONTRACT_SPEC.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | T2.1a/T2.1b 合同、当前四市场兼容 API、T2.2a 流状态机、T2.3a 单周期仲裁与 T2.11a Runtime candle stale Gate 已实现；真实 provider/WebSocket adapter 与有状态切换等待 P-01/P-03 |
| `specs/MARKET_SOURCE_BINDING_SPEC.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | T2.4a provider-independent 选择/解析、不可变绑定与双 fingerprint 已实现；T2.4b 持久化、UI、Runtime 和历史迁移等待 P-01/provider registry |
| `specs/AI_CONVERSATION_CANCEL_RETRY_SPEC.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | T4.3a 普通对话取消、provider abort、原请求重放与 Credits 单终态已实现；S0 保留已有独立证据的 Credits 事实，固定 Credits consumer、模型/功能分档与 `provider_usage` 模式切换属于尚未实现且不在当前 S0 的 T3.9b |
| `specs/MAINTENANCE_AI_USAGE_ANALYTICS_SPEC.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | T3.9a UTC 请求创建 cohort、可信成功 Token、settled Credits、已记录非取消失败率和脱敏多维分析已通过完整 Gate；这些是 S0 可保留的独立计量/结算事实，不表示 `provider_usage` 可切换模式已启用；该模式与固定 Credits consumer/价格分档统一属于 S0 之外的 T3.9b |
| `quality/FULL_PLATFORM_V3_GATES.md` | `TARGET_TRUTH` | 分能力验收和发布门禁 |
| `roadmap/FULL_PLATFORM_V3_ROADMAP.md` | `TARGET_TRUTH` | 分阶段升级顺序 |
| `review/FULL_PLATFORM_V3_READINESS_2026-08-23.md` | `TARGET_TRUTH` | 当前基础与 V3 差距 |
| `adr/0021-full-platform-v3-gated-upgrade.md` | `TARGET_TRUTH` | 目标范围与当前基线并存的决策 |
| `adr/0022-client-email-and-five-device-security.md` | `CURRENT_BASELINE/PROVISIONAL` | Client 邮箱与设备安全合同；两项产品参数待确认 |
| `adr/0023-deferred-mfa-enforcement-rollout.md` | `CURRENT_BASELINE/TARGET_TRUTH` | MFA 能力保留、当前关闭与生产启用门禁 |

任务执行真源位于仓库根 `tasks/plan.md` 与 `tasks/todo.md`。

## 3. 当前实现基线

| 文档 | 状态 | V3 使用方式 |
| --- | --- | --- |
| `product/FUNCTIONAL_DESCRIPTION.md` | `CURRENT_BASELINE` | 保留当前 Beta/Paper 完整功能事实 |
| `specs/SYSTEM_SPEC.md` | `CURRENT_BASELINE` | 当前运行架构与硬关闭证据 |
| `specs/CLIENT_APP_SPEC.md` | `CURRENT_BASELINE` | 当前 Client 合同 |
| `specs/OPERATIONS_APP_SPEC.md` | `CURRENT_BASELINE` | 当前 Operations 合同，组织 UI/邀请将迁移 |
| `specs/MAINTENANCE_APP_SPEC.md` | `CURRENT_BASELINE` | 当前 Maintenance、T3.9a AI 用量安全聚合与只登记发布证据合同 |
| `specs/RELEASE_VERSION_MANAGEMENT_SPEC.md` | `CURRENT_BASELINE` | 当前不可变发布证据；V3 后续增加受限 trigger |
| `api/API_CATALOG.md` | `CURRENT_BASELINE` | 当前真实路由和 Policy 索引，不提前虚构 V3 API |
| `api/openapi-controlled-beta.yaml` | `CURRENT_BASELINE` | 当前受控 API 合同 |
| `architecture/CAPABILITY_MIGRATION_MATRIX.md` | `TARGET_TRUTH/PARTIAL_CURRENT` | V3 功能逐项映射到 Current route、DB、页面、Worker、测试、Gate 与新建位置；保留明确退休项 |
| `quality/ACCEPTANCE_AND_RELEASE_GATES.md` | `CURRENT_BASELINE` | 当前 Beta 发布门禁 |
| `quality/QUALITY_RELEASE_EVIDENCE.md` | `CURRENT_BASELINE` | 当前自动质量证据生成方式 |
| `runbooks/commercial-beta-maintenance.md` | `CURRENT_BASELINE` | 当前 Beta Maintenance 操作 |
| `runbooks/commercial-beta-operations.md` | `CURRENT_BASELINE` | 当前 Beta Operations 操作 |
| `runbooks/commercial-beta-release-and-rollback.md` | `CURRENT_BASELINE` | 当前部署和回滚 |
| `runbooks/production-accounts-and-configuration.md` | `CURRENT_BASELINE` | 当前账号与外部配置 |
| `runbooks/riverton-three-app-ui.md` | `CURRENT_BASELINE` | 当前三端 UI 运行方式 |
| `runbooks/self-hosted-strategy-research.md` | `CURRENT_BASELINE` | 当前自托管 Research/Runtime |
| `runbooks/udun-deposit-gateway.md` | `CURRENT_BASELINE` | 当前 deposit-only 能力 |
| `DEVELOPMENT_HANDOFF.md` | `CURRENT_BASELINE` | 历次实施交接；顶部 V3 说明优先 |

## 4. 可复用专项基础

| 文档 | 状态 | V3 关系 |
| --- | --- | --- |
| `ai-assistant-strategy-dsl-v1.md` | `FOUNDATION` | 结构化策略基础，需接 V3 AI/市场合同 |
| `ai-conversation-structured-ui-v3.md` | `FOUNDATION` | 对话 UI 基础 |
| `ai-research-backtest-v2.md` | `FOUNDATION` | 研究与回测基础 |
| `multi-agent-strategy-research-v5.md` | `FOUNDATION` | 多 Agent 研发基础 |
| `product/SEVEN_AGENT_TRADING_HALL.md` | `FOUNDATION` | 七阶段、确定性风控和证据链基础 |

## 5. ADR 生命周期

| ADR | 状态关系 |
| --- | --- |
| 0001–0004 | AI、回测、PostgreSQL Pipeline、DSL/Paper 基础，继续有效 |
| 0005 | 三端/RBAC 基础有效；组织 UI 和注册方式由 ADR-0021 迁移 |
| 0006–0007 | 产品/资金边界和七智能体基础继续有效 |
| 0008 | 受邀 Beta 历史阶段；目标范围被 ADR-0021 取代 |
| 0009 | Paper/Demo 隔离继续有效，V3 增加 Live book |
| 0010 | 当前会员/Paper 分成基线；V3 扩展作者和跟单收费 |
| 0011–0017 | API Policy、迁移、披露、版本、充值、容器和 Client Shell 基础继续有效 |
| 0018 | 共享决策轮和分组合准入基础继续有效 |
| 0019 | Execution Service 与密钥托管基础继续有效 |
| 0020 | live book 与 named gate 基础继续有效 |
| 0021 | V3 目标范围和分阶段 Gate 的当前决策 |
| 0022 | Client 邮箱与五设备安全当前合同；第六设备和城市定位仍为 provisional |
| 0023 | MFA 当前默认不强制、能力保留并在正式生产 Gate 后统一开启 |

ADR 原文不因目标升级批量改写；新决定使用新 ADR supersede。

## 6. 历史与归档资料

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `releases/2026-08-22-v1.0.0-beta.2-deployment.md` | `HISTORICAL` | beta.2 部署证据 |
| `releases/2026-08-22-v1.0.0-beta.3-deployment.md` | `HISTORICAL` | beta.3 部署证据 |
| `releases/2026-08-22-v1.0.0-beta.5-deployment.md` | `HISTORICAL` | beta.5 部署证据 |
| `review/SYSTEM_ASSESSMENT_2026-08-20.md` | `HISTORICAL` | 2026-08-20 审计快照 |
| `roadmap/CONTROLLED_BETA_ROADMAP.md` | `HISTORICAL` | 已完成/被取代的 Beta 路线图 |
| `创始人待办清单与真实交易闭环接入指南.md` | `RETIRED` | 旧规划，禁止作为执行指令 |

## 7. 同步规则

每完成一个 V3 任务，至少同步：

1. PRD/目标 Spec 的状态与验收。
2. 当前 API Catalog/OpenAPI 的真实合同。
3. 数据迁移和 ADR。
4. V3 Gate 与自动化证据。
5. 对应 Runbook 和回滚。
6. `tasks/todo.md` 的状态、证据链接和后续 blocker。

历史发布记录不回填新状态；新发布创建新文件。
