# Riverton 三应用一库前端运行手册

> 适用状态：`CURRENT_BASELINE`。V3 导航与页面目标见三份 `V3_*_APP_TARGET_SPEC.md`；当前三端 audience/Host/Cookie 隔离继续作为不可退化基础。

## 1. 架构边界

Client、Operations 和 Maintenance 使用同一个 Next.js 工程、PostgreSQL 业务库、合同与共享 UI。功能隔离由 `RIVERTON_APP_AUDIENCE`、域名、独立 Cookie、页面白名单、路由权限和服务端 RBAC 共同完成。

共享代码不是跨端授权。任何页面按钮过滤都只改善体验，API 必须继续调用服务端鉴权并限定当前 audience 与数据范围。

## 2. 本地运行

先配置本地 PostgreSQL `DATABASE_URL`，再按需启动：

```bash
npm run dev:client
npm run dev:operations
npm run dev:maintenance
```

默认入口：

| 应用 | 本地地址 | Cookie | 注册入口 |
|---|---|---|---|
| Client | `http://localhost:3000` | `rc_client_session`，兼容 `an_session` | 登录、邀请注册、忘记密码 |
| Operations | `http://localhost:3001` | `rc_ops_session` | 仅登录 |
| Maintenance | `http://localhost:3002` | `rc_maint_session` | 仅登录 |

### 2.1 `an-saas` 远端 preview 测试环境

自 2026-08-26 起，资源密集型构建、全量测试和三端浏览器服务端优先在 `ssh an-saas` 的隔离 preview
环境执行，本地只保留轻量静态和定向检查。需求方已授权随时替换以下测试入口：

| 应用 | 测试域名 | 当前 Caddy 上游 |
| --- | --- | --- |
| Client | `https://test.agentnovas.com` | `agentnovas-riverton-preview-client-1:3000` |
| Operations | `https://ops-test.agentnovas.com` | `agentnovas-riverton-preview-operations-1:3000` |
| Maintenance | `https://main-test.agentnovas.com` | `agentnovas-riverton-preview-maintenance-1:3000` |

三域 DNS、HTTPS、CSP 和页面 audience 已现场核对。它们是可替换测试入口，不是 P-11 正式生产域名；
不得把测试通过写成正式域名冻结或生产发布。替换只操作明确命名的 `preview-*` 容器、preview 数据库和
Caddy 测试 vhost，不停止或覆盖无 `preview-` 前缀的正式三端/PostgreSQL 容器。源码使用一次性目录或
streamed ephemeral container，完成后清理明确创建的临时资源；生产迁移、真实外部写入和 Git push
仍需要各自明确授权。

preview Compose 通过每端独立的 `RIVERTON_APP_HOST` 指定上述测试域名。该值必须是单个规范 DNS
hostname，不能包含协议、端口、逗号、IP 或 `localhost`；配置后只接受该精确 Host，正式域名和其他
测试域名都必须失败关闭。Docker healthcheck 也使用同一 Host，避免应用实际拒绝流量但容器误报健康。

2026-08-26 当前 preview 应用候选为
`preview-7c047b6-wt-20260826T142018Z`，应用回滚点为
`preview-7c047b6-wt-20260826T141035Z`；两者都位于
`/opt/agentnovas-riverton-preview/releases/`。替换前的数据库 dump 保存在当前候选目录的相邻 release
目录并已通过 `pg_restore --list` 验证。切换应用版本不重建 preview PostgreSQL 容器或数据卷；任一
Web 容器未达到 `running/healthy` 时，必须用回滚 release 自己的 compose 与 `release.env` 重建三端。
迁移只允许由 migrator 按 registry checksum 执行；已部署迁移文件 checksum 不一致时停止发布，恢复
仓库中已部署原文或追加新的 forward migration，禁止改 registry hash 绕过检查。

远端全量 Gate 使用隔离 PostgreSQL。测试连接串必须显式包含数据库用户；涉及 Git 仓库合同的测试容器
必须安装 `git`。包含 cluster-global role fixture 的 Node 测试在资源受限主机上使用单 CPU/串行资源
隔离，避免不同测试文件并发删除同名角色。`quality:key-custody` 与 bundle budget 依赖三端 `.next-*`
产物，必须在三端 production build 后运行，不能把“缺少构建产物”记录为代码失败。

端口被占用时应先确认占用进程归属；测试服务使用其他明确端口，不能终止未知或用户已有进程。

需要并行保留已有服务时，可在**显式 audience** 下覆盖本机端口；端口必须是 `1–65535` 的十进制整数，Host 与端口任一不匹配都会失败关闭。例如：

```bash
RIVERTON_APP_AUDIENCE=client RIVERTON_APP_LOCAL_PORT=3010 npm exec -- next start -p 3010
RIVERTON_APP_AUDIENCE=operations RIVERTON_APP_LOCAL_PORT=3011 npm exec -- next start -p 3011
RIVERTON_APP_AUDIENCE=maintenance RIVERTON_APP_LOCAL_PORT=3012 npm exec -- next start -p 3012
```

当前 `MFA_ENFORCEMENT_ENABLED` 默认关闭，Operations/Maintenance 首次密码登录不会进入 TOTP 绑定，也不得出现冗余确认弹窗。正式生产按专项 Gate 重新开启后，首次登录才进入 TOTP 绑定：将页面显示的一次性设置密钥录入身份验证器，输入六位动态码，离线保存 8 枚恢复码后进入应用；后续可使用动态码或一枚未使用的恢复码。设置密钥、恢复码和密码不得写入文档、Git 或长期聊天。

## 3. 稳定路由

Client 的五个规范入口为 `/dashboard`、`/trading?tab=hall|portfolios|records`、
`/strategies?tab=research|backtests`、`/market` 和 `/assistant`。账户能力统一进入
`/account-center?tab=membership|credits|wallet|deposit|statements`，个人偏好统一进入
`/settings?tab=profile|appearance|security|notifications`；通知入口固定在顶栏。原会员、钱包、充值、
Paper、交易大厅、工作记录、回测、账户和通知地址继续作为兼容深链接。

Operations 的五个规范入口为 `/`、`/customers`、`/trading-operations`、`/commercial` 和
`/governance`。商业能力通过 `commercial` 的 `membership|credits|deposits|ledger|statements|finance`
Tab 访问；治理能力通过 `governance` 的 `invitations|operators|approvals|access|audit` Tab 访问。
原 `/accounts`、`/membership-orders`、`/performance-statements`、`/credits`、`/deposits`、`/ledger`、
`/finance`、`/approvals` 和 `/access*` 仍映射到相同能力。已退役的组织关系管理页不恢复。

Maintenance 的五个规范入口为 `/`、`/ai-strategy`、`/integrations`、`/configurations` 和 `/releases`。
系统运行通过根页 `overview|readiness|health|records` Tab 访问；其余中心分别承载 AI 与策略、外部集成、
平台配置、发布与安全。原 `/models`、`/ai-usage`、`/work-records`、`/integrations/*`、`/health`、
`/safety`、`/settings*`、`/access*` 和 `/audit` 仍是兼容深链接。

规范入口收到非法 Tab 时回退到当前权限范围内的安全默认值；兼容深链接必须保留资源 ID 和必要查询参数。

错误 audience 的稳定路由必须返回 404。未登录页面跳转 `/login?next=...`；登录接口对无当前应用登录权限的账号返回 403；已登录但无模块权限显示无权限页且不请求业务数据。

## 4. 核心权限

菜单由 `/api/access/me/effective` 返回的当前应用权限过滤。主要权限映射：

| 工作区 | 读取/管理权限 |
|---|---|
| 客户钱包、充值 | `client.wallet.view`、`client.deposit.create` |
| 运营客户、组织 | `ops.customers.view`、`ops.customers.manage` |
| 运营充值与 PII | `ops.deposits.view`、`ops.deposits.pii_reveal` |
| 充值人工申请/审批 | `ops.deposits.action_request`、`ops.deposits.action_approve` |
| 运营账本/财务 | `ops.ledger.view`、`ops.reconciliation.run` |
| 运营授权 | `ops.roles.manage`、`ops.roles.assign`、`ops.roles.approve_sensitive` |
| 运维健康 | `maint.system_health.view` |
| 模型与 Agent | `maint.llm_profiles.manage`、`maint.agent_bindings.manage` |
| AI 用量分析 | `maint.ai_usage.view` |
| 工作记录脱敏导出 | `maint.work_records.export` |
| 邮件与支付 | `maint.email_integrations.manage`、`maint.payment_integrations.manage` |
| 紧急暂停 | `maint.emergency_pause.execute` |
| 平台与客服设置 | `maint.feature_flags.manage` |
| 运维授权/审计 | `maint.roles.manage`、`maint.roles.approve_sensitive`、`maint.audit.view` |

`SELF`、`DIRECT_REPORTS`、`TEAM_TREE`、`ORGANIZATION`、`ORGANIZATION_SET` 和 `PLATFORM` 是固定数据范围。运营查询不能把 TEAM 范围扩大成整个组织；缺少 `ops.deposits.pii_reveal` 时，列表和详情都必须脱敏。

## 5. 敏感操作与状态语义

- 敏感角色创建、分配、撤销和充值人工操作必须填写原因并进入双人审批；申请人不能自审。
- 角色审批完成后，新角色保持草稿；角色管理员核对后填写发布原因，发布事件写入当前应用授权审计。
- “审批已记录”不等于资金执行、链上转账或账本变更。账本页面没有编辑和删除入口。
- 支付未配置或测试功能关闭时保留 API 的 503 原因，不生成地址、二维码或成功提示。
- 邮件测试成功入队时显示 `queued` 并明确“请求已记录”；只有 Worker/Resend 回执才能显示 `sent` 或 `delivered`。Gate 未满足时显示 `configured_not_sent` 或具体 503 原因，不能写成已发送。
- 运维页面只展示 `hasSecret`、配置状态和最近测试时间；密钥、完整端点和 Webhook payload 不得回显。
- AI 用量页只展示安全聚合：日期按 UTC 请求创建 cohort，默认 30 天、最多 90 天；可信 Token 只来自成功请求，Credits 只显示 settled 数值。组织快照的 legacy 质量必须可见，用户只能显示稳定伪名，模型按请求 revision。页面所称“已记录非取消失败率”排除 preflight 拒绝、用户取消和处理中请求，不可用作系统/provider 可用率；P-08 未确认前不可显示固定费用规则已完成。
- AI 用量日期在页面内直接应用，不弹出确认对话框。当前 MFA Gate 默认关闭；正式生产重新开启后仍需满足 `maint.ai_usage.view` 的 recent MFA 策略，不得为免弹窗绕过服务端 Gate。
- 真实永续订单始终关闭。
- 运维紧急暂停按当前 RBAC 数据范围生效，必须填写原因并审计；它只把官方 Paper 组合限制为 `close_only/read_only` 并拒绝待处理买入，不发送任何订单，也不改变平台 Demo kill switch。解除后组合不会自动恢复，必须由显式会员/客户状态流程重新核验。
- 客户端只读取平台设置中的公开品牌、客服和公告字段。Telegram 客服链接只接受受支持域名的 HTTPS 地址；未配置时明确显示未配置，不生成假工单回执。

## 6. 验证命令

```bash
npm test
npx tsc --noEmit
npm run lint
npm run test:apps
git diff --check
```

浏览器验收必须使用隔离 Profile 和一次性测试数据库或 Schema，不复用开发/生产账号。至少覆盖四种角色：Client、Operations 申请人、Operations 审批人、Maintenance 管理员。一次性凭证不得写入仓库或运行手册；验收结束后停止测试服务并删除明确创建的测试 Schema。

## 7. 发布前检查

- 三个 audience 分别构建并使用各自域名、Cookie 和服务单元。
- Operations/Maintenance 没有注册入口，错误 audience 路由为 404。
- 当前应用权限只返回当前应用角色、分配、变更申请和审计事件。
- PII 脱敏、密钥不回显、未配置/未发送状态和双人审批语义通过验收。
- Payment Worker、Notification Worker、真实支付、邮件外发和真实订单继续默认关闭，除非另有专项上线授权与运行手册。
- 生产数据库迁移、外部邮件/支付调用和远程 Git 操作需要独立明确授权。

## 8. 七智能体交易大厅运行边界

- 三张官方策略卡的产品目标是 BTC/ETH/SOL 的 USDT 现货；当前环境只能展示 shadow/paper，不得写成客户交易所真实成交。
- 七角色固定为市场分析师、技术分析师、策略研究员、反方审查员、首席风控官、AI 决策官和交易执行员；audit 是系统审计，不占角色序列。
- Hall 和会议详情必须读取 `/api/trading-hall` 的真实 decision round；没有数据时显示空状态，不使用静态价格、收益或会议结论。
- 平台服务钱包与交易所策略资金必须分开说明。
- 真实现货跟随需要独立安全/合规/交易所验收和明确授权；真实永续订单继续关闭。
