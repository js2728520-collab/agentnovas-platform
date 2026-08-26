# AgentNovas Platform 系统评估（商业 Beta 基线）

> 文档状态：`HISTORICAL`。这是 2026-08-20 的基线快照；V3 当前准备度见 [`FULL_PLATFORM_V3_READINESS_2026-08-23.md`](FULL_PLATFORM_V3_READINESS_2026-08-23.md)。

评估日期：2026-08-20
评估基线：`codex/three-app-riverton-split`，起点 `0762fa3`；后续实施状态见 `tasks/todo.md`
起点结论：`0762fa3` 仅可用于内部演示和工程验证，商业化总体完整度约 30–35%；这不是当前集成树结论。

## 0. 2026-08-21 实施更新

本文件第 1–5 节保留起点 `0762fa3` 的审计快照，用于解释为何启动收口，不代表当前树仍有相同缺陷。当前集成树已完成：233 个 method handler 的 fail-closed inventory、未知 Host 拒绝、显式内部 RBAC/MFA/Argon2id、迁移 checksum/advisory lock、商业账本/会员/credits/周分成、官方 spot paper、三 provider Demo 安全边界、Worker heartbeat、Operations/Maintenance 商业工作台、不可变版本发布证据、Client 旧 Admin 物理移除、legacy 客户交易/充值接口中央禁用、独立可读商业披露确认 Gate 和 Demo 技术审计安全投影。

当前 Client 会员/credits/paper/交易大厅稳定路由已完成，三端初始 JS/CSS 在最终集成点通过 200/50KB gzip 预算；存量永续部署和研究任务已由 `0029` 终结，新 Runtime/Research 处理器也失败关闭。隔离 PostgreSQL 上的 12 场景 Playwright/axe/Host-Cookie 验收再次通过；本机恢复演练覆盖截至 `0043` 的 44 个迁移、139 张表，包含 `0041` 的不可变版本表、`0042` 的优盾 deposit-only 边界和 `0043` 的 Client 身份网关/FORCE RLS，恢复前后 registry checksum、表集合与逐表行数一致。新增、改名或 checksum 变化的迁移会使这份恢复证据立即失效，必须重跑而不能只更新数字。当前收口新增平台自维护的商业披露、平台 Profile + Credits 的可靠 usage 闭环、Maintenance 高风险命令持久化幂等、Client Web/Auth 双数据库角色能力网关、不可变发布证据、Client 完整旅程和恢复/质量要求；最终结论以 `tasks/todo.md` 与当前提交的 Gate 证据为准。Email/Demo/DNS/TLS 无配置时可以安全降级，但不能被记录为外部 smoke 已通过；目标环境还必须保留各实际进程 `current_user` 的脱敏角色 smoke，代码级角色测试不能替代部署证据。

## 1. 已有资产

- Next.js 三 audience、独立 Cookie、稳定内部路由与共享 Shell 已建立。
- PostgreSQL research/runtime 状态机、确定性回测、lease/fencing 和七事件基础较强。
- RBAC 具有应用、权限、scope、角色、assignment、敏感变更和审计基础。
- 充值人工申请、部分双审、只读账本、Resend 签名/幂等/乱序/outbox 具有可复用实现。
- Client 已有策略、Agent、回测、模拟盘、Hall、会员、钱包和通知页面；Operations/Maintenance 不是空壳。
- 当前 live order routing 硬关闭，这是必须保留的安全基础。

## 2. 代码与交付事实

| 指标 | 审计值 | 判断 |
| --- | ---: | --- |
| API route / handler | 约 131 / 174 | 大量 API 仍未中央策略化 |
| 直接使用新 access-control | 约 31 route | 覆盖不足 |
| 直接使用 legacy `requireUser/currentUser` | 约 50 route | 跨 audience/撤权风险 |
| Client 主文件 | 约 4,811 行 | 页面、状态和旧 Admin 高耦合 |
| 全局 CSS | 约 3,858 行 | 三端同包与重复样式 |
| `.test.mjs` | 61（审计时） | 多数含源码合同；无仓库化 Playwright/axe |
| 三端初始资产 | JS 约 334KB gzip；CSS 约 90.9KB | 三端相同，超过 200/50KB 预算 |
| 核心 OpenAPI | 约 13 path（审计时） | 远低于接口面 |

## 3. 能力矩阵

| 域 | 当前完整度 | 核心问题 |
| --- | ---: | --- |
| 三应用分发 | ~65% | 未知 Host 可能回 Client；API 未零遗漏隔离 |
| 身份安全 | ~25% | 旧 KDF、限流/MFA/bootstrap/临时密码 |
| RBAC | ~50% | legacy 自动回退；assignment scope 丢失 |
| Client 研究/回测 | 70–75% | 单体、浏览器证据、错误恢复 |
| 七智能体产品 | 45–50% | 公共 spot 合同与 perpetual runtime 错位 |
| 会员/收费 | 10–15% | 静态套餐、无真实订单/权益事务、假付款 UI |
| 钱包/充值 | 80–85% | 优盾地址、验签、双审与账本已闭环；仍缺目标商户 staging smoke |
| 通知 | 50–60% | Telegram/WhatsApp 假验证码；外发 Gate 不全 |
| Operations | 35–40% | 组织/商业审批/完整财务/策略治理未收口 |
| Maintenance | 35–40% | Demo、heartbeat/queue、技术审计不足 |
| 发布质量 | 40–45% | 无 Playwright/axe/LH/restore/SLO 证据 |

## 4. P0 风险

1. **跨 audience API**：合法 session 可能调用只校验 legacy role 的其他应用 API；三个构建又编译同一 API 面。
2. **撤权回退**：缺显式 published assignment 时用 `users.role` 恢复权限，删除最后 assignment 反而可能重新授权。
3. **scope 失真**：organization set/team/direct reports 没有完整携带 assignment 限制，列表和目标业务可能扩大数据范围。
4. **可持续 HTTP bootstrap**：secret 泄露即可重置高权管理员，不是一锤子买卖。
5. **身份基线**：旧 PBKDF2 轮数低、无共享登录/找回限流、内部 MFA/recent-MFA、全量 session revoke。
6. **临时秘密**：组织 UI/通知 payload/接口仍可能显示临时密码或验证 token。
7. **策略合同错位**：三卡公开合同为 spot，真实 follow/runtime 路径仍包含 USDT 永续、资金费率和客户 exchange account 要求；风险参数也有多真源。
8. **假商业状态**：会员页曾生成演示地址/二维码/倒计时/监听；通知渠道直接返回演示验证码；交易历史固定 `setOrders([])`。
9. **资金未闭环**：账本无唯一 posting service/DB 平衡与不可变保证；支付 Webhook 未真实验签，Payment Worker 只是 DB ping。
10. **审批并发/原子性**：旧通用审批 JSON 驱动多业务，缺目标行锁、同事务 exactly-once 和 typed adapter。
11. **迁移双真源**：历史迁移器重复执行文件，Postgres migrations 与 Drizzle/SQLite schema 权责并存。
12. **健康假象/信息泄露**：旧 Maintenance 只看 env，公开 health 暴露密钥/队列/开关；部署共用全量 env/DB role。
13. **前端三端同包**：server dispatcher 静态导入三端、layout 全量 CSS；Client 包可检索内部文案，影响隔离与性能。
14. **发布证据不足**：无可重复真实浏览器/axe/Lighthouse/恢复演练；单独推功能分支不触发 CI。

## 5. 额外安全与运营风险

- LLM 可配置任意 HTTPS endpoint，存在 SSRF/DNS rebinding/redirect 风险。
- 旧 route 可能把原始 `Error.message` 返回浏览器，JSON/body/schema/金额/日期治理不一致。
- 财务使用 JS Number/Postgres double 的部分路径不适合商业金额。
- 账本读取可能因一条命中 posting 返回交易全部 counterparty posting。
- 审计表未 append-only/tamper-evident，Webhook PII 保留与 complaint suppression 未定义。
- Client/Ops/Maint/Workers 共用 env 和数据库账户，单进程失陷可扩大影响。

## 6. 已开始的收口证据

- 版本化/校验和/advisory lock PostgreSQL 迁移器已独立提交。
- `@node-rs/argon2` 依赖已锁定并验证 Beta 参数。
- 四计划、paper、分成和 Demo provider 公共合同已冻结。
- `worker_instances`、四类 Worker heartbeat、public live/ready 与 Maintenance 真实诊断已实现并通过单测。

这些改动缩小风险，但不表示其他 P0 已完成；唯一进度见 `tasks/todo.md`。

## 7. 最短商业化路径

邀请→一次性设密/MFA→商业披露确认→3 天 trial→选择计划→外部人工付款→maker/checker→幂等 entitlement/credits→三张 paper→七阶段与独立 Demo 证据→in-app/Email→UTC 周分成应收/付款双审→到期只读。

选择该路径是因为它不接收客户交易所凭证，也不执行真实交易。客户充值后来通过 ADR-0015 限定为优盾 deposit-only；社区市场、提现/划转和真实交易仍进入 GA 后独立项目。

## 8. 评估结论

项目无需推倒重来，但不能再按“页面数量”判断完成。必须按可收费纵向切片推进：API/身份 → 账本/商业事务 → spot paper/Demo → 三端 UI → 浏览器/性能/部署 Gate。任何真实支付、真实 Email、Demo staging 或生产基础设施操作都需要外部依赖与明确授权。
