# Maintenance 付费 Beta 应用规格

## 1. 职责与导航

Maintenance 管理模型 Profile/Agent 绑定、Email、优盾充值通道配置、平台 Demo 账户、Worker 健康、紧急暂停、RBAC 和技术审计，不处理客户归属、会员付款、充值入账审批或 paper 分成业务决定。

核心路由：`/models`、`/integrations/sources`、`/integrations/email`、`/integrations/payments`、`/integrations/demo-exchanges`、`/health`、`/safety`、`/settings`、`/settings/disclosures`、`/releases`、`/access`、`/access/audit`、`/audit`。

## 2. 模型与 Agent

- Profile 读取/修改分权；版本、启用、最近测试、绑定依赖和回滚可追溯。
- 研发角色、七智能体产品角色、运行时解释角色分目录；确定性内核不伪装成 LLM。
- 保存后密钥不回显；读取者看不到修改/测试控件；测试要求原因/recent MFA/audit。
- 付费 AI 只允许可靠 usage 和已配置费率的 profile。

数据/新闻目录只提供代码固定的公共只读检查目标；浏览器不能传 endpoint。页面分离 configured/enabled/healthy/stale、最近检测时间、安全错误码和延迟，不返回完整 endpoint 或 Key。

## 3. Email 与支付

- Email 分别显示 domain、key、webhook、templates、suppression、retention、allowlist 和最近测试。任一未完成或未授权时为 `configured_not_sent`。
- Payment 只允许优盾 deposit-only：配置、支持币种连通测试和启停；回调验签服务不自动入账，Payment Worker 不运行。
- 页面只见 `hasSecret`、商户/节点/回调/币种映射是否配置和最近验证；不返回密钥、商户号、密文引用、完整私有 endpoint 或 raw webhook。

## 4. 平台 Demo 账户

- provider 为 OKX Demo、Binance Spot Testnet、Bybit Demo；环境/域名固定 allowlist。
- 展示 configured、enabled、permissionCheck、lastVerifiedAt、latestReceipt、dailyNotional、kill switch；不显示 secret。
- 权限检查拒绝提现、划转、杠杆、衍生品或生产域名。OKX header 不可由请求覆盖。
- 修改账户、测试和 kill switch 要 reason、recent MFA 和审计。
- `local-demo`/fixture 只能显示 fixture/not_sent，不能显示 connected 或真实测试成功。

## 5. Worker 与健康

每个 Worker 显示：configured、enabled、liveness、health、heartbeatAt、commitSha、lastSuccessAt、lastFailureAt、safe error code、currentJob、queueDepth/oldestAge。状态推导：disabled、unconfigured、missing、alive/healthy、degraded、stale；env 开关不能证明进程存活。

Database、Research、Paper Runtime、Demo Execution、Notification、Payment Worker 和优盾 Webhook 分别建模。Payment Worker 始终 disabled；优盾 Webhook 为独立最小权限服务。公开 live/ready 只粗粒度，详细诊断需要 `maint.system_health.view`。

## 6. 安全、RBAC 与审计

- Operations/Maintenance 显式 assignment，不回退 legacy；Access Center 只读取 Maintenance 数据。
- 紧急暂停按 scope/provider/card 生效，要求原因；解除不自动恢复策略。
- 系统审计包含登录/MFA、配置版本、Worker、provider 测试、kill switch、模型和授权事件；日志不含 secret/完整 PII/token。
- `/audit` 聚合 Demo、模型、集成、商业设置、版本发布、安全停控和身份/MFA allowlist 事件，支持 domain/action/status/cursor；失败检查由安全状态/错误码投影为 failed，不得显示成功；返回 actor/subject/reason/status/error/requestId/traceId/time，不读取 response payload、幂等键、hash、订单 ID 或密文。
- 授权数据仍由 audience 隔离的 `/access/audit` 提供；Worker 队列和 DB 状态属于 `/health` 实时诊断，不伪造成已发生的审计事件。
- 真实订单、支付、退款和生产基础设施没有 UI 或 API 可达路径。

## 7. 验收

- 停止 Worker 后 60 秒内 stale；configured/enabled/alive/healthy 不混淆。
- 密钥、完整 endpoint、webhook payload 和临时 token 在网络响应/页面/日志均为零。
- Demo 三 provider 的 fixture、未配置、失败和成功状态准确；paper 不受影响。
- Email 未完全就绪显示 configured_not_sent；优盾未完整配置/测试显示 disabled 或 incomplete；不会生成假成功。

## 8. 版本发布

- `/releases` 展示安全 runtime 身份、不可变候选版本、独立验证、staging/production current 和部署/回滚历史。
- `maint.releases.view/manage/approve` 分离读取、登记与复核；创建者不能复核自己的版本。
- production 成功记录要求同版本 staging 成功；failed 不切换 current，rollback 只能指向同环境历史成功版本。
- 页面只记录 CI/CD 或值班人员已执行操作的证据，不提供 SSH、迁移、切流、Git tag 或自动回滚按钮。
- Client/Operations 不含该路由、权限、菜单或数据库读路径；密钥、日志正文和访问令牌不进入记录。
# 优盾充值集成

`/integrations/payments` 只显示商户号/API Key/专属节点/回调/币种映射是否存在、最近测试和有效状态，不回显值。币种映射只能在 disabled 时修改，修改清除旧测试；启用要求运行时配置完整且最近测试通过。公网回调使用 `agentnovas_payment_webhook`，Maintenance Web 角色不读取客户钱包或账本。提现、代付和划转能力不得加入页面或 API。
