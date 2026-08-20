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
2. 当前增量暂不搬迁根 `app/` 目录，先通过 `RIVERTON_APP_AUDIENCE`、独立构建目录和 systemd 服务完成运行隔离；后续再逐步把页面移入 `apps/*`。
3. `users.role` 保留一个兼容周期，但新增 RBAC 表：应用、权限目录、角色模板、角色版本、角色、角色权限、用户角色分配、权限变更申请、审批和授权审计。
4. 权限键由代码注册，后台只能组合已注册权限；数据范围固定为 `SELF`、`DIRECT_REPORTS`、`TEAM_TREE`、`ORGANIZATION`、`ORGANIZATION_SET`、`PLATFORM`。
5. 分公司派生角色只能减少总部模板权限或缩小数据范围，不能创建运维角色、平台角色或跨组织角色。
6. 敏感权限、资金人工操作、策略审核和跨组织权限继续强制双人审批，申请人不能自审；这些是系统硬规则，不能被 RBAC 覆盖。
7. 充值形成平台预付 USDT 余额，只能用于会员和 AI 积分，不支持提现、用户间转账或真实交易。
8. 账本使用 PostgreSQL `numeric(36,18)` 和双式分录，`ledger_postings` 是不可变真源；修正只能通过反向分录。
9. Resend 统一使用 `noreply@agentnovas.com` 作为所有用户邮件的发件地址，密钥只允许出现在 Worker 环境文件，运维端只展示安全状态，不展示 Key、完整端点或供应商 payload。
10. Payment Worker 和 Notification Worker 默认关闭。未配置真实服务商时，API 必须明确返回未配置，不能生成虚假充值地址或伪装通知发送成功。

## 后果

- 三应用可以先在同一代码基线中独立登录和部署，减少一次性目录迁移风险。
- 新 RBAC 与旧角色可以并行一段时间：当 DB 中没有新角色分配时，服务端使用受限的旧角色映射作为兼容来源。
- 客户端、运营端和运维端后续 UI 可以基于 `/api/access/me/effective` 渲染菜单和按钮；API 仍必须服务端鉴权。
- 充值、对账、导出和通知有了持久化合同，但真实自动入账仍等待服务商/托管方案与专项安全评审。
- 历史资金流水不得删除或直接改写，未来退款/冻结/冲正都必须形成审计链。

## 不做

- 不启用真实永续订单、OKX 演示订单或自动平仓。
- 不开发用户提现、用户间转账、平台余额用于真实交易或自动链上退款。
- 不保存链上私钥。
- 不使用 Cloudflare Runtime、Proxy、Workers、Pages、D1、Tunnel 或 Redis。
- 不推送远程、不创建 PR，除非用户明确授权。

