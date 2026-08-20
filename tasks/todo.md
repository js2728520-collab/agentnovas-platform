# Riverton 受控测试任务清单

状态：`[x] CURRENT` 已有证据；`[-] PARTIAL` 部分完成；`[ ] TARGET` 待开发；`[!] BLOCKED` 不在当前授权范围。

## P0 真源与验证

- [x] CURRENT：三应用 audience、独立 Cookie、服务端路由分发和共享 Shell。
- [x] CURRENT：Client 服务钱包/充值/通知基础页；未配置支付不生成假地址。
- [x] CURRENT：Operations 充值人工操作、只读账本和 Access Center 基础闭环。
- [x] CURRENT：Maintenance 模型安全视图、邮件/支付状态、作用域紧急暂停基础页。
- [x] CURRENT：PRD、七智能体基线、系统/三应用 Spec、迁移矩阵、系统评估、API 目录、OpenAPI、验收门禁和路线图。
- [x] CURRENT：清洁 CI；rendered HTML 合同不再读取 ignored/stale `dist`，三端构建后会启动真实 Client production server 执行 HTML 冒烟。
- [ ] TARGET：把 131 个 API route 纳入机器可读 audience/permission/scope policy。

## P0 七智能体交易大厅

- [x] CURRENT：说明书中的三卡参数、七角色、决策轮、非托管和失败即安全原则已同步到文档。
- [x] CURRENT：共享合同定义三卡、七角色、产品边界、运行时映射和 decision round 完整性。
- [x] CURRENT：Runtime 新周期独立记录 AI 最终决策；audit 仅作为横切/legacy 证据兼容读取。
- [x] CURRENT：Client 首屏、官方策略卡和 Hall 删除硬编码价格、风险指数、延迟、交易所和 fallback 业绩，空数据如实显示。
- [x] CURRENT：Meeting 从 API 读取决策轮与七阶段记录，明确完整、部分和 legacy 缺口。
- [x] CURRENT：删除无行为 Client “紧急停止”，接真实客户控制合同前不显示。
- [-] PARTIAL：浏览器已验证登录页、404 audience 隔离和无控制台错误；登录态空/部分/完整决策轮及四档响应式仍需仓库化 E2E 证据。
- [!] BLOCKED：真实现货自动跟随；需独立合规、安全、交易所和上线授权。
- [!] BLOCKED：真实永续订单；明确不启用。

## P0 身份与安全

- [-] PARTIAL：当前应用 RBAC 与数据范围已用于新页面，legacy role fallback 仍广泛存在。
- [ ] TARGET：迁移关键 legacy API，设置 fallback 观察和退出日期。
- [ ] TARGET：密码 KDF、登录/找回/bootstrap 限流、一次性 bootstrap。
- [ ] TARGET：Operations/Maintenance 高权限强认证/MFA。
- [ ] TARGET：CSP 与公开 health 最小化。
- [ ] TARGET：通知/成员创建不保存临时密码，改为一次性设置链接。

## P1 Operations

- [-] PARTIAL：客户、组织树、充值、账本、财务、审批、RBAC 页面已有基础。
- [ ] TARGET：组织树和成员接口完全接入新 RBAC/data scope。
- [ ] TARGET：客户详情、备注历史、归属、冻结/恢复完整闭环。
- [ ] TARGET：策略上架/修改/下架双人治理中心。
- [ ] TARGET：团队任务、每日简报、月度目标和跟进。
- [ ] TARGET：收入、结算、应收、收款确认、付款资料和调整单完整闭环。
- [ ] TARGET：旧通用审批按业务适配器重构，补事务/锁/幂等。
- [ ] TARGET：迁移完成后删除旧 Client Admin 和废弃 API。

## P1 Maintenance

- [-] PARTIAL：模型 Profile/绑定、邮件、支付、健康、安全、设置、RBAC 已有页面。
- [ ] TARGET：研发角色、七智能体产品角色、运行时解释角色目录分离。
- [ ] TARGET：模型版本查看、回滚和绑定依赖图。
- [ ] TARGET：市场/新闻数据集成页面。
- [ ] TARGET：Worker heartbeat、lease、队列、最近成功失败。
- [ ] TARGET：统一技术系统审计。

## P1 前端质量

- [ ] TARGET：拆分 4,857 行 `app/client-app.tsx`。
- [ ] TARGET：收敛 3,850 行全局 CSS 重复规则。
- [ ] TARGET：用组件消息合同替换 DOM 文本 i18n。
- [ ] TARGET：仓库化 Playwright 关键 E2E、axe 和四档响应式测试。
- [ ] TARGET：所有列表/表单的 skeleton、空态、错误、重试和重复提交保护复核。

## 外部操作

- [!] BLOCKED：真实支付、邮件外发、生产 Webhook 注册、生产数据库迁移。
- [!] BLOCKED：本地提交、远程推送和 PR；仅在用户明确授权后执行。
