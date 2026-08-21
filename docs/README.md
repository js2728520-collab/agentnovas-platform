# AgentNovas / Riverton Capital 项目文档

## 文档目的

本目录是产品、研发、运营、运维、测试和上线协作的共同真源。AgentNovas 是技术平台与代码品牌，Riverton Capital 是面向客户的产品品牌。当前目标是 5–20 人受邀付费 Beta；文档描述目标能力时同时标注实现状态，禁止把规划、paper、Demo、已配置或环境开关写成已经上线/真实成交。

责任人采用角色而非个人信息：产品负责人维护 PRD 与商业披露合同，架构负责人维护 System Spec/ADR/API Policy，三端负责人维护对应 App Spec，QA/Release 负责人维护 Gate 与证据，Ops/Maint 值班角色维护 Runbook。代码与测试证据优先于无证据状态标记。

实施快照（2026-08-22）：`v1.0.0-beta.2` 已以四张 `linux/amd64` 版本化容器部署到自托管目标；Client、Operations、Maintenance 和 PostgreSQL 健康，三端正式域名与 readiness 返回 200，Notification Worker 运行但 Email send 关闭。Payment、Demo、策略外部执行和优盾仍保持 disabled/unconfigured，不生成假地址、假成交或假成功。完整发布身份、CI、镜像、迁移、角色策略、TLS、回滚目标、已知缺陷和后续 Gate 见 `releases/2026-08-22-v1.0.0-beta.2-deployment.md`。

## 阅读路径

| 角色 | 建议顺序 |
| --- | --- |
| 新成员、跨团队对齐 | `product/FUNCTIONAL_DESCRIPTION.md` → 对应角色专项文档 |
| 产品、业务负责人 | `product/FUNCTIONAL_DESCRIPTION.md` → `product/PRD.md` → `product/SEVEN_AGENT_TRADING_HALL.md` → `../tasks/plan.md` |
| 前后端研发 | `specs/SYSTEM_SPEC.md` → 对应应用 Spec → `api/API_CATALOG.md` → ADR |
| 运营、风控、财务 | `specs/OPERATIONS_APP_SPEC.md` → `architecture/CAPABILITY_MIGRATION_MATRIX.md` → 验收门禁 |
| 运维、安全 | `specs/MAINTENANCE_APP_SPEC.md` → 系统评估 → Runbook |
| QA、交付 | `quality/ACCEPTANCE_AND_RELEASE_GATES.md` → Roadmap → Runbook |
| 发布值班、事故负责人 | `runbooks/commercial-beta-release-and-rollback.md` → 当前版本 `releases/` 部署记录 |

## 核心文档

- `product/FUNCTIONAL_DESCRIPTION.md`：三端、角色、业务流程、状态、安全边界和发布条件的完整功能说明；适合作为团队共同入口。
- `product/PRD.md`：受邀付费 Beta、四档会员、credits、三 paper 组合、人工收款与周分成真源。
- `product/SEVEN_AGENT_TRADING_HALL.md`：由《七智能体动态策略系统_用户说明书》提炼的交易大厅产品真源。
- `specs/SYSTEM_SPEC.md`：系统边界、数据流、权限、状态语义与非功能要求。
- `specs/CLIENT_APP_SPEC.md`：客户应用与七智能体交易大厅规格。
- `specs/OPERATIONS_APP_SPEC.md`：运营业务域、审批、财务与策略治理规格。
- `specs/MAINTENANCE_APP_SPEC.md`：技术配置、模型、Worker、集成、安全与审计规格。
- `specs/RELEASE_VERSION_MANAGEMENT_SPEC.md`：SemVer、不可变验证/部署证据、环境 current 与回滚状态机。
- `architecture/CAPABILITY_MIGRATION_MATRIX.md`：旧运营后台能力去向、保留/重构/下线决定。
- `review/SYSTEM_ASSESSMENT_2026-08-20.md`：基于当前代码的系统评估和风险分级。
- `api/API_CATALOG.md`：接口目录、audience、鉴权与迁移状态。
- `api/openapi-controlled-beta.yaml`：受控测试阶段核心接口合同。
- `quality/ACCEPTANCE_AND_RELEASE_GATES.md`：自动化、浏览器、安全与发布门禁。
- `roadmap/CONTROLLED_BETA_ROADMAP.md`：按阶段门禁和人日范围排列的优化路线。
- `runbooks/commercial-beta-operations.md`：邀请、付款复核、credits、分成和争议处理。
- `runbooks/commercial-beta-maintenance.md`：MFA 恢复、Demo 熔断、Email suppression、密钥与事故。
- `runbooks/commercial-beta-release-and-rollback.md`：发布、首小时监控、回滚和数据恢复。
- `runbooks/udun-deposit-gateway.md`：优盾商户配置、币种映射、回调、复核、停用和事故处理。
- `releases/2026-08-22-v1.0.0-beta.2-deployment.md`：`v1.0.0-beta.2` 的真实部署过程、证据、异常、回滚目标和下一版改进项。
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
- `adr/0014-immutable-release-version-management.md`：发布身份、独立复核、追加式环境证据与控制面边界。
- `adr/0015-udun-deposit-only-gateway.md`：优盾充值专用通道、回调证据与双人复核入账边界。
- `adr/0016-versioned-container-delivery.md`：三端 standalone 镜像、SemVer、secret、数据库和原子切流/回滚边界。

## 状态标签

文档统一使用以下标签：

- `CURRENT`：当前代码已有，并通过与风险相称的验证。
- `PARTIAL`：已有部分实现，但仍缺关键合同、权限、数据或验收。
- `TARGET`：已对齐的目标设计，尚未完成。
- `BLOCKED`：受外部服务、法规、安全评审或明确授权限制。
- `RETIRED`：明确下线，不再迁移。

## 不可变交付边界

- 不启用真实现货/永续订单，不接收客户交易所密钥。
- 客户充值仅允许优盾 deposit-only 通道；未验签或未双人复核不得入账。提现、划转、自动扣款、真实退款仍不可达。
- 真实 Email 与 staging Demo smoke 必须满足外部依赖并获显式授权；CI 只使用净化 fixture。
- Credits、历史服务钱包、客户 paper 本金和平台 Demo 资金完全隔离。
- 密钥、完整私有端点、Webhook payload 和凭证不得进入浏览器、日志、文档或 Git。
