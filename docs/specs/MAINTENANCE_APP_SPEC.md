# Maintenance 付费 Beta 应用规格

## 1. 职责与导航

Maintenance 管理模型 Profile/Agent 绑定、Email、支付禁用态、平台 Demo 账户、Worker 健康、紧急暂停、RBAC 和技术审计，不处理客户归属、会员付款或 paper 分成业务决定。

核心路由：`/models`、`/integrations/email`、`/integrations/payments`、`/integrations/demo-exchanges`、`/health`、`/safety`、`/access`、`/access/audit`、`/audit`。

## 2. 模型与 Agent

- Profile 读取/修改分权；版本、启用、最近测试、绑定依赖和回滚可追溯。
- 研发角色、七智能体产品角色、运行时解释角色分目录；确定性内核不伪装成 LLM。
- 保存后密钥不回显；读取者看不到修改/测试控件；测试要求原因/recent MFA/audit。
- 付费 AI 只允许可靠 usage 和已配置费率的 profile。

## 3. Email 与支付

- Email 分别显示 domain、key、webhook、templates、suppression、retention、allowlist 和最近测试。任一未完成或未授权时为 `configured_not_sent`。
- Payment 永远为 disabled；Beta 不提供连接测试成功、Webhook 入账或 Payment Worker 业务运行。
- 页面只见 `hasSecret`、provider、安全 environment 和最近验证；不返回密钥、密文引用、完整私有 endpoint 或 raw webhook。

## 4. 平台 Demo 账户

- provider 为 OKX Demo、Binance Spot Testnet、Bybit Demo；环境/域名固定 allowlist。
- 展示 configured、enabled、permissionCheck、lastVerifiedAt、latestReceipt、dailyNotional、kill switch；不显示 secret。
- 权限检查拒绝提现、划转、杠杆、衍生品或生产域名。OKX header 不可由请求覆盖。
- 修改账户、测试和 kill switch 要 reason、recent MFA 和审计。
- `local-demo`/fixture 只能显示 fixture/not_sent，不能显示 connected 或真实测试成功。

## 5. Worker 与健康

每个 Worker 显示：configured、enabled、liveness、health、heartbeatAt、commitSha、lastSuccessAt、lastFailureAt、safe error code、currentJob、queueDepth/oldestAge。状态推导：disabled、unconfigured、missing、alive/healthy、degraded、stale；env 开关不能证明进程存活。

Database、Research、Paper Runtime、Demo Execution、Notification 和 Payment 分别建模。Payment 始终 disabled。公开 live/ready 只粗粒度，详细诊断需要 `maint.system_health.view`。

## 6. 安全、RBAC 与审计

- Operations/Maintenance 显式 assignment，不回退 legacy；Access Center 只读取 Maintenance 数据。
- 紧急暂停按 scope/provider/card 生效，要求原因；解除不自动恢复策略。
- 系统审计包含登录/MFA、配置版本、Worker、provider 测试、kill switch、模型和授权事件；日志不含 secret/完整 PII/token。
- 真实订单、支付、退款和生产基础设施没有 UI 或 API 可达路径。

## 7. 验收

- 停止 Worker 后 60 秒内 stale；configured/enabled/alive/healthy 不混淆。
- 密钥、完整 endpoint、webhook payload 和临时 token 在网络响应/页面/日志均为零。
- Demo 三 provider 的 fixture、未配置、失败和成功状态准确；paper 不受影响。
- Email 未完全就绪显示 configured_not_sent；Payment 一直 disabled；不会生成假成功。
