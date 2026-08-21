# Riverton Capital 商用 Paper SaaS 进度清单

状态：`[x]` 已有实现和证据；`[-]` 当前切片；`[ ]` 未完成；`[!]` 仅缺真实外部配置且产品安全降级可用。

## 0. 已完成基线

- [x] 三应用一库 audience/Cookie/路由/RBAC/data scope 隔离。
- [x] 中央 API Policy、Argon2id、TOTP/recovery、recent MFA、显式 assignment 和撤权 tombstone。
- [x] 四档会员、人工凭证双审、权益、Credits 核心账本、UTC 周 Paper 分成与高水位。
- [x] 三张官方 spot 卡、每卡 10,000 USDT Paper、七阶段决策链和真实 Paper trade history。
- [x] OKX Demo/Binance Spot Testnet/Bybit Demo allowlist、签名、幂等、限额、kill switch 与 Worker。
- [x] Client 核心商业页面、Operations 会员/分成、Maintenance Demo/健康、12 项四身份生产浏览器 Gate。
- [x] 真实交易、客户充值、客户密钥、自动支付/退款、社区市场和 legacy 永续运行时硬关闭。

## 1. 商业合同、试用与账号

- [x] 1.1 迁移 `0030_commercial_disclosure_trial.sql`：平台产品身份、披露草稿/发布决定、试用与到期事件约束。
- [x] 1.2 商业披露 service/API：草稿、预览、maker submit、checker publish、active bundle、历史和审计。
- [x] 1.3 Maintenance 商业披露/产品身份/readiness UI；不允许虚构主体、地区或支持渠道。
- [x] 1.4 Client/API 将 legal wording 收敛为商业披露接受；新版本重新确认、旧版本证据保留。
- [x] 1.5 邀请接受、3 天试用、到期停止新开仓、会员到期只读与通知闭环。
- [x] 1.6 账号安全页：资料、改密、MFA/recovery 状态、恢复码轮换、会话列表与撤销。
- [x] 1.7 支持与公告页；仅显示真实已配置渠道。

## 2. Operations 客户、组织与团队

- [ ] 2.1 客户详情聚合：身份/组织/归属、会员、Credits、Paper、订单、应收、冻结状态。
- [ ] 2.2 客户备注历史、冻结/恢复、归档/恢复和相关 session/能力撤销。
- [ ] 2.3 客户归属转移 maker-checker、有效期和审计。
- [ ] 2.4 组织树、成员、邀请、激活/停用、汇报关系修改和组织范围验证。
- [ ] 2.5 每日简报、月目标、跟进记录、服务端分页/筛选和受控 CSV 导出。
- [ ] 2.6 数据中心真实指标与 drill-down；移除 legacy 静态/跨 scope 统计。

## 3. Operations Credits、财务与审批

- [ ] 3.1 迁移 `0031_credit_adjustment_workflow.sql`：调整申请/决定/幂等/人员分离。
- [ ] 3.2 Credits 调整 maker/checker service/API；不可为负、同事务 ledger/outbox/audit。
- [ ] 3.3 Operations Credits 调整 UI 与客户 Credits 不可变分录详情。
- [ ] 3.4 财务 settlements/collections/payout profiles/adjustments 接入新 RBAC、scope、游标和准确状态。
- [ ] 3.5 统一审批 inbox 投影会员、分成、Credits、RBAC、归属、充值历史请求；无自审按钮。
- [ ] 3.6 官方策略业务影响只读视图；社区治理保持 disabled 并从菜单清除。

## 4. Maintenance 控制面

- [ ] 4.1 模型 Profile 版本、验证、Agent 绑定和回滚；secret 永不回显。
- [ ] 4.2 数据/新闻集成目录、配置/启用/健康/陈旧状态和安全测试回执。
- [ ] 4.3 Demo provider/card 控制、限额、验证与安全回执全量 UI。
- [ ] 4.4 Worker/API/DB/Email/Demo 统一技术审计、requestId/traceId、游标与筛选。
- [ ] 4.5 平台公告、支持、Email allowlist、商业 readiness 和紧急停控统一设置。
- [ ] 4.6 public/internal health 与 metrics/SLO 文档和告警阈值。

## 5. Client 完整旅程

- [ ] 5.1 邀请 → 登录 → 披露接受 → 试用/购买 → 订单追踪完整引导与待办。
- [ ] 5.2 首页真实试用、会员、Credits、三卡 Paper、账单和通知摘要。
- [ ] 5.3 Paper 详情接入平台 Demo 安全摘要 API/UI，明确不代表客户成交。
- [ ] 5.4 独立绩效账单详情与状态时间线。
- [ ] 5.5 账号安全、支持、公告和通知偏好完整页面。
- [ ] 5.6 遗留永续/客户交易所/假状态/静态 KPI/不可达入口与无用资源最终清理。

## 6. 质量、恢复与发布

- [ ] 6.1 新增切片的 unit/contract/PostgreSQL/security/rollback 测试；API inventory 零遗漏。
- [ ] 6.2 CI quality-release job：三端 build、Playwright/axe、bundle/Lighthouse、audit、secret scan。
- [ ] 6.3 migration concurrent、独立 DB roles、备份/恢复、应用回滚本地隔离演练。
- [ ] 6.4 四身份真实浏览器覆盖试用、到期、双审、七阶段、Demo failure、恢复码消费与焦点回收。
- [ ] 6.5 PRD/Spec/ADR/能力矩阵/API/OpenAPI/Gate/Runbook/handoff/发布证据同步。
- [ ] 6.6 全量自动 Gate、代码质量审查、独立反证审查、production dependency high/critical=0。
- [!] 6.7 Email、Demo、DNS/TLS 没有真实凭证时保持明确未配置；提供真实配置后执行 staging smoke。

## 7. 最终提交、启动与推送

- [ ] 7.1 检查 status/branch/remotes/SSH 与 `.env`/secret/password/private key/dump/log/fixture。
- [ ] 7.2 创建普通提交，不改写历史；启动 Client/Ops/Maint 三端并生成仓库外一次性验收账号。
- [ ] 7.3 展示最终 push 命令并等待确认；只推 `codex/three-app-riverton-split`。
