# AgentNovas / Riverton Capital 项目文档

## 文档目的

本目录是产品、研发、运营、运维、测试和上线协作的共同真源。AgentNovas 是技术平台与代码品牌，Riverton Capital 是面向客户的产品品牌。文档描述目标能力时会同时标注当前实现状态，禁止把规划、模拟结果或已配置状态写成已经上线。

## 阅读路径

| 角色 | 建议顺序 |
| --- | --- |
| 产品、业务负责人 | `product/PRD.md` → `product/SEVEN_AGENT_TRADING_HALL.md` → `roadmap/CONTROLLED_BETA_ROADMAP.md` |
| 前后端研发 | `specs/SYSTEM_SPEC.md` → 对应应用 Spec → `api/API_CATALOG.md` → ADR |
| 运营、风控、财务 | `specs/OPERATIONS_APP_SPEC.md` → `architecture/CAPABILITY_MIGRATION_MATRIX.md` → 验收门禁 |
| 运维、安全 | `specs/MAINTENANCE_APP_SPEC.md` → 系统评估 → Runbook |
| QA、交付 | `quality/ACCEPTANCE_AND_RELEASE_GATES.md` → Roadmap → Runbook |

## 核心文档

- `product/PRD.md`：三应用一库的产品目标、范围、角色与业务验收。
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

## 决策记录

- `adr/0005-riverton-three-app-rbac-wallet.md`：三应用、RBAC、充值账本底座。
- `adr/0006-platform-product-and-funds-boundaries.md`：技术平台、产品品牌及两类资金边界。
- `adr/0007-seven-agent-decision-chain.md`：七智能体职责、确定性内核和审计边界。

## 状态标签

文档统一使用以下标签：

- `CURRENT`：当前代码已有，并通过与风险相称的验证。
- `PARTIAL`：已有部分实现，但仍缺关键合同、权限、数据或验收。
- `TARGET`：已对齐的目标设计，尚未完成。
- `BLOCKED`：受外部服务、法规、安全评审或明确授权限制。
- `RETIRED`：明确下线，不再迁移。

## 不可变交付边界

- 不启用真实永续订单。
- 未经专项安全、合规和上线授权，不启用真实现货自动下单。
- 不执行真实支付、真实邮件发送或生产数据库迁移。
- 平台预付余额只能支付会员与 AI 服务，不得作为交易本金、提现余额或用户间转账余额。
- 密钥、完整私有端点、Webhook payload 和凭证不得进入浏览器、日志、文档或 Git。
