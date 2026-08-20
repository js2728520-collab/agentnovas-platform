# Riverton Capital 商业 Beta 进度清单

状态说明：`[x]` 已有本分支代码/测试证据；`[-]` 实现中或部分；`[ ]` 未完成；`[!]` 等待外部依赖/授权。

## A. D1 合同与工程基线

- [x] 唯一目标仓库、集成分支和起点已确认；三个本地 worktree 已建立。
- [x] PostgreSQL 迁移器具备 version/checksum/advisory lock/每文件事务；未知 legacy checksum 明确失败关闭。
- [x] 四档会员、paper 10,000/card、UTC 周分成、三 Demo provider 公共合同已冻结。
- [x] Argon2id 依赖锁定并完成运行时 hash/verify 冒烟。
- [x] Worker 迁移 `0025`、真实 heartbeat 和公开/内部 health 分层完成；公开 health 不泄露内部检查。
- [x] PRD、七智能体、System Spec、三端 Spec、ADR、API、Gate、Runbook 按 v2 更新。

## B. API Security（Wave 1）

- [x] `0021_identity_access_hardening.sql`。
- [x] Proxy API Policy、requestId、统一错误和 route inventory。
- [x] 未知 Host 404、Origin/CSRF、body limit、幂等与限流。
- [x] Argon2id 新 hash、PBKDF2 lazy rehash、dummy verify。
- [x] TOTP/recovery/recent MFA 与内部 session TTL；首次绑定、8 枚恢复码和登录跳转已进入真实浏览器 Gate。
- [x] CLI-only bootstrap、一次性 set-password；后端不再返回或保存明文临时密码。
- [x] 显式 assignment、revoke tombstone、organization-set/team/direct-report scope。
- [x] 203 个 route method inventory 零遗漏；核心 audience/scope PostgreSQL 反证通过。

## C. Commercial（Wave 1）

- [x] `0022_ledger_approval_invariants.sql`：平衡、不可变、reversal、owner/account 唯一性。
- [x] `0023_commercial_membership_settlement.sql`：plans/orders/evidence/entitlement/legal/credits/statements。
- [x] 会员订单 + 外部付款凭证 + maker-checker 幂等激活。
- [x] credits grant/reserve/settle/release 与不可变 ledger。
- [x] UTC 周分成、高水位、亏损结转、应收/付款两段复核。
- [x] 自审、凭证语义双花、重复/并发/stale/rollback 与同事务 scope PG 反证。

## D. Strategy + Demo（Wave 1）

- [x] `0024_platform_demo_execution.sql`。
- [x] 三卡 spot snapshot 与 runtime/follow/deployment/Hall 单一真源。
- [x] 每会员/卡独立 10,000 USDT paper 组合；客户不需要 exchange account。
- [x] paper trades/history、七阶段/traceId/decisionRoundId、到期停止新开仓。
- [x] OKX Demo、Binance Spot Testnet、Bybit Demo allowlist/signature/receipt adapters。
- [x] 确定性 clientOrderId、10/100 USDT 限额、provider/card kill switch。
- [x] 全链路反证无 perpetual/leverage/short/funding/customer secret/live endpoint。

## E. Client（Wave 2）

- [x] `/`、`/login`、`/membership`、`/membership/orders`、`/credits`、`/paper`、`/paper/[portfolioId]`、`/trading-hall`、钱包、充值说明和通知均为稳定路由；`/workspace` 按需加载保留的策略/Agent/回测工作区。
- [x] 四计划、会员订单、credits 安全视图与可读七正文 Gate；真实法务正文仍为外部 Gate。
- [x] 三 paper 组合、服务端交易历史和七阶段已接；Client 暂不伪造平台 Demo 回执，公开回执 API 仍待产品决定。
- [x] 钱包只读；充值 Route 在 Proxy 禁用且页面无创建；假地址/二维码/倒计时/监听已移除。
- [x] Telegram/WhatsApp `not_integrated`；channels Route 在 Proxy 禁用，无演示验证码。
- [x] 320/768/1024/1440 浏览器验证通过；通知对比度、Maintenance Worker 卡片溢出、键盘入口、axe 与 console/network 均纳入可重复 Gate。

## F. Operations / Maintenance（Wave 2）

- [x] Ops 邀请一次性设置密码、会员订单、脱敏凭证、四阶段人员分离、credits 只读和周分成工作台。
- [x] 商业列表服务端 pagination/URL/data scope；所有 mutation 在业务事务内再次授权。
- [x] Maintenance Demo 安全视图、Worker 健康、模型/Email/支付/RBAC；`/audit` 已覆盖 Demo 控制/验证安全投影。
- [x] UI 区分 configured/enabled/alive/healthy/stale；支付有效状态始终 disabled。
- [x] Client 社区策略/永续研究/客户密钥/旧模拟订单已通过中央 Beta policy 禁用；`0029` 与 Runtime/Research Worker 又终结存量永续部署和任务，并从租约/处理器二次拒绝。完整技术审计聚合与其他旧分析进入 GA backlog。

## G. 质量、部署与 Gate

- [x] Wave 1/2 独立反证审查通过；当前集成树 517/517 测试、203 个 API method inventory、TypeScript/Lint 与迁移定向门禁已通过。
- [x] Playwright 四身份 + 一次性 PG schema + axe + 320/768/1024/1440 + console/network zero；8/8 场景通过且临时 schema/凭证已清理。
- [x] Client/Ops/Maint bundle 隔离；MFA 收口后的重建证据为 Client 185,316/8,012 bytes、Operations 202,095/8,012 bytes、Maintenance 196,000/8,012 bytes，三端均低于 200/50KB JS/CSS gzip 预算，首屏图不超过 200KB。
- [-] CSP nonce、security headers和生产依赖 high/critical=0 已验证；最终 secret scan 与开发工具链例外退出仍待交付前复核。
- [-] 三端 production build、Host/audience smoke、migration fresh/N-1/rerun 已通过；并发部署与备份恢复演练仍待 staging。
- [-] 已完成独立最小 env 示例、Demo Worker unit、旧 Web/Payment unit 与重复 Nginx 配置清理；DB roles 与回滚演练待 staging。
- [!] 法务七项、Email 外部依赖、Demo staging 凭证、DNS/TLS、支持/值班未提供前不得付费上线。
- [!] 不执行生产迁移、真实支付、客户充值、真实交易、真实退款或未授权外部变更。

## H. 最终提交与推送

- [x] 所有 Wave 经独立质量/反证审查并 `merge --no-ff`；最终 MFA/本地验收增量正在做末轮复核。
- [ ] 全量自动 Gate 与真实浏览器验收通过，三端本地启动。
- [ ] 生成四类一次性验收账号；密码不进入 Git、文档或长期聊天。
- [ ] 核对 status/branch/remotes/SSH/secret/backup/log/fixture。
- [ ] 展示最终 push 命令并等待用户确认；只推集成分支。
