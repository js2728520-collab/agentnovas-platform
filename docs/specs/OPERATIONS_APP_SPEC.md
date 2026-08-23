# Operations 付费 Beta 应用规格

> 文档状态：`CURRENT_BASELINE`。当前组织页面与一次性邀请将按 [`V3_OPERATIONS_APP_TARGET_SPEC.md`](V3_OPERATIONS_APP_TARGET_SPEC.md) 迁移为“不展示组织架构 + 权限链接自助注册”；迁移完成前不得把目标写成当前事实。

## 1. 职责与导航

Operations 处理邀请/客户、组织、会员付款、credits 调整、paper 周分成、业务审批、充值历史、只读账本、财务与 RBAC。模型密钥、Worker 和技术开关属于 Maintenance；Operations 不执行真实支付或交易。

核心路由：`/customers`、`/organization`、`/membership-orders`、`/credits`、`/performance-statements`、`/deposits`、`/ledger`、`/finance`、`/approvals`、`/access`、`/access/audit`。

优盾成功回调只进入 `MANUAL_REVIEW`。maker 提交 `APPROVE_CREDIT` 原因，checker 不得自审；批准时订单状态、平衡账本、钱包版本、审计和通知在同一事务提交并返回 `fundsExecuted=true`。其他人工操作批准仍只表示相应决定，不得统一写成资金已执行。

## 2. 权限与 data scope

权限分 view/manage/request/approve/pii_reveal；会员、credits、分成和付款分别具有 maker/checker 权限。所有查询使用 assignment-bound SELF/DIRECT_REPORTS/TEAM_TREE/ORGANIZATION/ORGANIZATION_SET/PLATFORM，列表、详情、计数和导出一致。申请人不返回 decision action；服务端再次阻断自审。

## 3. 客户与邀请

- 客户列表/详情服务端 pagination、URL 筛选和 PII 脱敏。
- 备注、冻结/恢复、归属和组织关系分别授权、版本化、写原因与审计。
- 内部/客户邀请只产生一次性 set-password link；响应、通知和组织树不显示临时密码。
- 冻结/撤权/密码重置撤销 session；关系修改检查环、跨组织和 assignment scope。

## 4. 会员订单

1. 查看客户创建的订单和计划快照。
2. maker 记录脱敏外部付款凭证、金额、币种、时间、reference hash 和原因。
3. maker 提交；不同 checker 批准/拒绝。
4. 批准事务幂等激活/续期 entitlement、发放 credits、写账本/events/outbox/audit。
5. UI 回执区分“审批已记录”“会员已激活”；绝不称自动收款成功。

重复凭证、幂等键、并发决定、stale order version 和自审返回可理解的 409/403，不产生部分副作用。

## 5. Credits 调整

余额、预留和不可变流水只读。调整需要 maker reason、客户/数额/方向/来源和 checker；不得为负。批准事务写 credit ledger、account version、商业账本和审计。AI usage 自动结算不允许人工伪造 provider usage。

## 6. 周 paper 盈利分成

- maker 对上一完整 UTC 周幂等生成；一个客户三卡合并。
- 页面显示已平仓 paper 净收益、模拟手续费、高水位前后、亏损结转、费率 snapshot、计费基数和应收。
- 业务 checker 批准只生成应收，不标 paid、不更新高水位。
- 另一组 maker 记录外部付款凭证，不同 checker 复核后才标 paid 并提交高水位。
- 有已审批未支付账单时阻断重叠生成；争议记录不改原始 statement 计算。
- 文案始终为“paper 模拟净收益分成”，不称真实投资收益。

## 7. 充值、账本与财务

- Beta 关闭充值创建；旧订单仅查询/脱敏/人工申请，审批不声称链上/账本已执行。
- 账本只读，分录不可编辑/删除，修正用 reversal；交易只返回 scope 内安全 posting，不泄露其他客户 counterparty。
- 真实付款/收款始终是人工凭证与复核。旧通用审批逐步替换为 typed adapter 和同事务 side effect。

## 8. 首页、旧后台与真实状态

首页只显示可查询的邀请、会员订单、credits、分成、审批和 Worker 依赖摘要；失败时显示 unavailable。旧策略市场、自动结算、团队经营分析未达到合同前隐藏菜单并进入 GA backlog，不以静态 KPI 冒充已迁移。

## 9. 验收

- maker/checker 四类流完整；自审、重复、并发、stale、跨 scope 全阻断。
- 订单批准准确发放一次 entitlement/credits；分成付款准确提交一次高水位。
- PII 列表/详情一致；临时密码、完整凭证、其他客户 posting 不进入响应。
- 审批成功后队列与详情准确刷新，操作回执不夸大外部资金状态。
