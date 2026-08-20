# Implementation Plan: Riverton 受控测试与七智能体对齐

## Objective

在单一 Next.js、PostgreSQL 和共享组件体系中，完成 Client、Operations、Maintenance 的功能/登录/权限分离；以《七智能体动态策略系统_用户说明书》为 Client 交易大厅产品真源，先完成可验证的影子/模拟闭环，再按迁移矩阵补齐 Operations/Maintenance。

## Source of Truth

1. `docs/product/PRD.md`
2. `docs/product/SEVEN_AGENT_TRADING_HALL.md`
3. `docs/specs/SYSTEM_SPEC.md` 与三应用 Spec
4. `docs/architecture/CAPABILITY_MIGRATION_MATRIX.md`
5. `docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md`
6. `docs/roadmap/CONTROLLED_BETA_ROADMAP.md`

旧 handoff、历史计划和已经勾选的任务不能覆盖上述最新真源。

## Architecture Decisions

- AgentNovas 是技术平台；Riverton Capital 是对外产品。
- 平台服务钱包只支付会员和 AI 服务；交易策略资金留在客户交易所。
- 三张官方策略卡的目标边界是 BTC/ETH/SOL 的 USDT 现货；用户自建 1x 永续研发/回测是独立模拟产品。
- 七产品角色为市场分析、技术分析、策略研究、反方审查、风险审批、AI 最终决策和交易执行；audit 是横切能力。
- 当前只允许 shadow/paper。真实永续订单关闭；真实现货执行也不在本计划中启用。
- 页面权限改善体验，API audience + RBAC + data scope 才是安全边界。

## Delivery Order

### Phase 0：真源与 CI

1. 建立完整项目文档、PRD、Spec、ADR、API 目录、系统评估和路线图。
2. 把任务状态从“全完成”改为证据化 CURRENT/PARTIAL/TARGET/BLOCKED。
3. 修复测试对 ignored/stale `dist` 的依赖，增加 clean-CI 验证。

### Phase 1：七智能体交易大厅纵向切片

1. 在 `packages/contracts` 定义三卡、七角色、产品边界、决策轮和公开证据合同。
2. 先写失败测试，证明角色数量/顺序、audit 边界、无静态 fallback 和真实订单关闭。
3. Trading Hall API 输出 camelCase、安全状态、七角色目录和真实 decision rounds。
4. Runtime 增加独立 final decision；旧 audit 作为 legacy 审计证据兼容读取。
5. Hall/Meeting 读取 API，删除硬编码价格、风险、静态会议和无行为紧急停止。
6. 浏览器验证空数据、部分事件、完整事件、风险拒绝和模拟执行。

### Phase 2：身份与 API 收口

1. 建立覆盖 131 routes 的机器可读 API policy。
2. 迁移 legacy role 接口；legacy fallback 加开关、观测和截止日期。
3. 密码 KDF、限流、一次性 bootstrap、内部高权强认证和安全响应头。
4. 公开/内部 health 分层。

### Phase 3：Operations 业务迁移

按 `CAPABILITY_MIGRATION_MATRIX.md`：先 P0 组织/客户/审批/策略治理/账本，再 P1 团队/财务/政策；每个写入具备原因、事务、幂等、双审和审计。

### Phase 4：Maintenance 与运行可观测性

完成模型版本/回滚、三类角色目录、数据集成、Worker heartbeat、技术审计和安全控制验收。

### Phase 5：前端收敛与发布

拆分 Client 单体和 CSS、替换 DOM i18n、补关键 E2E/axe/响应式测试，完成一次性数据库环境和发布证据包。

## Boundaries

- Always：参数化 SQL、接口输入校验、PII/secret 安全视图、服务端权限复核、真实状态、加载/空/错、审计和幂等。
- Ask first：生产迁移、真实外部调用、提交、推送、PR、真实订单。
- Never：跨 audience 数据、密钥回显、虚假地址/成功/实时数据、自动资金执行、把模拟说成真实。

## Verification

每个纵向切片执行定向测试，然后执行：

```bash
npm test
npx tsc --noEmit
npm run lint
npm run test:apps
git diff --check
```

浏览器使用隔离 Profile 和一次性测试 Schema，覆盖 Client、Ops 申请人、Ops 审批人和 Maintenance 管理员。
