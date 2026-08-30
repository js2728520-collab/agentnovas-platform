# Resend 邮件配置、轮换与投递闭环 Runbook

> 状态：`CURRENT`。适用于 AgentNovas/Riverton 测试站与生产环境。本文只处理事务邮件，不开放真实交易或资金出站。

## 1. 完成定义

邮件服务不是只读状态页，也不能以“容器运行”或“Resend 接受请求”冒充可用。完整闭环必须同时满足：

1. Resend 中的 `agentnovas.com` 发信域为 `verified`，发信地址为 `noreply@agentnovas.com`。
2. API Key 和 Webhook Secret 已通过独立 Secret Broker 安装；页面、Web 进程、PostgreSQL 和审计日志从不接触明文。
3. Secret Broker、Notification Worker 和 Maintenance Webhook 均使用最小权限身份，并有新鲜心跳。
4. 至少一个独立测试收件人完成“新增 → 验证码 → 验证 → 启用”；测试地址不绑定当前管理员账号。
5. 测试页明确显示本次收件地址、delivery ID、排队、发送及 Webhook 最终状态。
6. 只有收到并持久化 `email.delivered` 才能写“已送达”。HTTP 200/202 或 `email.sent` 都不是最终送达证据。

## 2. 环境边界

| 项目 | 测试站 | 生产环境 |
| --- | --- | --- |
| Maintenance | `main-test.agentnovas.com` | `xm.agentnovas.com` |
| Webhook | `https://main-test.agentnovas.com/api/integrations/resend/webhook` | `https://xm.agentnovas.com/api/integrations/resend/webhook` |
| Secret 根目录 | `/etc/agentnovas-riverton-preview` | `/etc/agentnovas-riverton` |
| 托管版本目录 | `<secret-root>/email-managed` | `<secret-root>/email-managed` |

每次操作先核对 Host、release、Compose project 和 secret 目录。测试站不得写入生产目录，也不得复用生产 Key。

## 3. 安全模型

| 数据 | 保存位置 | 明文可见范围 |
| --- | --- | --- |
| Resend API Key | Broker 原子生成的版本文件 | Secret Broker 写入，Notification Worker 只读 |
| Webhook Secret | Broker 原子生成的版本文件 | Secret Broker 写入，Maintenance Webhook 只读 |
| Broker RSA 私钥 | 宿主机受保护文件，只挂载给 Broker | Broker |
| Broker RSA 公钥 | 只读 Secret | Maintenance 后端可返回给已授权页面 |
| 浏览器提交 | AES-GCM 密文 + RSA-OAEP 包装密钥 | 浏览器产生密文；服务器/数据库只存密文 |
| 测试收件地址 | PostgreSQL 中 AES-GCM 密文和不可逆哈希 | Maintenance 授权视图、Notification Worker 发信时短暂解密 |
| 验证码 | 哈希及加密队列负载，有效期和尝试次数受限 | 邮件接收者；页面只提交验证码 |
| 投递记录 | PostgreSQL | 有权限的 Maintenance 用户；地址按权限投影 |

关键约束：

- API Key 和 Webhook Secret 必须同时提交，输入框永远为空，成功后立即清空，任何接口都不得回显。
- Secret Broker 没有 HTTP 入口和外网，只能访问数据库及托管 secret 目录。
- Broker 数据库角色只能领取/完成密钥请求并写专用心跳，不能读取客户、投递或其他配置。
- 托管 manifest 缺失时可以在一次性迁移阶段回退旧 env；manifest 一旦存在，格式、权限、校验和或读取错误必须失败关闭，不能悄悄使用旧 Key。
- 测试收件人必须先验证后启用；停用、删除、验证码重发、Key 轮换和 Provider 外发切换都需要 recent MFA、权限、幂等键和审计原因。

## 4. 一次性服务器引导

网页配置可用前，平台管理员需要执行一次 Broker 引导。它只创建 Broker 身份、RSA 密钥、测试收件人加密键、挂载路径和运行配置，不写入 Resend Key，也不发送邮件。

1. 应用 `0090`、`0091` 迁移。
2. 通过受控数据库流程创建 `agentnovas_email_secret_broker` 登录角色并应用 `deploy/postgres/least-privilege-roles.sql`。
3. 在仓库外创建 `0600` 答案文件，仅包含专用数据库 DSN：

```text
EMAIL_SECRET_BROKER_DATABASE_URL=postgresql://agentnovas_email_secret_broker:<password>@postgres:5432/agentnovas
```

4. 先检查，再应用：

```bash
sudo RIVERTON_SECRET_DIR=/etc/agentnovas-riverton-preview \
  bash /opt/agentnovas-riverton-preview/releases/<RELEASE>/source/scripts/install-email-secret-broker.sh \
  --check /root/agentnovas-config/email-secret-broker-test.answers

sudo RIVERTON_SECRET_DIR=/etc/agentnovas-riverton-preview \
  bash /opt/agentnovas-riverton-preview/releases/<RELEASE>/source/scripts/install-email-secret-broker.sh \
  --apply /root/agentnovas-config/email-secret-broker-test.answers
```

安全输出只应包含 `broker_bootstrap=valid`、`configuration_update=applied`、`provider_secrets=unchanged` 和 `service_restart=not_performed`，不得出现 DSN、Key、Webhook Secret 或测试邮箱。

在使用本机 Docker Compose 的环境里，文件型 secret 实际是 bind mount，Compose 会忽略长语法中的容器 `uid/gid/mode`。因此安装器在 root 模式下把 Broker env 与私钥保存为 `root:<runtime-gid> 0440`；它们只挂载给 Broker。不能把私钥改为 world-readable，也不能假设 YAML 中的 `uid/gid/mode` 已生效。

5. 使用完整 preview overlay 启动或重建受影响服务：

```bash
cd /opt/agentnovas-riverton-preview/releases/<RELEASE>
sudo docker compose --profile workers --profile email-secret-broker --env-file release.env \
  -f source/deploy/container/compose.yml \
  -f source/deploy/container/compose.preview.yml \
  up -d --no-deps --force-recreate maintenance notification-worker email-secret-broker
```

生产必须使用发布记录中的完整 Compose 文件集合，不能照搬测试路径。

## 5. Resend 后台准备

1. 确认 `agentnovas.com` 在 Resend 为 `verified`。
2. 创建仅限该域的 `Sending access` API Key，不使用 `Full access` Key。
3. 配置当前环境 Webhook；测试站必须指向 `main-test.agentnovas.com`，不能指向 Client、Operations 或生产 Host。
4. 订阅 `email.sent`、`email.delivery_delayed`、`email.delivered`、`email.opened`、`email.clicked`、`email.complained`、`email.bounced`、`email.failed`、`email.suppressed`。
5. 保留旧 Key，直到新版本完成真实投递闭环；新 Key 验收成功后再撤销旧 Key。

## 6. 在 Maintenance 页面配置

打开“外部集成 → 邮件”（`/integrations?tab=email`）。页面有“概况 / 配置 / 测试与记录”三个 Tab。

### 6.1 安装或轮换密钥

在“配置 → Provider 与密钥”中：

1. 核对发信地址和 Webhook URL。
2. 确认 Secret Broker 为在线；离线时输入仍不会提交。
3. 同时填写 `Resend API Key` 与 `Webhook Secret`。
4. 填写可审计的业务原因，点击“加密提交配置”或“加密提交轮换”。
5. 页面轮询最近请求，必须看到 `pending → applying → applied`；失败时保留稳定错误码，不显示秘密。
6. 确认两个输入框已经清空，状态显示已配置，并记录配置版本、更新时间和脱敏操作人。

页面提交的是浏览器加密 envelope。Maintenance API 不能解密；Broker 在独立进程中解密并原子写入两个版本文件，最后一次性替换 `manifest.json`。两个服务在下一轮刷新时读取同一版本。

### 6.2 新增独立测试收件人

在“配置 → 测试收件人”中：

1. 输入明确的测试邮箱、可辨识标签和新增原因。
2. 点击“新增并发送验证码”。这一步会真实发送一封验证码邮件，操作前必须取得本次外发授权。
3. 从目标邮箱取得六位验证码，在有效期内填写并验证。
4. 验证成功后状态变为“启用”；此后可以停用、重新启用或删除。
5. 被 suppression 的地址即使已验证也不能参与测试，必须先调查 bounce/complaint 原因，禁止直接绕过。

删除是生命周期状态变更，不擦除审计、投递和 Webhook 事实。验证码不得进入聊天、工单、截图或日志。

### 6.3 Provider 外发授权

只有域名、模板、suppression、密钥、Webhook、Worker 和测试收件人事实都满足时，才填写原因并启用 Provider 外发。关闭外发不会删除密钥，也不会把历史测试改写成成功。

## 7. 发送测试与查看反馈

在“测试与记录”Tab：

1. 下拉框只列出已验证、已启用、未 suppression 的地址，并显示完整的本次收件地址。
2. 明确选中一个地址并填写测试原因。
3. 点击一次“发送测试邮件”。这是真实外发，必须取得本次授权；不要通过重复点击制造第二封邮件。
4. 页面显示 delivery ID 和状态：
   - `queued`：已进入本地队列；
   - `sending` / `sent`：Worker 正在处理或 Resend 已接受；
   - `delivered`：已收到并持久化验签 Webhook；
   - `failed` / `bounced` / `complained` / `suppressed`：终态失败，显示稳定错误码。
5. 页面持续轮询当前 delivery，显示排队时间、发送时间、Webhook 事件与时间、受限 Provider ID。只有 `delivered` 是闭环完成。

不发信的界面验收使用 `scripts/quality/run-email-service-management-acceptance.mjs`。真实闭环仅在 `ALLOW_REAL_EMAIL_DELIVERY_TEST=1` 和用户对本次发送明确授权后运行 `scripts/quality/run-email-service-delivery-closure.mjs`。

## 8. 配置审计

```bash
sudo RIVERTON_SECRET_DIR=/etc/agentnovas-riverton-preview \
  RIVERTON_EMAIL_SECRET_DIR=/etc/agentnovas-riverton-preview/email-managed \
  bash /opt/agentnovas-riverton-preview/releases/<RELEASE>/source/scripts/audit-production-config.sh
```

网页可写控制面准备完成后，至少应看到：

```text
core_configuration=ready
email_secret_broker_configuration=ready
resend_configuration=ready
```

`email_secret_broker_configuration=ready` 证明 Broker 文件、专用角色配置和共享测试地址加密键结构完整；`resend_configuration=ready` 证明当前托管 manifest 与两个版本文件通过结构及 SHA-256 校验。它们仍不能代替 Worker 心跳、Provider readiness 或真实 `email.delivered`。

配置审计不得打印 secret、数据库 URL、完整邮箱、manifest 内容或版本文件内容。托管文件被篡改时审计必须失败，运行时也必须失败关闭。

## 9. 数据库和运行时检查

- `agentnovas_maintenance`：可管理 recipient 和创建密文请求，但不能解密 envelope、读取 Broker 私钥或写托管目录。
- `agentnovas_notification_worker`：只读取可用测试地址并处理受限队列，不能管理测试地址。
- `agentnovas_email_secret_broker`：只能领取/完成 secret request 和写专用心跳。
- Maintenance 状态页从 Notification Worker 心跳读取 `apiKeyPresent`，不能用 Maintenance 自己的环境变量冒充 Worker 已加载 Key。

应用迁移和权限真源后运行角色策略检查，`findings` 必须为空。发送开关打开前检查已有 `queued` 邮件；Worker 会立即领取旧队列，禁止为了清队列扩大 allowlist。

## 10. 常见故障

| 现象 | 常见根因 | 处理 |
| --- | --- | --- |
| 页面仍显示 Broker 离线 | 引导未执行、服务未启动、专用角色权限错误或心跳超过 60 秒 | 检查 Broker 容器、专用心跳和 `0091`，不要把私钥复制给 Web |
| 密钥请求一直 pending | Broker 未运行或不能领取请求 | 检查 Broker 专用 DSN、最小权限和私钥挂载 |
| 密钥请求 failed | envelope、公钥版本、托管目录权限或原子写入失败 | 根据稳定错误码修复；不要输出请求密文或 secret |
| manifest 存在但 Worker 启动失败 | 校验和、格式、权限或版本不一致 | 视为安全阻断；恢复上一份完整 manifest/版本，不允许回退旧 env |
| 新增地址后没有验证码 | 外发未授权、Worker/Key 未就绪或地址被 suppression | 查看该验证码 delivery 的稳定错误码；不要盲目重发 |
| 验证码无效 | 过期、尝试次数耗尽或填写错误 | 按权限重发一次新码，旧码立即失效 |
| 测试按钮不可用 | 没有 active 收件人、Provider/Worker Gate 未通过或原因不足 3 字 | 回到“配置”读取具体状态，不绑定管理员账号绕过 |
| Resend accepted 但没有 delivered | Webhook Host、订阅、secret、验签或入库异常 | 对齐同一 delivery/provider ID 调查，状态保持 sent |
| `RECIPIENT_NOT_ALLOWLISTED` | 目标不是已启用测试地址或普通环境 allowlist 成员 | 保持拒绝；修正目标，不扩大授权 |
| env 文件存在但容器 `EACCES` | 原子替换丢失 runtime UID/GID | 恢复 owner/group/mode，修复安装流程后只重建受影响服务 |
| 重启后连接了错误数据库 | release、Compose project 或 preview overlay 错误 | 立即停止并按发布记录恢复完整 Compose 文件集合 |

## 11. 关闭、轮换与回滚

发生错误收件人、complaint、bounce 激增、Webhook 失效、Worker stale、Key 泄露或无法解释的队列消费时：

1. 在页面关闭 Provider 外发；若页面不可用，再通过受控 secret 配置把发送开关关闭并只重建 Notification Worker。
2. 保留投递、Webhook、审计和失败证据，不删除记录掩盖问题。
3. 泄露时创建新的 domain-scoped Key 与 Webhook Secret，在页面成对提交轮换。
4. 新版本应用后验证 Worker/Webhook 均加载新版本，再执行一次获授权真实闭环。
5. 验收成功后在 Resend 撤销旧 Key；已泄露 Key 永不恢复。
6. 若新版本损坏，通过受控服务器流程把 `manifest.json` 原子恢复到上一份完整版本；不要编辑版本文件或让服务静默使用 env。

## 12. 交付证据

只记录非秘密事实：环境、release、镜像/commit、域名验证、Key 权限类型、Webhook Host 和事件集合、文件 UID/GID/mode、审计状态、角色策略 findings、Broker/Worker 心跳、配置版本与脱敏操作人、测试 recipient ID/标签/状态、delivery/provider ID、`sent` 与 `delivered` 时间、旧 Key 撤销状态。

严禁记录 API Key、Webhook Secret、Broker 私钥、数据库 URL、加密键、验证码、完整测试邮箱、密文 envelope、原始 Webhook payload 或客户 PII。
