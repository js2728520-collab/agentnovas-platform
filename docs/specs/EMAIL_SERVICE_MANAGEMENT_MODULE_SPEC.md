# 邮件服务管理模块规格

状态：`CURRENT`
日期：2026-08-29
上位真源：`../product/PRD.md`、`V3_MAINTENANCE_APP_TARGET_SPEC.md`、`../adr/0005-riverton-three-app-rbac-wallet.md`

## 1. 目标

把 Maintenance 当前分散的邮件状态、受控配置、测试和投递证据收敛为一个可复用模块，解决以下已确认缺口：

1. 页面只有状态和“发送测试邮件”，没有可操作的配置入口。
2. 测试前看不到收件人，提交后只显示“已入队”，看不到错误、供应商事件或最终状态。
3. 静态 Gate 与最近一次失败互相矛盾，`ready` 会与 `failed` 同时出现。
4. 页面组件直接绑定 AgentNovas API 和文案，无法在其他项目复用。

模块交付后，操作者可以在一个工作区内完成“概况 → 配置 → 测试与记录”的闭环；任何页面文案都不得把排队、供应商接受或发送等同于最终送达。

## 2. 安全边界

- `RESEND_API_KEY` 明文只对 Notification Worker 可读；`RESEND_WEBHOOK_SECRET` 明文只对 Maintenance Web 可读。两者的安装/轮换只由独立 Email Secret Broker 执行。
- 浏览器使用 Broker 公钥加密，Maintenance API 和 PostgreSQL 只接收密文 envelope；任何响应、日志、审计和错误都不得回显秘密或密文。
- Broker 私钥不进入 Web、Notification Worker、数据库或 Git；Broker 只能写专用邮件密钥目录，不能读取其他服务密钥。
- 测试收件地址与账号解耦，使用专用 AES-GCM 密钥加密保存；摘要用于唯一性与 suppression，掩码用于列表。该密钥不得复用交易或通用集成密钥。
- 只有已验证、启用且未被 suppression 命中的收件人可用于 `maintenance_email_test`。验证码模板只可投递到对应 pending 记录。普通客户邮件仍受既有 Worker环境 allowlist 约束。
- 配置与测试写操作要求 `maint.email_integrations.manage`、recent MFA 策略、幂等键、3–500 字审计原因和同源策略。
- 响应不得返回 API Key、Webhook Secret、原始 Webhook payload、普通客户邮箱或其他管理员的完整邮箱。

## 3. 模块边界

### 3.1 纯合同与投影

`packages/notifications/src/email-service-management.ts` 只包含无 I/O 的类型、状态投影、错误说明、邮箱掩码和严格输入归一化。它不得依赖 Next.js、PostgreSQL 或 AgentNovas Session。

有效状态固定为：

- `unconfigured`：API Key、Webhook 或必要验证事实缺失。
- `disabled`：配置存在但数据库外发授权关闭，或 Worker 环境开关关闭。
- `ready`：所有 Gate 就绪，且没有比最近成功投递更新的失败测试。
- `degraded`：静态 Gate 就绪，但最近测试失败或 Worker 心跳异常。

测试状态固定为 `queued/sent/delivered/failed`。错误码由共享投影映射为可操作说明，未知错误仍显示原始受限错误码，不能静默吞掉。

### 3.2 服务端适配器

`lib/email-service-management.ts` 负责 PostgreSQL 查询、事务、授权事实和安全响应投影。Route Handler 只做鉴权、受限 body/query 读取和响应映射。

### 3.3 可复用 UI

`packages/ui/src/email-service-manager/` 接收数据和回调 props，不写死 API URL、Session 或 Provider 密钥。AgentNovas 的 `apps/maintenance/ui/email-integration-workspace.tsx` 仅作为容器，负责拉取、提交、轮询和本地化。

## 4. 数据合同

`notification_email_test_recipients` 扩展为：

- `id`：稳定资源 ID；`recipient_hash` 保持唯一。
- `recipient_ciphertext`：专用 AES-GCM 密文；`recipient_mask`：安全列表掩码。
- `label`：操作者可识别名称。
- `status`：`pending_verification/active/disabled/deleted`。
- `verification_code_hash/expires_at/attempts/sent_at/verified_at`：验证码生命周期；明文验证码不落库。
- `created_by_user_id/updated_by_user_id`。
- `reason`：最近一次授权变更原因。
- `created_at/updated_at/deleted_at`。

新增 `notification_email_secret_requests`：保存浏览器加密 envelope、key id、操作类型、状态、受限错误码、配置指纹、actor 与时间；不保存 Provider 密钥明文。Broker 只能 claim/complete，Maintenance 只能 create/read。

`notification_deliveries` 新增可空 `test_recipient_id`。测试和验证码投递使用该外键；历史不得通过 `users.email` 推断收件人。

测试记录继续以 `notification_deliveries` 为真源，`resend_webhook_events` 为供应商事件证据。安全响应包含：

- 本地 delivery ID、状态、排队/发送/供应商事件时间。
- 当前操作者自己的完整测试邮箱；其他操作者只返回掩码。
- Provider message ID 的安全短标识，不返回原始 Webhook payload。
- `lastErrorCode/providerEventType` 和可读说明。

## 5. API 合同

| 方法与路径 | 权限 | 行为 |
|---|---|---|
| `GET /api/maintenance/email/status` | health view 或 email manage | 返回概况、Gate、Sender/Webhook 元数据、Broker 公钥状态、最近配置和测试摘要 |
| `GET /api/maintenance/email/tests` | `maint.email_integrations.manage` | 返回最近 20 条测试及供应商事件时间线 |
| `POST /api/maintenance/email/test` | `maint.email_integrations.manage` | 接受明确 `recipientId`，校验 verified/active/suppression，再幂等写入 outbox |
| `PATCH /api/maintenance/email/configuration` | `maint.email_integrations.manage` | 只管理 Provider 外发授权 `activate/disable` |
| `GET/POST /api/maintenance/email/recipients` | `maint.email_integrations.manage` | 列表或新增独立收件人；新增后排队验证码 |
| `POST /api/maintenance/email/recipients/:id/verification` | `maint.email_integrations.manage` | 重发验证码或校验一次性验证码 |
| `PATCH/DELETE /api/maintenance/email/recipients/:id` | `maint.email_integrations.manage` | 启用、禁用或软删除已验证地址 |
| `GET/POST /api/maintenance/email/secrets` | `maint.email_integrations.manage` | 返回 Broker 公钥和请求元数据；创建只写密文安装/轮换请求 |

`activate` 必须重新校验 Provider 验证事实、API Key 非秘密存在证据、Webhook Secret 存在、Worker 心跳和环境外发开关；任一不满足则失败关闭。`disable` 只关闭数据库授权，不改主机环境开关。

## 6. 页面行为

- “概况”展示唯一综合状态；最近失败时显示错误说明，不再同时显示 `ready` 与 `failed`。
- “配置”必须提供两个可操作区：`Provider 与密钥`、`测试收件人`。API Key/Webhook 表单永不预填、提交后立即清空，并标注只写和待 Broker 应用状态。
- 密钥区显示 Sender、Webhook URL、API Key/Webhook 状态、Broker 心跳、最近请求状态、更新时间和操作者；不显示任何密钥、密文或完整指纹。
- 收件人区支持新增、重发验证码、输入验证码、启用、禁用和删除；列表明确状态、掩码、标签、验证/更新时间和操作者。
- “测试与记录”使用选择控件选择已验证收件人；提交前明确显示目标，未选择或目标不可用时按钮禁用。
- 提交成功后立即显示 delivery ID、收件人和“已排队”；每两秒轮询，直到 `delivered/failed` 或 30 秒超时。超时只表示仍在处理。
- 历史按新到旧展示排队、发送、Webhook 事件和错误。所有异步反馈使用 `aria-live`，Tab 可键盘操作。
- 320/768/1024/1440px 不横向溢出；移动端卡片单列，表格改为记录卡。

## 7. 验收

1. 纯函数：状态优先级、未知错误、邮箱掩码、非法 action/reason。
2. PostgreSQL：迁移 fresh/rerun、密文与摘要约束、验证码并发/过期/尝试次数、软删除、最小权限、Broker claim fencing。
3. API：Host、权限、recent MFA、same-origin、幂等冲突、严格字段、Broker key id、秘密/密文零回显。
4. Worker：动态密钥读取、版本完整性、数据库收件人解密、验证码与测试模板隔离、禁用/删除后失败关闭。
5. Browser：公钥加密、表单清空、收件人全生命周期、明确选择、queued → delivered/failed、刷新恢复、键盘和四档响应式。
6. 远端：`an-saas` 运行测试、TypeScript、lint、Maintenance production build；只部署 `main-test.agentnovas.com`，不改生产。

## 8. 当前测试站证据

- `main-test.agentnovas.com` 已部署 `preview-email-mgmt-v2-20260829-1`。仅 Maintenance、Notification Worker 和新增 Email Secret Broker 被重建；Client 与 Operations 未修改，production 未接触。
- 数据库变更前创建 0600 custom dump；`0091_email_service_management_v2.sql` 已应用，重放为 skipped。最终数据库角色策略为 `findings: []`。
- Secret Broker 使用独立登录角色、私钥和专用心跳；最终状态为 `running`、无错误码。配置审计为 `core_configuration=ready`、`email_secret_broker_configuration=ready`、`resend_configuration=ready`。
- Node 22.21.1 远端 TypeScript、完整 ESLint 和 128 项相关回归通过：126 passed、0 failed、2 项主机能力测试按设计跳过；安装器的 OpenSSL 主机测试另行通过。Maintenance production build 与 Runtime image build 通过。
- 隔离 Playwright 1.62.1 验收覆盖三个模块 Tab、两个空的只写 secret 字段、正确公网 Webhook URL、独立收件人选择、投递历史、键盘、axe、配置页 320/1440px 和测试页 320/768/1024/1440px。严重无障碍问题、应用外部请求、console、page error 和失败响应均为 0；Cloudflare 注入产生的 3 条 SRI 告警单独计数。
- 浏览器报告 `realEmailSent=false`。本轮没有点击“新增并发送验证码”或“发送测试邮件”；历史中的 delivered/sent/failed 记录只作为既有事实展示，不代表本次新投递。
- 浏览器验收使用的一次性低权限账号、角色、assignment、Session 和 active recipient 已撤销，临时凭据已删除；数据库只保留 deleted recipient、生命周期审计和历史投递事实。
