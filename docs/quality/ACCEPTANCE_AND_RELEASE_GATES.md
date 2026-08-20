# Riverton Capital 付费 Beta 验收与发布门禁

状态：强制 Gate；任何否决项不得豁免为“先上线再修”

## 1. Gate 0：合同、法务与范围

- PRD、七智能体合同、System/三端 Spec、API Catalog/OpenAPI、ADR 和 Runbook 经责任角色评审。
- 四计划、三卡、paper 10,000/card、Demo/paper 分离、credits 和周分成只有一个版本化合同真源。
- 服务主体、地区、隐私、条款、风险披露、模拟收益分成法律意见和退款规则在 D3 前定稿并可访问。
- 社区策略、自动支付、客户充值/密钥、真实交易和退款被 feature gate/代码硬关闭。

## 2. Gate 1：身份、Audience 与 API Policy

- 三 audience 登录/Cookie/退出/安全 next 隔离；错误 Host/page/API 404。
- Operations/Maintenance 无注册/找回入口，强制 TOTP/recovery；critical 操作 recent MFA ≤15 分钟。
- Argon2id 新 hash、旧 PBKDF2 lazy rehash、dummy verify、共享限流、密码/冻结/撤权 session revoke 通过攻击测试。
- HTTP bootstrap 生产 404；CLI 只在无内部管理员时一次成功。
- 全 route/method API Policy inventory 零遗漏；未登记默认拒绝。
- 内部无 assignment 不回退 legacy；revoke tombstone、organization-set/team/direct-report scope 通过 PostgreSQL 集成矩阵。
- Origin/CSRF、strict body schema/limit、requestId、统一错误和敏感幂等验证完成。

## 3. Gate 2：账本、会员和 Credits

- 账本同币种借贷平衡、append-only、reversal、来源幂等、CAS、并发和 DB privilege 测试通过。
- trial→order→evidence→maker submit→different checker→entitlement/credits/ledger/outbox/audit 一事务完成。
- 四档计划逐字段等于 v1 snapshot；历史订单不受后续计划变化影响。
- credits grant/reserve/settle/release 不能负数；无费率/usage 拒绝付费请求。
- 自审、重复 evidence/decision/idempotency、并发和 stale version 不重复激活/发放。
- Client 无地址、二维码、倒计时、监听、充值或假支付成功。

## 4. Gate 3：七智能体、Paper 与 Demo

- contract→follow/deployment→runtime→Hall 使用同一 snapshot/hash；逐字段无 perpetual/leverage/short/funding/customer key。
- 每用户三卡恰好三个 10,000 USDT 组合，现金/持仓/成交/费用/风险互不影响。
- 七事件顺序、decisionRoundId/traceId、完整/partial、未成交原因和失败安全可重放。
- paper trades/history 来自服务器 API；不再固定空数组或 fallback 业绩。
- Demo intent/receipt 与 paper trade 分表/状态/UI；Demo 失败不改变 paper。
- OKX/Binance/Bybit allowlist、signature、clock skew、query-after-timeout、确定性 clientOrderId、10/100 限额和 kill switch 通过 fixture 测试。
- 真实订单/提现/划转/杠杆/衍生品 endpoint 不可达；真实 Demo smoke 仅 staging 显式授权。

## 5. Gate 4：周分成与 Operations

- 只对上一完整 UTC 周、三卡已平仓 paper 净收益、模拟手续费、高水位和亏损结转计算。
- 有已审批未支付账单时不生成重叠账单；业务审批只形成应收。
- 独立付款凭证/复核后才 paid 并提交高水位；重复/并发准确一次。
- 客户/组织/会员/credits/分成/账本列表、详情、计数使用相同 scope 和 PII policy。
- 邀请不返回临时密码；审批人看不到自审按钮，服务端仍阻断。
- 未完成旧策略市场/自动结算/团队分析菜单隐藏并进入 GA backlog。

## 6. Gate 5：Maintenance、外部服务与可观测性

- 模型/Email/Demo/支付响应和 UI 不含 secret、密文引用、完整 endpoint 或 raw webhook。
- Worker 从数据库 heartbeat 推导 configured/enabled/alive/healthy/stale；停止后 60 秒内 stale。
- public live/ready 不泄露内部配置；详细诊断需要 Maintenance permission。
- Email domain/key/webhook/template/suppression/retention/allowlist 全部完成并获授权，否则 `configured_not_sent`。
- Telegram/WhatsApp `not_integrated` 且无验证码；Payment 永远 disabled。
- JSON 日志/requestId/traceId/关键指标/告警/runbook 可用且无 secret/完整 PII。

## 7. Gate 6：前端、浏览器、性能与 CI

使用一次性 PostgreSQL schema 和四个隔离 storageState：Client、Ops maker、Ops checker、Maint admin。

- Playwright 完整覆盖邀请、MFA、法务、trial、会员复核、credits、三 paper、七阶段、Demo 证据、通知、周分成、到期与权限失败路径。
- 320/768/1024/1440 无非预期横向溢出；axe critical/serious=0；Tab/Shift+Tab/Escape/focus return 通过。
- console error/warning=0；失败上传 trace/video/screenshot/network 摘要。
- 三端 production build/Host smoke；Client 不含内部 chunk，内部端不含交易大厅/会员资源。
- 初始 JS ≤200KB gzip、CSS ≤50KB gzip、首屏图 ≤200KB；LCP≤2.5s、CLS≤0.1、TBT≤200ms。
- 生产依赖 high/critical=0；例外必须有 owner、风险接受与截止日。

## 8. Gate 7：迁移、恢复与部署

- migration fresh、N-1、rerun、checksum mismatch、concurrent、backup restore 通过。
- 已部署 registry 的每条记录必须有可验证 checksum；NULL/历史不明记录必须先做受控 reconciliation，禁止静默采用当前文件 hash。
- 三端/Workers/migrator 使用独立最小 env 与 DB roles；Payment Worker 无业务写权限。
- systemd/nginx 校验通过，无旧 Web unit、重复 3000 端口或重复 server name。
- current/previous 原子部署，应用回滚演练 <5 分钟；DB expand/contract 前向兼容。
- staging Demo 凭证、Email 外部依赖、DNS/TLS、支持联系人和告警值班就绪。

## 9. 自动命令

```text
npm test
npx tsc --noEmit
npm run lint
npm run test:apps
git diff --check
```

新增脚本必须覆盖 PostgreSQL integration、安全、migration、Playwright/axe、bundle budget、Lighthouse、三端 production smoke 和 secret scan。CI 不访问真实 Email/payment/live trade；Demo fixture 默认净化。

## 10. 绝对否决项

- 法务七项或目标服务地区未定稿。
- API inventory 有遗漏，或跨 audience/revoke/scope/PII/secret/临时密码测试失败。
- entitlement、credits、高水位出现重复或部分副作用。
- UI 存在假地址、二维码、验证码、连接、成交、成功或 Worker 状态。
- `local-demo` 在 UI 被称为真实 provider；真实订单、支付、充值、退款或提现接口可达。
- fresh migration、restore、三端 production smoke、关键 E2E、性能/安全预算失败。
- Email/Demo/DNS/TLS/支持/值班等外部依赖不就绪。

## 11. 证据包与测试账号

每个 Gate 保存 commit、迁移版本/checksum、命令输出、PG 测试摘要、浏览器 trace/截图、console/network、性能、安全扫描、外部依赖状态、已知限制、审批角色和回滚记录。四身份账号使用一次性密码，通过临时安全渠道交付；密码不得进入 Git、文档或长期聊天。
