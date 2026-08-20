# Riverton 三应用一库前端运行手册

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

端口被占用时应先确认占用进程归属；测试服务使用其他明确端口，不能终止未知或用户已有进程。

## 3. 稳定路由

Client 保留现有策略、Agent、回测、模拟盘、会员和账户工作区，并增加 `/wallet`、`/wallet/deposits`、`/notifications`。根 `/` 仍是现有客户端主工作区，`/login` 是客户端会话入口。

Operations：`/`、`/customers`、`/organization`、`/deposits`、`/deposits/[id]`、`/ledger`、`/finance`、`/approvals`、`/access`、`/access/audit`。

Maintenance：`/`、`/models`、`/integrations`、`/integrations/email`、`/integrations/payments`、`/health`、`/safety`、`/settings`、`/access`、`/access/audit`。

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
- 邮件测试的 `configured_not_sent` 显示“已配置但未发送”，不能写成已发送。
- 运维页面只展示 `hasSecret`、配置状态和最近测试时间；密钥、完整端点和 Webhook payload 不得回显。
- 真实永续订单始终关闭。
- 运维紧急暂停按当前 RBAC 数据范围生效，必须填写原因并审计；自动处理仓位仅限已授权 OKX Demo 账户，解除后策略不会自动恢复。
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
