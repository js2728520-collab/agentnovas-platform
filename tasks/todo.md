# Riverton Capital 商用 Paper SaaS 进度清单

状态：`[x]` 已有实现和证据；`[-]` 当前切片；`[ ]` 未完成；`[!]` 仅缺真实外部配置且产品安全降级可用。

## 0. 已完成基线

- [x] 三应用一库 audience/Cookie/路由/RBAC/data scope 隔离。
- [x] 中央 API Policy、Argon2id、TOTP/recovery、recent MFA、显式 assignment 和撤权 tombstone。
- [x] 四档会员、人工凭证双审、权益、Credits 核心账本、UTC 周 Paper 分成与高水位。
- [x] 三张官方 spot 卡、每卡 10,000 USDT Paper、七阶段决策链和真实 Paper trade history。
- [x] OKX Demo/Binance Spot Testnet/Bybit Demo allowlist、签名、幂等、限额、kill switch 与 Worker。
- [x] Client 核心商业页面、Operations 会员/分成、Maintenance Demo/健康、12 项四身份生产浏览器 Gate。
- [x] 真实交易、客户密钥、提现/划转、自动扣款/退款、社区市场和 legacy 永续运行时硬关闭；客户充值仅开放优盾 deposit-only。

## 1. 商业合同、试用与账号

- [x] 1.1 迁移 `0030_commercial_disclosure_trial.sql`：平台产品身份、披露草稿/发布决定、试用与到期事件约束。
- [x] 1.2 商业披露 service/API：草稿、预览、maker submit、checker publish、active bundle、历史和审计。
- [x] 1.3 Maintenance 商业披露/产品身份/readiness UI；不允许虚构主体、地区或支持渠道。
- [x] 1.4 Client/API 将 legal wording 收敛为商业披露接受；新版本重新确认、旧版本证据保留。
- [x] 1.5 邀请接受、3 天试用、到期停止新开仓、会员到期只读与通知闭环。
- [x] 1.6 账号安全页：资料、改密、MFA/recovery 状态、恢复码轮换、会话列表与撤销。
- [x] 1.7 支持与公告页；仅显示真实已配置渠道。

## 2. Operations 客户、组织与团队

- [x] 2.1 客户详情聚合：身份/组织/归属、会员、Credits、Paper、订单、应收、冻结状态。
- [x] 2.2 客户备注历史、冻结/恢复、归档/恢复和相关 session/能力撤销。
- [x] 2.3 客户归属转移 maker-checker、有效期和审计。
- [x] 2.4 组织树、成员、邀请、激活/停用、汇报关系修改和组织范围验证。
- [x] 2.5 每日简报、月目标、跟进记录、服务端分页/筛选和受控 CSV 导出。
- [x] 2.6 数据中心真实指标与 drill-down；移除 legacy 静态/跨 scope 统计。

## 3. Operations Credits、财务与审批

- [x] 3.1 迁移 `0031_credit_adjustment_workflow.sql`：调整申请/决定/幂等/人员分离。
- [x] 3.2 Credits 调整 maker/checker service/API；不可为负、同事务 ledger/outbox/audit。
- [x] 3.3 Operations Credits 调整 UI 与客户 Credits 不可变分录详情。
- [x] 3.4 商业财务收敛到会员订单、Paper 周分成和不可变账本；legacy settlements/collections/payout/adjustment 写接口由 API Policy 硬关闭。
- [x] 3.5 统一审批 inbox 投影会员、分成、Credits、RBAC、归属、汇报关系和充值历史请求；无自审按钮。
- [x] 3.6 官方三卡业务影响只读视图；社区治理保持 disabled 并从菜单清除。

## 4. Maintenance 控制面

- [x] 4.1 模型 Profile 版本、验证、Agent 绑定和回滚；secret 永不回显。
- [x] 4.2 数据/新闻集成目录、配置/启用/健康/陈旧状态和安全测试回执。
- [x] 4.3 Demo provider/card 控制、限额、验证与安全回执全量 UI。
- [x] 4.4 Worker/API/DB/Email/Demo 统一技术审计、requestId/traceId、游标与筛选。
- [x] 4.5 平台公告、支持、Email allowlist、商业 readiness 和紧急停控统一设置。
- [x] 4.6 public/internal health 与 metrics/SLO 文档和告警阈值。

## 5. Client 完整旅程

- [x] 5.1 邀请 → 登录 → 披露接受 → 试用/购买 → 订单追踪完整引导与待办。
- [x] 5.2 首页真实试用、会员、Credits、三卡 Paper、账单和通知摘要。
- [x] 5.3 Paper 详情接入平台 Demo 安全摘要 API/UI，明确不代表客户成交。
- [x] 5.4 独立绩效账单详情与状态时间线。
- [x] 5.5 账号安全、支持、公告和通知偏好完整页面。
- [x] 5.6 遗留永续/客户交易所/假状态/静态 KPI/不可达入口与无用资源最终清理；仅保留硬关闭的历史兼容代码和测试合同，不进入当前菜单或可执行 API。

## 6. 质量、恢复与发布

- [x] 6.1 新增切片的 unit/contract/PostgreSQL/security/rollback 测试；233 个 method handler inventory 零遗漏。
- [x] 6.2 CI quality-release job：三端 build、Playwright/axe、bundle/Lighthouse、audit、secret scan。
- [x] 6.3 migration concurrent、独立 DB roles、43 迁移/139 表备份恢复和应用回滚本地隔离演练；恢复前后 registry checksum、表集合和逐表行数一致，临时数据库已清理。
- [x] 6.4 四身份 12 场景真实浏览器覆盖商业双审、三端稳定路由、权限失败、响应式、axe、console/network 与焦点入口。
- [x] 6.5 PRD/Spec/ADR/能力矩阵/API/OpenAPI/Gate/Runbook/handoff/发布证据同步。
- [x] 6.6 全量自动 Gate、代码质量审查、独立反证审查、production dependency high/critical=0；开发工具链例外见质量证据，截止首批付费邀请前。
- [x] 6.7 Client Web/Auth 双数据库角色无身份/邀请表直访、不可互调高权限 gateway，过期 session 无法调用 self gateway；URL 角色与运行时 `current_user` 双校验。
- [!] 6.8 Email、Demo、DNS/TLS 没有真实凭证时保持明确未配置；提供真实配置后执行 staging smoke。

## 7. 最终提交、启动与推送

- [x] 7.1 检查 status/branch/remotes/SSH 与 `.env`/secret/password/private key/dump/log/fixture；`origin`/目标 SSH 账号正确，`github-old` 保留，仓库 secret scan 零发现。
- [x] 7.2 已创建普通提交且未改写历史；三端在 3100/3101/3102 运行，一次性验收账号仅保存在仓库外权限 0600 的临时文件。
- [x] 7.3 上一轮完整代码与文档已推送；目标远端 `main` 与本地 `4fea508` 对齐。

## 8. 最终收口与版本管理

- [x] 8.1 修复远端 built runtime smoke 的 audience 随机端口映射，恢复 CI quality-release 执行。
- [x] 8.2 冻结版本管理 Spec、权限、不可变状态机、API 与数据库隔离合同。
- [x] 8.3 增加迁移 `0041_release_version_management.sql`、service、API、contracts 与回归测试。
- [x] 8.4 增加 Maintenance `/releases` 页面、权限导航、敏感操作确认和真实状态呈现。
- [x] 8.5 同步 OpenAPI、API Catalog、ADR、Runbook、CHANGELOG、handoff 与发布 Gate。
- [x] 8.6 执行全量自动 Gate、secret/audit/build/browser/恢复证据并完成独立发布反证审查。
- [x] 8.7 普通提交并推送目标远端 `main`，确认远端 CI 全绿；不改写历史、不 force push。

## 9. 优盾 Client 充值通道

- [x] 9.1 冻结 deposit-only ADR、威胁模型、API/状态与运行时配置边界。
- [x] 9.2 增加迁移 `0042_udun_deposit_gateway.sql`、安全视图、独立 webhook DB role、事件/nonce/地址幂等约束。
- [x] 9.3 实现地址生成、固定 Udun HTTPS allowlist、原始 body 验签、时效和回调 evidence。
- [x] 9.4 实现 Operations maker/checker `APPROVE_CREDIT` 原子账本入账与 Client 真实订单 UI。
- [x] 9.5 实现 Maintenance 币种映射、连通测试、启停和密钥安全投影。
- [x] 9.6 同步 OpenAPI/Spec/Runbook，执行全量 Gate、密钥扫描、普通提交并推送目标远端 `main`。
- [!] 9.7 目标商户真实商户号/API Key/专属节点/币种编号需从优盾后台注入后，执行 staging 1 USDT smoke；仓库不保存这些值。
