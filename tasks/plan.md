# Riverton Capital 14 天商业 Beta 实施计划

状态：执行中
集成分支：`codex/three-app-riverton-split`
起点：`0762fa3`
目标：5–20 名受邀付费 Beta；未通过 Gate 不开放

## 1. 锁定范围

- 三应用一库，audience 隔离登录、Cookie、路由、RBAC、data scope、env 和部署。
- 三张官方 spot 策略；每用户/卡片独立 10,000 USDT paper 组合。
- 平台 OKX Demo、Binance Spot Testnet、Bybit Demo 证据与客户 paper 完全分离。
- 四档会员 v1、人工付款 maker-checker、AI credits、UTC 周 paper 盈利分成与高水位。
- in-app + 真实 Email；Telegram/WhatsApp 不接入。
- 真实支付、客户充值、客户密钥、真实现货/永续、提现、退款和生产迁移硬关闭。

## 2. 真源顺序

1. `docs/product/PRD.md`
2. `docs/product/SEVEN_AGENT_TRADING_HALL.md`
3. `packages/contracts/src/commercial-beta.ts` 与策略 snapshot
4. `docs/specs/SYSTEM_SPEC.md` 与三端 Spec
5. ADR、API Catalog/OpenAPI、Acceptance/Release Gates、Runbooks
6. `tasks/todo.md` 当前证据

附件《七智能体动态策略系统_用户说明书》是产品参考；仓库版本化合同是实现真源。历史 handoff 或页面常量不能覆盖上述顺序。

## 3. Git 与 Agent 边界

- 集成分支是唯一最终推送分支；子分支只本地存在。
- 禁止 rebase/amend/reset/force push/历史重写；普通 `merge --no-ff`。
- 主 Agent 独占 package/lock、公共 contracts、路由分发、CI、docs、合并与发布基线。
- Wave 1 分支：`codex/beta-api-security`、`codex/beta-membership-ops`、`codex/beta-strategy-demo`。
- Wave 2 分支：`codex/beta-client-experience`、`codex/beta-internal-consoles`、`codex/beta-quality-release`。
- 合并前：TDD 证据、质量审查、独立反证；合并顺序为 Security → Commercial → Strategy → UI Foundation/Client/Internal → Quality/Deploy。

## 4. 里程碑

| 日期 | 必须形成的可验证交付 |
| --- | --- |
| D1 | PRD/Spec/七智能体/商业合同/权限/迁移编号冻结，worktree 建立 |
| D2–D4 | API Policy、Argon2id、MFA、限流、audience、安全迁移器、账本/审批原子性 |
| D3–D7 | 会员订单、付款凭证、entitlement、credits、法务同意、周分成 |
| D3–D8 | spot 合同统一、三 paper 组合、三 provider Demo adapter/worker |
| D5–D9 | Client/Operations/Maintenance 稳定路由与真实状态 UI |
| D7–D10 | Worker heartbeat、日志指标、env/DB role 隔离、CI 与运行手册 |
| D9–D11 | Wave 合并、全量回归、bundle/CSS/图片性能收口 |
| D11–D12 | 一次性 PostgreSQL staging、Demo smoke、Email allowlist、恢复演练（需授权） |
| D13 | 四身份内部 canary 和发布评审 |
| D14 | Gate 通过后开放 5–20 名受邀客户 |

## 5. 开发顺序与串行依赖

1. 产品/法务边界与公共合同冻结。
2. 迁移器真源、advisory lock 和 checksum。
3. API Policy、显式 assignment scope 与身份安全。
4. 账本约束和 typed approval adapters。
5. 会员/credits/分成事务。
6. spot paper runtime 与 Demo 证据。
7. 三端 UI 和真实状态。
8. E2E、性能、部署和恢复证据。

不得在账本/审批之前启用商业权益副作用，不得在签名/幂等/限额/熔断/heartbeat 之前运行 staging Demo，不得因 env flag 存在而宣称外部能力已启用。

## 6. 每次集成验证

```text
npm test
npx tsc --noEmit
npm run lint
npm run test:apps
git diff --check
```

最终增加 PostgreSQL 集成、安全、策略全链路、adapter、migration、四身份 Playwright、axe、四断点截图、bundle budget、Lighthouse、三端 production Host smoke 和 secret scan。

## 7. 外部 Gate

法务主体/地区/隐私/条款/风险披露/模拟收益分成意见/退款规则、平台 Demo 凭证、Email 域名/Webhook/allowlist、DNS/TLS、支持联系人和告警值班均由团队提供。缺任一项时工程可继续验证，但付费 Beta Gate 失败。

## 8. 推送规则

完成并清除 secret/backup/log/fixture 风险后，核对分支、remotes 和 `ssh -T git@github-js2728520`。只展示：

```bash
git push origin codex/three-app-riverton-split
```

等待用户明确确认后执行，不推子分支，不 force push。
