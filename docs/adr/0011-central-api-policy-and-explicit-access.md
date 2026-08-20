# ADR-0011: 所有 API 使用中央策略和显式授权

状态：Accepted  
日期：2026-08-20

## 决策

每个 method/path 注册 audience、auth、MFA、permissions、scope resolver、PII、sensitivity、idempotency、rate limit 与 body limit；`withApiPolicy` 默认拒绝未登记 handler。Operations/Maintenance 必须有显式 published assignment，revoke tombstone 禁止恢复 legacy 权限。assignment-bound scope 完整保留 organization set、team 和 direct reports。

## 原因

页面菜单不是安全边界；仅检查 session/legacy role 会造成跨 audience 与撤权回退风险。机器可读 inventory 可以让 CI 证明零遗漏，并使列表、详情、计数、导出和审批目标共享同一权限模型。

## 结果

统一 requestId/error/Origin-CSRF/recent-MFA/idempotency 行为。迁移期 legacy fallback 只允许 observe，Beta 前内部 audience 为 disabled。

