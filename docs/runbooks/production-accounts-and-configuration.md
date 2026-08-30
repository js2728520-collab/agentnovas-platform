# 生产三端账号与外部配置运行手册

> 适用状态：`CURRENT_BASELINE`。本手册只配置当前已实现服务；V3 新 provider、客户实盘、资金出站和 CI/CD 凭证不得提前加入现有生产 env。

状态：`CURRENT`（账号创建与配置工具已实现；外部 Provider 仍按真实凭证和验收结果启用）

适用环境：`an-saas` 自托管生产目标、三端容器部署、PostgreSQL 单库多角色。

本文解决两个问题：安全创建 Client、Operations、Maintenance 三个独立验收账号；用不泄密、可重复的方式补齐 Resend、优盾、模型和 Demo 配置。任何“已配置”都不等于“已启用”或“已成功发送/执行”。

## 0. MFA 分阶段策略（下一版本）

本分支尚未部署。下一版本按 ADR-0023 在三端 env 中设置 `MFA_ENFORCEMENT_ENABLED=false`：
TOTP/recovery 数据、加密密钥和 API 保留，但准备阶段登录不强制挑战。下文 beta.5 的“首次
现场绑定”记录是历史生产验收事实，不代表本分支当前策略。

正式投入生产时必须在一次受控发布中将 Client、Operations、Maintenance 三份 env 同时改为
`true`，重启三端，并验证首次绑定、已绑定账号登录、恢复码、recent MFA、密码重置和回滚。
不得只开启一个 audience。回滚时三端同时改回 `false`，不删除 MFA 凭证或恢复码。

## 1. 当前生产配置快照

2026-08-22 `v1.0.0-beta.5` 的只读审计结果如下。审计只读取“是否存在/是否一致”，没有输出任何值：

| 配置域 | 当前状态 | 还缺什么 |
| --- | --- | --- |
| 三端 PostgreSQL、Cookie、MFA/通知/模型/集成加密主密钥 | 已配置，跨进程共享值一致 | 定期轮换与恢复演练 |
| Client/Operations/Maintenance Web | 已部署并健康；三端验收账号已创建，登录与 audience/RBAC 边界已通过 | Operations/Maintenance 首次现场绑定 TOTP；需要双审的业务使用独立 checker |
| Notification Worker | 运行中 | 外部 Email send 仍关闭 |
| Resend | 运行时未完整配置 | 新的 domain-scoped Sending Key、Webhook Secret、最小收件人 allowlist、readiness 证据 |
| 优盾 | 运行时未配置、数据库 disabled | 专属 HTTPS 节点、商户号、API Key、当前商户币种编号、staging 小额验收 |
| LLM Profile / Agent 绑定 | 数据库当前为空 | 模型 Provider、端点、Key、7 个 Research + 3 个 Runtime 解释绑定 |
| OKX/Binance/Bybit Demo 账户 | 数据库当前为空 | 三套只允许测试环境/现货的凭证和独立验证 |
| Strategy Runtime / Demo Worker | 关闭 | 配置完成后按 Gate 单独启用；外部写开关继续独立控制 |
| Payment Worker | 未部署且关闭 | 本项目充值由 Web + 回调 + Ops 双审处理，不安装提现/代付 Worker |

使用仓库内审计器复核：

```bash
sudo bash /opt/agentnovas-riverton/current/source/scripts/audit-production-config.sh
```

输出只有 `ready/incomplete/enabled/disabled` 和安全 finding，不显示数据库 URL、密钥、allowlist 或商户信息。退出码非零表示核心配置或硬关闭开关不符合要求。

当前生产实际输出为：

```text
core_configuration=ready
resend_configuration=incomplete
udun_configuration=incomplete
notification_email_send=disabled
```

## 2. 三端验收账号

### 2.1 固定账号模型

| Audience | 建议登录邮箱 | 数据库身份 | 权限范围 | 首次登录 |
| --- | --- | --- | --- | --- |
| Client | `client-admin@agentnovas.com` | `customer` | 仅 Client，全量当前权限均为 `SELF` | 登录后建议改密并按需启用 MFA |
| Operations | `operations-admin@agentnovas.com` | `employee` | 仅 Operations，显式 `PLATFORM` | 必须现场绑定 TOTP 并保存 recovery codes |
| Maintenance | `maintenance-admin@agentnovas.com` | `employee` | 仅 Maintenance，显式 `PLATFORM` | 必须现场绑定 TOTP 并保存 recovery codes |

这些是受控验收管理员，不是日常共享账号。Operations 同时拥有 maker/checker 权限不代表可以自审；服务端仍禁止同一用户批准自己的申请。涉及会员、Credits、充值、RBAC 或分成双审时，必须使用另一个获授权账号完成复核。

### 2.2 安全创建方式

创建器有以下保证：

- 必须显式设置 `ALLOW_ACCEPTANCE_ACCOUNT_PROVISIONING=1`；
- 密码在进程内随机生成，不接受命令行密码，不写终端；
- 三个用户、角色、权限、assignment 和审计在同一 PostgreSQL 事务中提交；
- 账号或固定 role code 已存在时失败，不覆盖、不重置；
- 密码使用当前 Argon2id 参数；数据库和审计不保存明文；
- 凭证只写入 `/run/credentials/three-app-credentials-*.json`，以 `wx` 创建且权限 `0600`；
- 内部账号不预置 MFA secret；当前关闭阶段直接登录，正式生产开启开关后通过 UI 独立绑定。

服务器准备：

```bash
sudo install -d -m 0700 /root/agentnovas-initial-access
```

使用与当前发布完全一致的 Runtime 镜像执行。`<VERSION>` 和 `<CREDENTIAL_FILE>` 由发布人员替换；当前版本可从 `/opt/agentnovas-riverton/current/release.env` 的 `RIVERTON_RELEASE_VERSION` 读取（本记录当前为 `1.0.0-beta.5`）。不要把密码或 Provider secret 放进 `-e`、命令历史或聊天：

```bash
sudo docker run --rm \
  --network agentnovas-riverton-backplane \
  --env-file /etc/agentnovas-riverton/migrator.env \
  -e ALLOW_ACCEPTANCE_ACCOUNT_PROVISIONING=1 \
  -e ACCEPTANCE_LOGIN_PROFILE=production \
  -e ACCEPTANCE_CLIENT_EMAIL=client-admin@agentnovas.com \
  -e ACCEPTANCE_OPERATIONS_EMAIL=operations-admin@agentnovas.com \
  -e ACCEPTANCE_MAINTENANCE_EMAIL=maintenance-admin@agentnovas.com \
  -e ACCEPTANCE_CREDENTIAL_OUTPUT=/run/credentials/<CREDENTIAL_FILE> \
  -v /root/agentnovas-initial-access:/run/credentials:rw \
  agentnovas-riverton-runtime:<VERSION> \
  node --experimental-strip-types scripts/provision-acceptance-accounts.mjs
```

操作者在自己的终端取回一次：

```bash
ssh an-saas 'sudo cat /root/agentnovas-initial-access/<CREDENTIAL_FILE>'
```

当前生产已创建的三端验收账号使用以下 root-only 文件；文件名本身不是密码，内容不得复制到聊天：

```bash
ssh an-saas 'sudo cat /root/agentnovas-initial-access/three-app-credentials-20260821T172923Z.json'
```

该命令只在你的终端显示三个登录邮箱与初始随机密码。完成首次登录、内部端 TOTP 绑定和密码管理器保存后，再按下方 `shred -u` 命令销毁服务器副本；销毁前不可重新运行创建器，因为它不会覆盖已有账号。

立即存入获授权密码管理器并逐端登录；完成改密和 MFA 后删除服务器文件：

```bash
ssh an-saas 'sudo shred -u /root/agentnovas-initial-access/<CREDENTIAL_FILE>'
```

不要把 `cat` 的输出复制到工单、群聊、文档或 Git。若创建命令失败，不要改用 SQL 绕过；先检查唯一 active `hq_admin`、Headquarters、权限目录、role code 和同邮箱账号。

### 2.3 首次登录验收

2026-08-22 已使用生产容器完成一次无密钥输出验收：三端正确 audience 登录均通过，Client 投影 9 项 Client-only 权限，Operations 投影 34 项 Operations-only 权限，Maintenance 投影 22 项 Maintenance-only 权限；内部端均进入首次 TOTP enrollment。验收产生的三个 session 已全部撤销。密码仍只存在服务器 root-only 凭证文件中，未写入本文或 Git。

1. Client：<https://agentnovas.com/login>。登录后应进入 `/dashboard`，确认只能看到 Client 菜单，Operations/Maintenance URL 返回 404/403。
2. Operations：<https://zht.agentnovas.com/login>。主密码通过后必须进入 TOTP enrollment；扫描二维码、输入一次验证码并离线保存 recovery codes。
3. Maintenance：<https://xm.agentnovas.com/login>。执行相同的独立 TOTP enrollment，不能复用 Operations 的 secret。
4. 分别退出，确认只清理当前 audience Cookie；重新登录并验证密码与 TOTP。
5. 创建一项需要审批的测试申请，确认申请人看不到自审按钮，服务端自审返回 409/403。

## 3. 外部 Provider 填空脚本

### 3.1 准备 root-only 答案文件

在服务器复制模板到仓库外目录。不要直接编辑仓库中的 example：

```bash
sudo install -d -m 0700 /root/agentnovas-config
sudo cp /opt/agentnovas-riverton/current/source/deploy/env/production-integrations.answers.example \
  /root/agentnovas-config/production-integrations.answers
sudo chmod 0600 /root/agentnovas-config/production-integrations.answers
sudoedit /root/agentnovas-config/production-integrations.answers
```

模板字段：

```text
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
NOTIFICATION_EMAIL_ALLOWLIST=
UDUN_GATEWAY_BASE_URL=
UDUN_MERCHANT_ID=
UDUN_API_KEY=
UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook
```

检查阶段不写文件：

```bash
sudo bash /opt/agentnovas-riverton/current/source/scripts/install-production-integrations.sh \
  --check /root/agentnovas-config/production-integrations.answers
```

确认 `resend_input` / `udun_input` 后才应用：

```bash
sudo bash /opt/agentnovas-riverton/current/source/scripts/install-production-integrations.sh \
  --apply /root/agentnovas-config/production-integrations.answers
sudo bash /opt/agentnovas-riverton/current/source/scripts/audit-production-config.sh
```

安装器不 `source` 答案文件，拒绝未知/重复/部分字段，分别通过临时文件原子替换现有 env，并确保以下开关仍为 false：

- `NOTIFICATION_EMAIL_SEND_ENABLED`
- `PAYMENT_WORKER_ENABLED`
- `PAYMENT_PROVIDER_TESTS_ENABLED`
- `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED`

它不会重启服务、写数据库 readiness、发送邮件、创建充值地址或调用交易所。

## 4. Resend 邮件

环境分流、secret 文件权限、原子替换、数据库最小权限、旧队列影响、启用/回滚和真实投递闭环的详细操作见
[`resend-email-configuration.md`](resend-email-configuration.md)。本节保留生产账号与 Provider 配置入口，发生冲突时以专项 Runbook 和代码事实为准。

官方文档：

- [域名验证](https://resend.com/docs/dashboard/domains/introduction)
- [API Key 管理](https://resend.com/docs/dashboard/api-keys/introduction)
- [Webhook 创建](https://resend.com/docs/api-reference/webhooks/create-webhook)
- [Webhook 事件类型](https://resend.com/docs/webhooks/event-types)

### 4.1 Provider 后台

1. 先撤销曾经出现在聊天里的临时 Key；不要继续使用。
2. 确认 `agentnovas.com` 在 Resend 为 `verified`。发件地址固定为 `noreply@agentnovas.com`；Resend 在域名验证后允许使用该域名下的发件地址，无需另建 sender identity。
3. 创建新的 `Sending access` Key，并限制到 `agentnovas.com`。不要给 Notification Worker `Full access`。
4. 创建 HTTPS Webhook：

   `https://xm.agentnovas.com/api/integrations/resend/webhook`

5. 订阅：`email.sent`、`email.delivery_delayed`、`email.delivered`、`email.opened`、`email.clicked`、`email.complained`、`email.bounced`、`email.failed`、`email.suppressed`。
6. 将新 Key、Webhook signing secret 和一个最小真实收件人 allowlist 填入 root-only 答案文件；不要把 Key 粘贴到命令行。

### 4.2 装载与验签

应用答案文件后，只重建需要读取新 env 的进程，不重建 PostgreSQL：

```bash
cd /opt/agentnovas-riverton/current
sudo docker compose --profile workers --env-file release.env \
  -f source/deploy/container/compose.yml up -d --no-deps --force-recreate \
  maintenance notification-worker
```

此时外发仍为 disabled。先在 Resend Webhook 页面发送测试事件，确认：错误签名返回 401；合法事件返回 200；相同 `svix-id` 重放不重复应用；Maintenance `/integrations/email` 只显示 secret 是否存在。

### 4.3 记录 readiness

当域名、Webhook、模板和 suppression 都有真实证据后，使用 CLI 记录非秘密事实。`EMAIL_INBOUND_MAILBOXES_VERIFIED=0` 表示 support/security/billing/operations 仍只是保留身份，不影响事务邮件：

```bash
sudo docker run --rm \
  --network agentnovas-riverton-backplane \
  --env-file /etc/agentnovas-riverton/migrator.env \
  -e ALLOW_EMAIL_READINESS_UPDATE=1 \
  -e EMAIL_READINESS_ACTION=activate \
  -e EMAIL_READINESS_EVIDENCE_REFERENCE=change-YYYYMMDD-NNN \
  -e EMAIL_SENDER_DOMAIN_VERIFIED=1 \
  -e EMAIL_WEBHOOK_VERIFIED=1 \
  -e EMAIL_TEMPLATES_VERIFIED=1 \
  -e EMAIL_SUPPRESSION_ENABLED=1 \
  -e EMAIL_INBOUND_MAILBOXES_VERIFIED=0 \
  agentnovas-riverton-runtime:<VERSION> \
  node --experimental-strip-types scripts/record-email-provider-readiness.mjs
```

CLI 不读取或保存 Resend secret，不改变发送环境开关，并写入审计。任一必需事实为 0 时 `activate` 失败。

### 4.4 受控外发

只有以下条件全部满足，才把 `notification.env` 中 `NOTIFICATION_EMAIL_SEND_ENABLED` 改为 `true`：

- 新 Key 已轮换并 domain-scoped；
- Webhook 签名与重放测试通过；
- 模板不含密码、TOTP secret 或明文 bearer token；
- suppression 表与 complaint/bounce 处理已验证；
- allowlist 中只有真实内部验收邮箱；
- Provider readiness 已记录 active；
- Notification Worker commit 与当前 release 一致。

改动后只重建 Notification Worker，在 Maintenance 发起一次安全测试。HTTP 202 只表示入队；必须等投递从 `queued` → `sent` → `delivered`，并在 Resend logs 与本地审计中用 delivery ID 对齐。若 bounce/complaint/5xx/heartbeat stale，立即改回 false、重建 Worker，并执行：

```bash
EMAIL_READINESS_ACTION=disable
```

对应的完整 disable CLI 参数与 activate 相同，但证据编号使用事故/变更编号。

## 5. 优盾充值通道

官方协议以 [Udun 中文开发中心](https://www.uduncloud.com/geteway-interface) 与
[英文旧版开发中心](https://www.uduncloud.com/en/developer-center/) 为准。详细部署与事故处置见
[`udun-deposit-gateway.md`](./udun-deposit-gateway.md)。当前代码只实现：

- `POST /mch/support-coins`：连通与当前商户币种查询；
- `POST /mch/address/create`：创建充值地址；
- 商户回调：`sign = md5(body + key + nonce + timestamp)`；
- `tradeType=1` 的充值事件；
- Ops maker/checker 复核后才入不可变账本。

没有实现 `/mch/withdraw`、`/mch/withdraw/proxypay`、划转、退款或提现。

### 5.1 商户后台取值

1. `UDUN_GATEWAY_BASE_URL` 必须是后台显示的专属 `https://*.udun.io` API 节点。`https://home.udun.io` 是管理后台，不是 API base；不要追加 `/mch/address/create`。
2. 取得当前商户 `merchantId` 与 API Key。
3. 在支持币种查询中确认当前钱包的 USDT/TRC20 `mainCoinType`、`coinType` 和可选 `walletId`。不要直接复制文档示例或 UI 默认值。
4. 测试回调固定为 `https://main-test.agentnovas.com/api/integrations/payments/udun/webhook`；生产 Host 必须在正式发布前单独冻结并进入 Broker allowlist。

### 5.2 安装、映射和测试

先用 `payment-secret-broker-bootstrap.answers.example` 安装专用 Broker、RSA 密钥和受管目录。该答案文件只包含
Broker 数据库 URL 与回调 Host allowlist，不包含优盾商户秘密。商户配置必须在 Maintenance 页面以只写方式安装或轮换。
随后以 `payment-secret-broker` profile 启动 Broker，并重建 Client 与 Maintenance：

```bash
cd /opt/agentnovas-riverton/current
sudo docker compose --env-file release.env -f source/deploy/container/compose.yml \
  up -d --no-deps --force-recreate client maintenance
```

登录 Maintenance `/integrations/payments`：

1. 保持 provider 为 disabled；
2. 填入从当前商户查询得到的主币种编号、USDT token 编号和可选 walletId；
3. 测试环境把 `PAYMENT_PROVIDER_TESTS_ENABLED` 设为 `true` 并重建 Maintenance；
4. 执行 Provider 币种校验与公网回调测试；测试历史必须绑定当前配置版本；
5. Client/Maintenance 的 `PAYMENT_PROVIDER_OUTBOUND_ENABLED` 必须保持一致；生产不以临时开关绕过测试；
6. 只有 24 小时内两项测试 passed、Broker 心跳新鲜、回调验签/重放/nonce、Ops maker/checker、账本对账和测试站小额均通过后，才在 UI 启用 Provider。

启用会让 Client 能请求真实充值地址，因此不能把“连通测试 passed”当作启用授权。生产首次验收只用内部账号和商户允许的最小金额；`status=3` 回调仍不自动入账。

## 6. LLM Profile 与 Agent 绑定

密钥不放 env 答案文件；通过 Maintenance `/models` 写入版本化、加密的 Profile：

1. 准备 Provider 名称、官方 HTTPS base URL、模型名和专用 API Key。
2. 新建 Profile；保存后页面只显示 `hasSecret`，不回显 Key 或完整端点。
3. 执行 Profile 连通测试并记录原因。
4. 绑定七个 Research 角色：requirements、market_regime、proposal_a、proposal_b、adversarial_review、risk_review、report。
5. 按需绑定三个 Runtime 解释角色：market_summary、adversarial_explanation、risk_explanation。
6. 逐个检查 revision、enabled、binding 与测试时间；轮换会生成新不可变修订。
7. 未配置模型费率或供应商不能返回可靠 usage 时，付费 AI 请求应继续拒绝，不能估算扣 Credits。

Research Worker 在 Beta 仍保持关闭。官方 Paper 的确定性 Runtime 只能在模型/行情、会员/披露和 worker Gate 均通过后单独启动；模型绑定完成不等于策略正在运行。

## 7. 平台 Demo 交易所

官方边界：

- [OKX Demo](https://www.okx.com/docs-v5/en/)：Demo Key，REST 使用 `https://openapi.okx.com` 且每个请求强制 `x-simulated-trading: 1`；需要 API Key、secret、passphrase。
- [Binance Spot Testnet](https://developers.binance.com/zh-CN/docs/products/spot/testnet/web-socket-streams)：只使用 Spot Testnet 账户与 `https://testnet.binance.vision`；需要 API Key、secret。
- [Bybit Demo](https://bybit-exchange.github.io/docs/v5/demo)：从主网站的 Demo Trading 模式创建 Key，只使用 `https://api-demo.bybit.com`；不要混用 testnet/mainnet Key。

创建 Key 时只授予测试环境现货查询/下单所需最小权限，不授予提现、划转、杠杆或衍生品权限。控制台不接收明文凭证，禁止用手工 SQL 写密文，也禁止把凭证粘贴到浏览器、聊天或命令行。

在服务器仓库外准备 root-only JSON：

```bash
sudo install -d -m 0700 /root/agentnovas-config
sudo cp /opt/agentnovas-riverton/current/source/deploy/env/platform-demo-accounts.answers.example.json \
  /root/agentnovas-config/platform-demo-accounts.json
sudo chmod 0600 /root/agentnovas-config/platform-demo-accounts.json
sudoedit /root/agentnovas-config/platform-demo-accounts.json
```

用与当前提交完全一致的 tools/runtime 镜像一次性加密录入。下面只把文件挂载为只读；凭证不会进入参数、stdout、审计或 Git：

```bash
sudo docker run --rm \
  --network agentnovas-riverton-backplane \
  --env-file /etc/agentnovas-riverton/maintenance.env \
  -e ALLOW_PLATFORM_DEMO_CREDENTIAL_PROVISIONING=1 \
  -e PLATFORM_DEMO_CREDENTIAL_INPUT=/run/credentials/platform-demo-accounts.json \
  -v /root/agentnovas-config:/run/credentials:ro \
  agentnovas-riverton-runtime:<VERSION> \
  node --experimental-strip-types scripts/provision-platform-demo-credentials.mjs
```

工具会加密并原子写入提供的 provider；无论新建还是轮换，账户都被强制设为 `enabled=false`、账户和三张策略的 kill switch 均开启、旧 verification 立即失效。它不会联网验证、启动 Worker、解除停控或开启外部写。录入后立即安全销毁输入：

```bash
sudo shred -u /root/agentnovas-config/platform-demo-accounts.json
```

后续仍按以下顺序：临时启用 `PLATFORM_DEMO_VERIFICATION_ENABLED`；逐 provider 验证；关闭验证开关；确认 15 分钟内验证；按 provider/card 解除停控；启动 Demo Worker 但保留 `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false`；最后才在 staging 小额窗口单独授权外部写。客户 Paper 结果始终不因 Demo 成败改变。

## 8. 服务重启、验收与清理

每次配置变化后：

1. 只重建读取该 env 的服务，不执行 `docker compose down`，不删除 volume，不启动 migrator。
2. 检查三端 `/api/health/live` 和 `/api/health/ready`。
3. 在 Maintenance `/health` 区分 configured、enabled、alive、healthy、stale。
4. 检查日志中没有 secret、完整 PII、Webhook body、密码或 token。
5. 执行 `/opt/agentnovas-riverton/current/source/scripts/audit-production-config.sh`；保存输出，不保存答案文件内容。
6. 将 root-only 答案文件放入受控 secret 管理或安全销毁：

```bash
sudo shred -u /root/agentnovas-config/production-integrations.answers
```

7. 任何 Provider 验收失败，先关闭对应环境开关和数据库状态，再轮换凭证；禁止制造“已发送”“已连接”“已入账”或“已成交”的成功状态。

## 9. 仍需人工提供的非代码信息

代码无法代替以下输入：

- 一个真实可收信的内部 Beta allowlist 邮箱；
- 新的 Resend domain-scoped Sending Key 和 Webhook signing secret；
- 优盾专属 API 节点、商户号、API Key、当前商户币种编号和可选 walletId；
- 选定的 LLM Provider、模型、API Key、费率与 usage 能力；
- OKX Demo、Binance Spot Testnet、Bybit Demo 的最小权限测试凭证；
- 独立 maker/checker 与发布值班账号。

这些值只进入 root-only secret 文件、加密配置服务或授权密码管理器，不进入 Git、文档、命令行、工单或聊天。

## 10. 执行服务与密钥托管（ADR-0019）

执行服务是**全系统唯一持有 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` 的进程**。三个 Web
应用都不再需要那个变量——它们通过内网调用执行服务完成账户验证、紧急平仓、实盘下单。

**不配这一节，三个 Web 应用会在客户点「验证交易所账户」和「一键平仓」时报
「服务不可用」。** 这两个功能不会静默失败，但也不会工作。

### 10.1 两把不同的密钥，分开生成、分开轮换

| 变量 | 谁持有 | 泄露后果 |
| --- | --- | --- |
| `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` | **只有** `execution.env` | 加数据库读权限 = 全部客户的交易所 API Key |
| `EXECUTION_SERVICE_SHARED_SECRET` | `execution.env` + 三个 Web 的 env | 能让执行服务替他下单，但拿不到凭证 |

两者必须是**不同的值**。共享密钥只是内网鉴权，不参与加密；把它设成加密密钥的值等于
把加密密钥发给了三个 Web 进程，这一整套改造就白做了。

```bash
# 在目标机器上生成，不要经过聊天、工单或命令历史
openssl rand -base64 48 | tr -d '\n=/+' | head -c 48
```

### 10.2 `execution.env` 需要的变量

```
DATABASE_URL=postgresql://agentnovas_execution_service:<口令>@127.0.0.1:5432/<库>
RIVERTON_EXECUTION_SERVICE=true
EXCHANGE_CREDENTIAL_ENCRYPTION_KEY=<与现有值一致，迁移时务必保留原值>
EXECUTION_SERVICE_SHARED_SECRET=<48 字符随机值>
EXECUTION_SERVICE_HOST=127.0.0.1      # 裸机保持回环；容器见下
EXECUTION_SERVICE_PORT=3020
```

`RIVERTON_EXECUTION_SERVICE=true` 声明进程身份，数据库角色必须是
`agentnovas_execution_service`——角色与身份不匹配时进程拒绝启动。

> **容器部署**里回环地址对同网络的其它容器不可达，需要绑通配地址。代码默认拒绝
> `0.0.0.0`，要绕过必须显式声明：
>
> ```
> EXECUTION_SERVICE_HOST=0.0.0.0
> EXECUTION_SERVICE_INTERNAL_NETWORK_ONLY=true
> ```
>
> 这是一条**运维断言**，代码无法自行验证，启动时会大声打印出来。做出它的前提是：
> 该容器没有 `ports` 映射、不在 `edge` 网络上（compose 里 `execution` 只挂
> `backplane` 与 `egress`）。裸机 systemd 部署保持 `127.0.0.1`，不要设这个变量。

### 10.3 三个 Web 的 env 需要补两行

`client.env` / `operations.env` / `maintenance.env` 各加：

```
EXECUTION_SERVICE_URL=http://execution:3020
EXECUTION_SERVICE_SHARED_SECRET=<与 execution.env 相同>
```

并**删除**这三个文件里的 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。删掉之后可以自查：

```bash
grep -rl EXCHANGE_CREDENTIAL_ENCRYPTION_KEY .next-client/server
# 查不到任何文件才算对；npm run quality:key-custody 会做同样的检查
```

### 10.4 集成凭证密钥不再回退

`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` 现在是**必配项**。它此前会在缺失时回退到
`EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`，那让运维端只要漏配一个变量就持有交易所凭证
密钥——而它从不需要解密任何客户的交易凭证。

*迁移*：若既有集成凭证是用交易所密钥加密的，先把**同一个值**显式配成
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` 保证可解密，随后用一个独立值重新加密，
两把密钥才真正分开。

### 10.5 审计锚点导出

`AUDIT_ANCHOR_EXPORT_KEY`（可选但强烈建议）给导出件签名。

```bash
npm run audit:anchors:export > anchors-$(date +%F).json   # 存到数据库角色够不着的地方
npm run audit:anchors:verify anchors-2026-08-23.json      # 回验才是这套机制的价值
```

不配密钥时导出件标注 `signed: false`，仍能发现数据库侧的删除与改写，但无法证明导出件
自身没有被替换。**一份从没被回验过的导出件只是一个文件。**

### 10.6 实盘路由默认全关

真实下单需要同时满足三件事，任一不满足都只会产出一条明确的拒绝回执：

1. 运营端「风控 → 实盘路由」里该 (交易所, 环境) 已 **granted**——开通走 maker/checker，
   发起人不能批准自己；
2. 部署 `mode = 'live'` 且绑定了状态正常、可交易的交易所账户；
3. 无命中的熔断开关、无未决对账。

关停是单人即时的，不需要复核——**让系统更安全的动作永远比让系统更危险的动作容易做**。
