# Riverton Capital 14 天受邀付费 Beta 路线图

本路线图是时间盒，不是上线承诺。Gate 优先于日期；新增社区市场、自动支付、客户充值、真实交易和退款进入 Beta 后 backlog。

## Wave 1：D1–D8 后端纵向闭环

| 切片 | 时间 | 交付 | 退出条件 |
| --- | --- | --- | --- |
| 真源/迁移器 | D1–D2 | PRD/Spec/contracts/ADR、checksum migration runner | 合同唯一、迁移可重跑/并发拒绝 |
| API/身份 | D2–D4 | policy inventory、Argon2id、MFA、限流、scope、bootstrap/CSRF | 跨 audience/revoke/MFA 测试全绿 |
| 商业/账本 | D3–D7 | ledger invariants、会员、credits、分成、typed approval | 重复/并发无重复权益/计费 |
| Strategy/Demo | D3–D8 | spot snapshot、三 paper、三 provider adapter/worker | 无永续/客户密钥；paper/Demo 分离 |

## Wave 2：D5–D10 前端与运行收口

- Client：稳定路由、法务/会员/credits/三 paper/Hall/Demo/通知/真实历史；移除假支付与假验证。
- Operations：客户/邀请、会员凭证/双审、credits、分成、分页/scope/队列刷新。
- Maintenance：模型、Email、支付禁用态、Demo 账户、真实 Worker/queue、kill switch、技术审计。
- Foundation：audience import/lazy chunk、Client/Console CSS、a11y、请求取消/错误合同、CSP。
- Observability/Deploy：heartbeat、requestId/traceId、指标告警、最小 env/DB role、清理旧 unit。

## Integration：D9–D11

合并顺序：API Security → Commercial → Strategy Demo → UI Foundation → Client/Internal → Quality/Deploy。每次 `merge --no-ff` 后跑 type/lint/相关测试/diff check；共享 contracts、package/lock、route dispatcher、CI 只有单一 owner。

## Validation：D11–D13

- 一次性 PostgreSQL staging：fresh/N-1/rerun/concurrent/restore。
- 四身份 Playwright + axe + 四断点 + console/network。
- 三端 clean production build/Host smoke/bundle/Lighthouse。
- staging Demo 与 Email allowlist 只在凭证/域名/Webhook/外部授权就绪后执行。
- D13 两名内部 canary 完成邀请到到期/分成演练和发布评审。

## Release：D14

只有法务、外部依赖和全部技术 Gate 通过才开放 5–20 名受邀客户。首小时强化监控邀请/会员/paper/Demo/Email/credits/分成、5xx/p95、Worker stale 和安全拒绝。任一绝对否决项触发停止新增邀请并按 runbook 回退。

## GA Backlog

- Passkey/WebAuthn、审计 tamper evidence、DB RLS/更细角色、唯一迁移/schema 兼容层淘汰。
- 客户/组织/团队/财务完整旧后台迁移，模型回滚/数据集成/统一技术审计。
- Client 单体和 i18n 深度重构、RUM/SLO、通知更多渠道。
- 社区策略治理/作者分润、自动支付/退款/对账。
- 客户本地真实现货执行作为独立合规、安全、凭证与 go-live 项目；永续另立项。
