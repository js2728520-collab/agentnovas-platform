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
- [x] TOTP/recovery/recent MFA 与内部 session TTL。
- [x] CLI-only bootstrap、一次性 set-password；后端不再返回或保存明文临时密码。
- [x] 显式 assignment、revoke tombstone、organization-set/team/direct-report scope。
- [x] 197 个 route method inventory 零遗漏；核心 audience/scope PostgreSQL 反证通过。

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

- [ ] 稳定 App Router 页面、audience chunk/CSS 分包和共享请求错误合同。
- [ ] 法务同意、四计划 API、会员订单、credits。
- [ ] 三 paper 组合、真实订单历史、七阶段与独立 Demo 证据。
- [ ] 钱包只读；充值页关闭创建；移除假地址/二维码/倒计时/监听。
- [ ] Telegram/WhatsApp `not_integrated`；无演示验证码。
- [ ] 320/768/1024/1440、键盘/焦点、loading/error/not-found。

## F. Operations / Maintenance（Wave 2）

- [ ] Ops 客户/邀请一次性设置密码、会员订单、凭证、双审、credits、周分成。
- [ ] Ops 列表服务端 pagination/URL/data scope，审批后准确刷新。
- [ ] Maintenance Demo 账户安全视图、worker/queue、模型/Email/支付/RBAC/技术审计。
- [ ] UI 区分 configured/enabled/alive/healthy/stale；支付始终 disabled。
- [ ] 未达生产合同的旧策略市场/自动结算/团队分析菜单隐藏。

## G. 质量、部署与 Gate

- [x] Wave 1 独立反证审查通过：471/471 测试、197 个 API method inventory、TypeScript、Lint（0 error）、三端 production build 和 `git diff --check` 全绿。
- [ ] Playwright 四身份 + 一次性 PG schema + axe + 四断点 + console zero。
- [ ] Client/Ops/Maint bundle 隔离；JS ≤200KB gzip、CSS ≤50KB、首屏图 ≤200KB。
- [ ] CSP nonce、security headers、secret scan、依赖 high/critical=0。
- [ ] 三端 production Host smoke、migration fresh/N-1/rerun/concurrent/restore。
- [-] 已完成独立最小 env 示例、Demo Worker unit、旧 Web/Payment unit 与重复 Nginx 配置清理；DB roles 与回滚演练待 staging。
- [!] 法务七项、Email 外部依赖、Demo staging 凭证、DNS/TLS、支持/值班未提供前不得付费上线。
- [!] 不执行生产迁移、真实支付、客户充值、真实交易、真实退款或未授权外部变更。

## H. 最终提交与推送

- [ ] 所有 Wave 经独立质量/反证审查并 `merge --no-ff`。
- [ ] 全量自动 Gate 与真实浏览器验收通过，三端本地启动。
- [ ] 生成四类一次性验收账号；密码不进入 Git、文档或长期聊天。
- [ ] 核对 status/branch/remotes/SSH/secret/backup/log/fixture。
- [ ] 展示最终 push 命令并等待用户确认；只推集成分支。
