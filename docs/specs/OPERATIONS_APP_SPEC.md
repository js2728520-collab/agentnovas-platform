# Operations 应用规格

## 1. 职责边界

Operations 处理客户、组织、业务策略治理、平台充值、账本、收入、结算、收款和业务审批。模型、密钥、Worker 和技术开关属于 Maintenance；技术管理员不能凭技术权限代替业务审批。

## 2. 权限域

目标权限键：

- 客户：`ops.customers.view`、`ops.customers.manage`、`ops.customers.pii_reveal`。
- 组织：`ops.organization.view`、`ops.members.manage`、`ops.invitations.manage`、`ops.attributions.manage`。
- 团队：`ops.analytics.view`、`ops.team_tasks.manage`、`ops.team_targets.manage`。
- 策略：`ops.strategies.review`。
- 充值/账本：`ops.deposits.view`、`ops.deposits.pii_reveal`、`ops.deposits.action_request`、`ops.deposits.action_approve`、`ops.ledger.view`。
- 财务：`ops.revenue.view`、`ops.settlements.manage`、`ops.collections.manage`、`ops.payout_profiles.manage`、`ops.adjustments.request`、`ops.adjustments.approve`。
- 政策与审计：`ops.follow_policy.manage`、`ops.audit.view`。
- 授权：`ops.roles.manage`、`ops.roles.assign`、`ops.roles.approve_sensitive`。

## 3. 客户与组织

- 客户列表和详情按数据范围过滤；PII 在服务端脱敏。
- 查看、备注、冻结/恢复、归属修改分别授权和审计。
- 组织树必须使用 RBAC 数据范围，不能通过旧角色接口扩大到整个组织。
- 成员创建、上下级变更、停用和邀请均是敏感组织操作；验证关系环和跨组织越权。

## 4. 策略治理

- 平台官方策略和社区策略的上架、修改、下架进入统一审批队列。
- 申请人/作者不得自审；至少两个不同授权主体完成需要的审核。
- 审批通过只改变治理状态，不自动部署、不自动给客户下单。
- 七智能体规则、风险参数或模型版本的升级必须引用回测、模拟、影子和灰度证据。

## 5. 充值与账本

- 平台充值仅用于服务余额。
- 列表和详情的脱敏规则一致；无 PII 权限不返回完整邮箱、电话、地址、provider order ID 或交易哈希的敏感部分。
- 人工操作包含原因、申请状态、第二人批准/拒绝、幂等和冲突处理。
- “审批已记录”不表示链上退款、入账或账本变更已执行。
- 账本只读，不提供编辑/删除；调整使用新交易和反向分录。

## 6. 财务

- 月报、收入、结算、应收、收款确认、付款资料和调整单分别建模。
- 真实收款和付款保持人工流程，记录证据、操作者、复核者和时间。
- 付款资料变化为敏感操作；二维码/图片证据使用受控对象存储引用，不把大段 base64 放入审计日志。

## 7. RBAC 与审计

- 只展示 Operations 权限、模板、角色、分配、变更申请和审计。
- 敏感角色不能通过直接分配、直接撤销或发布接口绕过双审。
- 角色发布、分配和撤销必须记录原因。

## 8. 首页

首页只使用真实可计算统计：客户、充值状态、待审批、账本/财务告警。数据不可用时显示不可用，不使用静态 KPI。

## 9. 验收

- SELF/直属/团队树/组织/平台范围分别通过数据库集成测试。
- 客户/充值列表和详情 PII 一致。
- 策略、资金和敏感授权都阻断自审、重复决定和状态竞态。
- 旧运营后台能力只有在迁移矩阵中有明确去向后才能删除。
