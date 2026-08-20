# ADR-0005: Riverton 三应用、可配置 RBAC 与充值账本底座

## 状态

Accepted

## 日期

2026-08-19

## 背景

AgentNovas 需要从单一客户应用扩展为 Riverton Capital 的三应用部署：客户端、运营端和运维端。新架构仍然部署在自有 Linux 服务器上，使用 Node.js、PostgreSQL、独立 Worker、Nginx 和 Certbot，不使用 Cloudflare Runtime、D1、Pages、Workers、Tunnel、Proxy 或 Redis。

远端仓库中新增了运营后台和运维后台方向，但仍含 Cloudflare/D1 运行假设。本分支以本地提交 `64ba128` 为主线，选择性迁移有效产品能力，并把长期授权、充值和通知能力落到 PostgreSQL 真源中。

## 决策

1. 三个应用使用独立 audience、端口、域名和 Cookie：`agentnovas.com`、`zht.agentnovas.com`、`xm.agentnovas.com`。
2. 根页面是服务端 audience 分发入口；客户端主体移入 `apps/client/ui`，运营端和运维端页面分别位于 `apps/operations/ui` 与 `apps/maintenance/ui`。三端继续共享一个 Next.js 工程、数据库、合同和 UI 组件，不拆成三个仓库。
3. `users.role` 保留一个兼容周期，但新增 RBAC 表：应用、权限目录、角色模板、角色版本、角色、角色权限、用户角色分配、权限变更申请、审批和授权审计。
4. 权限键由代码注册，后台只能组合已注册权限；数据范围固定为 `SELF`、`DIRECT_REPORTS`、`TEAM_TREE`、`ORGANIZATION`、`ORGANIZATION_SET`、`PLATFORM`。
5. 分公司派生角色只能减少总部模板权限或缩小数据范围，不能创建运维角色、平台角色或跨组织角色。
6. 敏感权限、资金人工操作、策略审核和跨组织权限继续强制双人审批，申请人不能自审；这些是系统硬规则，不能被 RBAC 覆盖。
7. 充值形成平台预付 USDT 余额，只能用于会员和 AI 积分，不支持提现、用户间转账或真实交易。
8. 账本使用 PostgreSQL `numeric(36,18)` 和双式分录，`ledger_postings` 是不可变真源；修正只能通过反向分录。
9. Resend 统一使用 `noreply@agentnovas.com` 作为所有用户邮件的发件地址，密钥只允许出现在受保护的服务环境文件，只有 Notification Worker 可以使用 API Key 外发；运维端只展示安全状态，不展示 Key、完整端点或供应商 payload。
10. Payment Worker 和 Notification Worker 默认关闭。未配置真实服务商时，API 必须明确返回未配置，不能生成虚假充值地址或伪装通知发送成功。
11. Resend 邮件带有本地 `notification_delivery_id` 标签；已验证 Webhook 使用 `svix-id` 幂等键、供应商事件时间和固定优先级在同一 PostgreSQL 事务中更新投递状态。只有事件持久化和映射事务成功后才返回 HTTP 200，乱序事件和迟到的 Worker 回写不得覆盖更新的 `delivered` 或 `failed` 状态。
12. `/` 和稳定页面路由都由当前 audience 分发；错误应用的页面路由返回 404。未登录返回当前应用登录页，已登录但无模块权限显示无权限页，页面菜单和按钮读取 `/api/access/me/effective`，API 仍独立执行服务端鉴权。
13. 运营端和运维端共用 `packages/ui/src` 的 Shell、页面状态、确认对话框和 Access Center，但导航与权限目录按应用过滤；内部应用没有注册和忘记密码入口。
14. 运营客户、充值、账本和财务查询使用新 RBAC 数据范围。`SELF`、`DIRECT_REPORTS`、`TEAM_TREE`、`ORGANIZATION` 与 `PLATFORM` 各自生成收窄谓词，缺少 PII 权限时列表和详情使用同一脱敏规则。
15. 敏感角色创建、分配、撤销和资金人工操作进入双人审批；申请人不能自审，重复或过期决定返回冲突。审批结果只表示审批记录生效，不代表资金、链上交易或不可变账本已被执行。
16. 运维集成页面只展示 `hasSecret`、配置/启用状态和最近测试结果。模型密钥、完整端点、Webhook payload 与供应商密文引用不得通过运维响应回显。

## 后果

- 三应用可以先在同一代码基线中独立登录和部署，减少一次性目录迁移风险。
- 新 RBAC 与旧角色可以并行一段时间：当 DB 中没有新角色分配时，服务端使用受限的旧角色映射作为兼容来源。
- 客户端、运营端和运维端后续 UI 可以基于 `/api/access/me/effective` 渲染菜单和按钮；API 仍必须服务端鉴权。
- 三端 UI 已拥有独立登录、导航和业务工作区；共享代码不表示共享登录能力或跨应用授权。
- 稳定路由与 audience 的组合成为公开界面合同，新增页面时必须同步更新服务端路由白名单、页面权限和合同测试。
- 充值、对账、导出和通知有了持久化合同，但真实自动入账仍等待服务商/托管方案与专项安全评审。
- 邮件发送、供应商事件和本地投递记录形成可审计闭环；原始 Webhook 仍按受限业务数据管理，生产环境需配置访问控制和留存策略。
- 历史资金流水不得删除或直接改写，未来退款/冻结/冲正都必须形成审计链。

## 不做

- 不启用真实永续订单、OKX 演示订单或自动平仓。
- 不开发用户提现、用户间转账、平台余额用于真实交易或自动链上退款。
- 不保存链上私钥。
- 不使用 Cloudflare Runtime、Proxy、Workers、Pages、D1、Tunnel 或 Redis。
- 不推送远程、不创建 PR，除非用户明确授权。

## 后续决策

- 平台/产品品牌、服务余额与交易策略资金边界见 ADR-0006。
- 七智能体角色链、确定性内核与审计边界见 ADR-0007。
