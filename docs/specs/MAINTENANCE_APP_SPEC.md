# Maintenance 付费 Beta 应用规格

> 文档状态：`CURRENT_BASELINE`。V3 Maintenance 目标见 [`V3_MAINTENANCE_APP_TARGET_SPEC.md`](V3_MAINTENANCE_APP_TARGET_SPEC.md)；当前“只登记发布证据”在 CI/CD 控制面 Gate 完成前继续有效。

## 1. 职责与导航

Maintenance 管理模型 Profile/Agent 绑定、AI 用量安全聚合、Email、优盾充值通道配置、平台 Demo 账户、Worker 健康、紧急暂停、RBAC 和技术审计，不处理客户归属、会员付款、充值入账审批或 paper 分成业务决定。

核心路由：`/models`、`/ai-usage`、`/work-records`、`/integrations/sources`、`/integrations/email`、`/integrations/payments`、`/integrations/demo-exchanges`、`/health`、`/safety`、`/settings`、`/settings/disclosures`、`/releases`、`/access`、`/access/audit`、`/audit`。

## 2. 模型与 Agent

- Profile 读取/修改分权；版本、启用、最近测试、绑定依赖和回滚可追溯。
- 研发角色、七智能体产品角色、运行时解释角色分目录；确定性内核不伪装成 LLM。
- 保存后密钥不回显；读取者看不到修改/测试控件；测试要求原因/audit，正式生产 MFA 开关开启后同时要求 recent MFA。
- 付费 AI 只允许可靠 usage 和已配置费率的 profile。

数据/新闻目录只提供代码固定的公共只读检查目标；浏览器不能传 endpoint。页面分离 configured/enabled/healthy/stale、最近检测时间、安全错误码和延迟，不返回完整 endpoint 或 Key。

### 2.1 AI 用量安全聚合

- `/ai-usage` 通过 `maint.ai_usage.view` 读取专用安全投影，不读取 Client AI 原始内容、错误原文、provider request ID、原始用户 ID、邮箱、手机号或模型凭证；响应禁止缓存。
- 日期按 `client_ai_inference_requests.created_at` 的 UTC 请求创建 cohort，默认 30 天、最多 90 天；组织使用请求级归属快照并显示 legacy 证据质量，用户只显示稳定伪名，模型固定到请求 revision。
- 可信 Token 只累计成功请求，Credits 只累计真实 settled 数值；“已记录非取消失败率”排除 preflight 拒绝、用户取消和处理中请求，不等同系统或 provider 可用率。
- 日期在页面内单击应用，不增加确认弹窗。当前 MFA Gate 默认关闭；正式生产重新开启后仍按敏感权限策略要求 recent MFA。
- 固定对话 Credits 数值和模型/功能价格分档等待 P-08，当前页面不得宣称固定费用规则已经完成。

### 2.2 工作记录受控导出

- `/work-records` 只对 `maint.work_records.export` 展示，正式生产重新开启 MFA 后要求 recent MFA。
- Web 数据库角色只读 `maintenance_strategy_work_records_safe` security-barrier 视图，不读取客户工作记录原表；用户与记录均使用稳定伪名。
- UTC 日期最多 31 天、每次最多 1,000 条，达到上限必须明示截断；请求严格限制为 from/to/reason，同源、8 KiB、持久化幂等。
- 原因常驻页面且不增加确认弹窗；审计只记录范围、条数、截断、查询摘要和原因，不保存导出正文。
- JSON 不含原始用户/部署/决策轮 ID、PII、证据 payload、模型/provider、错误原文或凭证；服务端不向文件系统或对象存储落导出文件，脱敏响应仅保存在不可变幂等终态记录中以支持安全重放。

## 3. Email 与支付

- Email 分别显示 domain、key、webhook、templates、suppression、retention、allowlist 和最近测试。任一未完成或未授权时为 `configured_not_sent`。
- Payment 只允许优盾 deposit-only：配置、支持币种连通测试和启停；回调验签服务不自动入账，Payment Worker 不运行。
- 页面只见 `hasSecret`、商户/节点/回调/币种映射是否配置和最近验证；不返回密钥、商户号、密文引用、完整私有 endpoint 或 raw webhook。

## 4. 平台 Demo 账户

- provider 为 OKX Demo、Binance Spot Testnet、Bybit Demo；环境/域名固定 allowlist。
- 展示 configured、enabled、permissionCheck、lastVerifiedAt、latestReceipt、dailyNotional、kill switch；不显示 secret。
- 权限检查拒绝提现、划转、杠杆、衍生品或生产域名。OKX header 不可由请求覆盖。
- 修改账户、测试和 kill switch 要 reason 和审计；正式生产 MFA 开关开启后同时要求 recent MFA。
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
