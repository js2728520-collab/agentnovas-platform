# Client 付费 Beta 应用规格

## 1. 目标与导航

Client 为受邀用户提供登录/设置密码、商业披露确认、试用与会员、AI credits、三张官方 paper 组合、七智能体记录、平台 Demo 证据、研究/回测、只读钱包和通知。保留多语言与 Riverton 深色视觉，不做无关改版。

稳定路由：`/`、`/login`、`/legal/consent`、`/membership`、`/membership/orders`、`/credits`、`/performance-statements`、`/performance-statements/[id]`、`/paper`、`/paper/[portfolioId]`、`/trading-hall`、`/wallet`、`/wallet/deposits`、`/notifications`、`/account/security`、`/support`；`/workspace` 是登录、披露和 `client.paper.view` 三重守卫后的策略/Agent 按需入口。普通客户不得看到旧 Admin/Ops/Maint 导航或代码文案。

实现状态（2026-08-21）：上述商业 Beta 路由已作为独立 App Router 入口落地，均使用 Client audience 会话和精确权限守卫。`/legal/consent` 允许所有已登录 Client 读取并独立保存当前七正文版本；未确认时页面路由和 Client permission API 同时返回 Gate，身份、权限启动、商业披露、支持与退出仍可用。`/` 是受邀商业首页；`/workspace` 仅按需加载保留的策略、Agent、回测和账户工作区，默认进入真实七阶段记录，不再把旧静态 KPI 营销页或该大型工作区加入商业首屏初始资产。

## 2. 身份与商业披露

- 仅邀请注册；邀请和找回链接单次使用、过期失效，不回显 token。
- 登录失败和找回结果不泄露邮箱是否存在。
- 首次使用和披露版本升级时必须先阅读产品身份、地区、隐私、条款、风险、Paper 收费和退款/不退款规则七份正文，再保存 document ID/version/hash/time、可信代理提供的请求 IP 与 user-agent 摘要。
- `0028_commercial_legal_content.sql` 与 `0030_commercial_disclosure_trial.sql` 提供版本化 locale/正文、maker-checker 发布和用户确认；七份正文任一缺失、长度异常或 SHA-256 不匹配时，计划、试用与订单服务同时失败关闭。
- 披露未发布或未确认时只允许身份、披露、支持和退出页面；不启动 trial、策略或会员订单。正文由平台 Maintenance 工作台维护，不等待仓库外部团队。

## 3. 会员与 credits

- 四档计划、价格、有效期、credits 和费率全部来自 `/api/membership/plans`。
- 订单只显示订单号、计划快照、人工付款指引和真实状态；绝不显示地址、二维码、倒计时或“监听链上”。
- 付款提交由 Operations 完成；Client 只能查看 awaiting_evidence/submitted/approved/activated/rejected/cancelled 等真实状态。
- Credits 显示可用、预留和不可变流水。付费 AI 请求显示预估、实际 usage、扣减/释放；余额不足或不可计量时不伪造结果。
- Client 不接受 BYOK、客户 API Key 或自定义模型端点。对话固定解析 Maintenance 发布的 `report` Profile，策略生成固定解析 `proposal_a` Profile；Client 数据库角色只能读取 `client_ai_runtime_model_bindings` 安全投影，不能读取模型配置基表。
- 每次付费 AI 写请求必须携带稳定 `Idempotency-Key`；服务端在调用供应商前以 `token-cost-v1` 预留 Credits，只接受供应商请求 ID 与 input/output token usage 均可靠的结果，成功后结算差额，失败后释放，重放不重复调用或扣费。

## 4. 三 paper 组合

- 每卡初始 10,000 USDT，现金/持仓/成交/费用/盈亏独立；三卡合计展示时明确是 30,000 USDT 模拟本金。
- 卡片参数来自统一策略 snapshot，客户不可编辑本金、风险预算或风控阈值。
- 订单历史从 paper trades API 分页读取，禁止固定空数组、浏览器造单或 fallback 业绩。
- 会员到期停止新开仓；有持仓时为 `close_only`，无持仓时为 `read_only`，页面展示服务器返回的真实状态。
- 所有收益标注 paper/模拟、样本区间和费用口径，不称真实投资收益。

## 5. 七智能体与 Demo 证据

交易大厅包括产品边界条、三张卡、七角色、决策轮列表/详情、paper 回执和独立 Demo 证据。角色/参数/事件顺序见 `../product/SEVEN_AGENT_TRADING_HALL.md`。

| 状态 | Client 文案 |
| --- | --- |
| `monitoring` | 监控中，未形成候选机会 |
| `awaiting_data` | 等待完整数据 |
| `needs_revision` | 反方要求修改 |
| `risk_rejected` | 风控拒绝新开仓 |
| `waiting` | AI 决策官暂缓 |
| `approved_shadow` | 已批准，仅影子记录 |
| `approved_paper` | 已批准，等待 paper 执行 |
| `paper_filled` | Paper 模拟成交，不代表真实成交 |
| `demo_not_sent` | 平台 Demo 未发送 |
| `demo_failed` | 平台测试环境验证失败，不影响 paper |
| `demo_filled` | 平台测试账户回执，不代表客户真实成交 |

页面不得硬编码行情、风险、收益、会议结论、provider 连接或执行成功。阶段缺失显示 incomplete；无行为的真实交易、紧急停止和客户交易所连接入口隐藏。

## 6. 钱包和通知

- `/wallet` 只读显示历史服务余额和账本；与 credits、paper 本金分区解释。
- `/wallet/deposits` 显示“本 Beta 未开放充值”，无创建、地址、二维码或确认数。
- Beta 通知为 in-app 与 Email，支持账号时区下的成对免打扰时段原子保存；Email Worker 按 IANA 时区/DST/跨午夜窗口延迟到结束时间，in-app 立即可用。Email 未满足 Gate 时显示 `configured_not_sent`。
- Telegram/WhatsApp 固定“未接入、不可验证”，接口/UI 不生成演示验证码。
- Proxy 将历史 `/api/notifications/channels`、`/api/wallet/deposit-orders`、`/api/exchange-accounts/**`、`/api/strategy-deployments/**`、旧永续 research/deployment、社区市场、旧 portfolio/simulated orders 与 Client emergency-stop 标为 `DISABLED/BETA`；运行时租约、Worker 和 `0029` 迁移同时拒绝/终结旧永续任务，隐藏 UI 不是唯一安全边界。
- 偏好保存失败保留原值，动态结果用 `aria-live`。

## 7. 错误、可访问性与性能

- 401 回本 audience 登录；403 无权限；409/422 显示业务原因；429 显示重试；503 显示未配置/未启用。
- loading/error/not-found、AbortController、防 stale response 和重复提交保护齐全。
- 320/768/1024/1440 无非预期溢出；对话框/抽屉支持 ESC、focus trap、回焦、skip link。
- Client 初始 JS ≤200KB gzip、CSS ≤50KB、首屏图 ≤200KB；bundle 不含内部应用代码/文案。

## 8. 验收

- 邀请→商业披露→trial→会员订单→Ops 复核→credits→三 paper→七阶段→Demo 证据→通知→到期可重复运行。
- 恰好七个角色且顺序正确；无 perpetual/leverage/short/funding/customer secret/live endpoint。
- paper 与 Demo 状态、盈亏、ID 和责任文案完全分离。
- 假地址、假二维码、假验证码、假连接、假成交和硬编码计划价格为零。
