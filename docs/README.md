# AgentNovas / Riverton Capital 项目文档

## 文档目的

本目录是产品、研发、运营、运维、测试和上线协作的共同真源。AgentNovas 是技术平台与代码品牌，Riverton Capital 是面向客户的产品品牌。当前目标是 5–20 人受邀付费 Beta；文档描述目标能力时同时标注实现状态，禁止把规划、paper、Demo、已配置或环境开关写成已经上线/真实成交。

责任人采用角色而非个人信息：产品负责人维护 PRD 与商业披露合同，架构负责人维护 System Spec/ADR/API Policy，三端负责人维护对应 App Spec，QA/Release 负责人维护 Gate 与证据，Ops/Maint 值班角色维护 Runbook。代码与测试证据优先于无证据状态标记。

实施快照（2026-08-21）：Wave 1 后端、Operations 和 Client/Maintenance 收口已进入集成树。Client 会员、credits、三张独立 paper、交易大厅、绩效账单和平台 Demo 安全摘要使用稳定路由；七份商业披露确认在页面、权限、trial 和订单服务同时失败关闭。旧客户密钥、充值、外部渠道验证码、社区市场、永续部署与永续研究路径已在 HTTP、租约、Worker 和前向迁移层硬关闭。当前变更完成全量自动化和新一轮隔离浏览器/性能/恢复证据前仍不得开放付费 Beta；Email/Demo/DNS/TLS 没有真实配置时按产品合同降级为未配置，而不是伪造成功。

## 阅读路径

| 角色 | 建议顺序 |
| --- | --- |
| 产品、业务负责人 | `product/PRD.md` → `product/SEVEN_AGENT_TRADING_HALL.md` → `../tasks/plan.md` |
| 前后端研发 | `specs/SYSTEM_SPEC.md` → 对应应用 Spec → `api/API_CATALOG.md` → ADR |
| 运营、风控、财务 | `specs/OPERATIONS_APP_SPEC.md` → `architecture/CAPABILITY_MIGRATION_MATRIX.md` → 验收门禁 |
| 运维、安全 | `specs/MAINTENANCE_APP_SPEC.md` → 系统评估 → Runbook |
| QA、交付 | `quality/ACCEPTANCE_AND_RELEASE_GATES.md` → Roadmap → Runbook |

## 核心文档

- `product/PRD.md`：受邀付费 Beta、四档会员、credits、三 paper 组合、人工收款与周分成真源。
- `product/SEVEN_AGENT_TRADING_HALL.md`：由《七智能体动态策略系统_用户说明书》提炼的交易大厅产品真源。
- `specs/SYSTEM_SPEC.md`：系统边界、数据流、权限、状态语义与非功能要求。
- `specs/CLIENT_APP_SPEC.md`：客户应用与七智能体交易大厅规格。
- `specs/OPERATIONS_APP_SPEC.md`：运营业务域、审批、财务与策略治理规格。
- `specs/MAINTENANCE_APP_SPEC.md`：技术配置、模型、Worker、集成、安全与审计规格。
- `architecture/CAPABILITY_MIGRATION_MATRIX.md`：旧运营后台能力去向、保留/重构/下线决定。
- `review/SYSTEM_ASSESSMENT_2026-08-20.md`：基于当前代码的系统评估和风险分级。
- `api/API_CATALOG.md`：接口目录、audience、鉴权与迁移状态。
- `api/openapi-controlled-beta.yaml`：受控测试阶段核心接口合同。
- `quality/ACCEPTANCE_AND_RELEASE_GATES.md`：自动化、浏览器、安全与发布门禁。
- `roadmap/CONTROLLED_BETA_ROADMAP.md`：按阶段门禁和人日范围排列的优化路线。
- `runbooks/commercial-beta-operations.md`：邀请、付款复核、credits、分成和争议处理。
- `runbooks/commercial-beta-maintenance.md`：MFA 恢复、Demo 熔断、Email suppression、密钥与事故。
- `runbooks/commercial-beta-release-and-rollback.md`：发布、首小时监控、回滚和数据恢复。
- `../tasks/plan.md` / `../tasks/todo.md`：14 天实施顺序与唯一进度清单。

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

## 状态标签

文档统一使用以下标签：

- `CURRENT`：当前代码已有，并通过与风险相称的验证。
- `PARTIAL`：已有部分实现，但仍缺关键合同、权限、数据或验收。
- `TARGET`：已对齐的目标设计，尚未完成。
- `BLOCKED`：受外部服务、法规、安全评审或明确授权限制。
- `RETIRED`：明确下线，不再迁移。

## 不可变交付边界

- 不启用真实现货/永续订单，不接收客户交易所密钥。
- 不执行自动/链上支付、客户充值、真实退款或生产数据库迁移。
- 真实 Email 与 staging Demo smoke 必须满足外部依赖并获显式授权；CI 只使用净化 fixture。
- Credits、历史服务钱包、客户 paper 本金和平台 Demo 资金完全隔离。
- 密钥、完整私有端点、Webhook payload 和凭证不得进入浏览器、日志、文档或 Git。
