# ADR-0025：邮件管理闭环与密钥托管边界

状态：Accepted
日期：2026-08-29

## 背景

Maintenance 邮件页已经能读取 Resend、Worker 与投递状态，也能写入测试 outbox，但没有配置入口；测试收件人由当前 Session 隐式决定，页面不展示收件人、错误码或 Webhook 时间线。最近一次测试失败时，静态 Gate 仍可能显示 `ready`。

把 API Key 或 Webhook Secret 直接交给浏览器虽然能快速做出“配置表单”，但会违反 ADR-0005 的进程密钥隔离，并让公网 Web 进程获得 Notification Worker 的外发能力。

## 决策

1. 邮件管理拆为无 I/O 合同、服务端适配器和可复用 UI 三层；UI 不绑定 AgentNovas API。
2. API Key 继续只属于 Notification Worker，Webhook Secret 继续只属于 Maintenance Web；数据库与浏览器都不保存、回显或导出密钥。
3. Maintenance 在线管理非秘密控制面：Provider 数据库授权、当前操作者自己的测试收件地址授权、测试与投递证据。
4. 测试地址只保存规范化邮箱 SHA-256；数据库授权只适用于 `maintenance_email_test`，不得扩展普通客户邮件的外发范围。
5. 测试前显示明确收件人；提交后显示本地 delivery、错误和 Resend Webhook 事件。`queued`、`sent` 和 `delivered` 保持不同语义。
6. 综合状态纳入最近测试与 Worker 新鲜度；静态配置完备但最新测试失败时为 `degraded`，不得显示 `ready`。
7. 密钥安装和轮换继续通过受保护的服务器配置流程完成；页面提供状态与 Runbook 指引，不提供明文输入框。

## 后果

- 操作者能在一个模块内解释“发给谁、走到哪一步、为什么失败”，并安全管理受控测试和外发授权。
- 其他项目可以复用合同和 UI，只需提供自己的 API adapter。
- Web 页面不能单独完成首次密钥安装；这是有意保留的权限边界，不应以“功能不完整”为由把 Worker 密钥迁入 Web 或数据库。
- 若未来引入独立 Secret Broker，需要新增 ADR、独立进程身份、只写接口、轮换和回滚 Gate；不得在本模块中静默扩大边界。
