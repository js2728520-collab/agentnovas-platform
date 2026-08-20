# Maintenance 应用规格

## 1. 职责边界

Maintenance 管理技术配置、运行健康、安全控制和技术审计，不处理客户归属、业务收款、结算或策略上架审批。

## 2. 模型与 Agent

- 模型 Profile 的读取与修改权限分离。
- Profile 支持版本、启用状态、最近测试和回滚；保存后 API Key 不回显。
- 角色目录分为：策略研发角色、七智能体产品角色、可选运行时解释角色。三者不得共用含糊的同名列表。
- 七智能体并不要求七个模型持续运行；页面需要展示确定性内核、可选解释模型和依赖状态。
- 绑定测试必须输入原因并审计，只返回安全摘要。

目标权限：`maint.llm_profiles.view/manage`、`maint.agent_bindings.view/manage`。

## 3. 数据、邮件与支付集成

- 数据集成展示 provider、数据类型、启用态、最后成功/失败、延迟和数据质量；不显示私有完整端点或密钥。
- 邮件展示域名验证、API Key 是否存在、最近测试和结果；`configured_not_sent` 的文案固定为“已配置但未发送”。
- 支付展示 provider、渠道、网络、阈值、密钥状态和 sandbox/active/disabled；测试开关关闭时保留 503。
- 集成状态不得把 `configured` 等同于 `running`。

目标权限：`maint.data_integrations.view/manage`、`maint.email_integrations.manage`、`maint.payment_integrations.manage`。

## 4. Worker 与系统健康

每个组件至少显示：

- `configured`：必要配置是否齐全。
- `enabled`：业务开关是否开启。
- `heartbeatAt`：进程最近心跳。
- `lastSuccessAt` / `lastFailureAt`：最近结果。
- `queueDepth`：只对授权运维展示。
- `status`：由上述字段推导，不能只读取环境变量。

Database、Research Worker、Runtime Worker、Payment Worker、Notification Worker、Resend 和支付服务商分别建模。

## 5. 安全与紧急控制

- 紧急暂停按 RBAC scope 生效，填写原因并审计。
- 暂停默认阻断新开仓；解除后不自动恢复策略。
- 自动平仓只允许现有明确授权的 OKX Demo 路径，不能连接生产订单。
- 真实现货或永续紧急执行需要独立评审，不因页面存在而授权。

## 6. 平台设置

- 公开设置仅包含安全品牌、客服和公告字段。
- Telegram 客服链接必须 HTTPS 且域名在白名单。
- 私有配置和功能开关不通过公开设置 API 返回。

## 7. RBAC 与审计

- Access Center 只读取 Maintenance 的权限、模板、角色、分配、审批和审计。
- Operations 与 Maintenance 的授权数据不交叉读取。
- 系统审计聚合认证、配置、Worker、集成测试、紧急控制和模型版本事件；业务审批仍在 Operations 查看。

## 8. 验收

- 密钥、完整端点、Webhook payload 和密文引用不出现在网络响应与浏览器页面。
- Worker 关闭、未心跳、已配置未运行、测试未执行分别呈现。
- 模型读取者看不到编辑/测试控件；修改者的敏感操作有原因和审计。
- 任何真实外部调用在开关关闭时不会执行，也不会产生成功提示。
