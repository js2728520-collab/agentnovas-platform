# Riverton Capital 受邀付费 Beta PRD

状态：商用 Paper SaaS 产品真源；技术 Gate 全绿后可发布
版本：2.2
日期：2026-08-21
适用发布：5–20 名受邀客户

## 1. 产品命题

Riverton Capital 是建立在 AgentNovas 技术平台上的 AI 策略研究与模拟服务。一个 Next.js 工程与一个 PostgreSQL 数据库承载 Client、Operations、Maintenance 三个应用；三端共享代码和受控数据基础设施，但登录、Cookie、路由、菜单、权限、数据范围、运行环境和审计均按 audience 隔离。

本 Beta 的付费价值是：客户获得可解释的七智能体决策过程、三张官方现货策略的独立 paper 组合、AI credits 和运营支持。客户不会在平台存入交易本金，也不会把交易所密钥交给平台。

## 2. Beta 用户、问题与价值

目标用户是愿意参加 14 天受控验证、理解数字资产高风险且接受模拟产品边界的受邀用户。核心问题：

- 单一 AI 结论缺少质疑、硬风控和可追溯依据。
- 普通回测或模拟盘难以说明每次交易为何发生、为何没有发生。
- 平台团队缺少可审计的会员、credits、模拟绩效和人工复核闭环。

Beta 提供：七阶段决策记录、三张隔离 paper 组合、平台 Demo 环境执行证据、真实站内与 Email 通知，以及人工会费/盈利分成复核。

## 3. 三端职责

| 应用 | 用户 | Beta 核心职责 | 明确禁止 |
| --- | --- | --- | --- |
| Client | 受邀客户 | 商业披露确认、试用/会员、credits、三策略 paper、七阶段记录、平台 Demo 证据、通知 | 内部运营/运维数据；客户充值；上传交易所密钥；真实下单 |
| Operations | maker、checker、客服 | 邀请与客户、会员付款凭证、双人复核、credits 调整、周分成、业务审计 | 自审；技术密钥；把审批写成资金已自动执行 |
| Maintenance | 技术/安全管理员 | 模型与 Agent 绑定、Email、平台 Demo 账户、Worker 健康、紧急暂停、版本发布证据、RBAC、技术审计 | 查看密钥明文；替代业务审批；从浏览器执行基础设施部署；启用真实支付或真实订单 |

## 4. Beta 主流程

1. Operations 创建邀请，用户通过一次性链接设置密码。
2. Client 完成邮箱验证并确认平台已发布的当前版本服务条款、隐私、风险和收费披露。
3. 确认完成后系统开通 3 天 trial；确认前不启动试用、不创建订单、不开放策略。
4. 用户选择四档计划之一，系统生成订单号和人工付款指引，不生成链上地址、二维码或监听状态。
5. Ops maker 记录脱敏外部付款凭证，不同 checker 复核。
6. 同一事务内激活/续期 entitlement、发放 credits、写账本、事件、通知和审计；幂等重试不得重复发放。
7. 每个有效会员为每张官方策略获得独立 `10,000 USDT` paper 组合，可同时运行三张，总初始模拟本金 `30,000 USDT`。
8. 决策轮生成客户 paper 执行回执；平台测试账户可另行向 OKX Demo、Binance Spot Testnet、Bybit Demo 发送小额验证意图。两类回执永不混写。
9. Operations 对上一完整 UTC 周生成盈利分成账单，经过业务审批后形成应收；只有另一组付款凭证与复核完成后才标记 paid 并提交高水位。
10. 到期停止新开仓；有持仓的组合进入 `close_only`，清仓后进入 `read_only`。Beta 不自动退款、不自动扣款，也不把 Paper 收益兑换为真实资金。
11. 候选版本以 SemVer tag、commit、artifact SHA-256 和 migration version 登记并由不同 Maintenance 人员验证；production 证据必须已有同版本 staging 成功事实。

## 5. 会员计划 v1

计划快照由服务端合同与 `commercial_plans` 版本化保存，客户端不得硬编码价格。

| 计划 | 价格 | 权益期 | 一次性 credits | paper 盈利分成 |
| --- | ---: | ---: | ---: | ---: |
| 月卡 `monthly_v1` | USD 28 | 30 天 | 1,000 | 20% |
| 季卡 `quarterly_v1` | USD 58 | 90 天 | 3,000 | 20% |
| 年卡 `annual_v1` | USD 198 | 365 天 | 12,000 | 20% |
| 终身 `lifetime_v1` | USD 588 | 无到期 | 36,000 | 16% |

历史订单保存计划版本、金额、币种、权益期、credits 与费率快照。后续改价不得改变历史订单。

## 6. AI Credits

- Credits 与 USDT 钱包、客户 paper 本金和平台 Demo 资金完全分离。
- Beta 不提供 credits 充值；只由会员激活/续费或双人复核的运营调整产生。
- AI 请求先按模型费率版本预留，供应商返回可靠 usage 后结算并释放差额。
- 无费率或无法可靠计量的模型不得处理付费 AI 请求。
- 余额不得为负；所有增减是不可变分录并携带来源幂等键。

`/wallet` 保留只读历史；`/wallet/deposits` 明确显示“本 Beta 未开放充值”，没有创建按钮。

## 7. 三张官方策略与七智能体

唯一合同见 `SEVEN_AGENT_TRADING_HALL.md`：

- 目标市场为 BTC/USDT、ETH/USDT、SOL/USDT 现货，long-only、无杠杆、无做空、无 funding、无永续字段。
- 七阶段顺序固定：市场分析、技术分析、策略研究、反方审查、风险审批、AI 最终决策、执行回执。
- 所有计算和硬风控由确定性程序完成；LLM 不能越过风险审批。
- 决策轮、策略版本、行情快照、paper 成交和解释记录共享 `traceId`。
- 用户说明书中的“未来客户交易所本地执行”是产品参考，不属于本 Beta；Beta 第七阶段输出客户 paper 回执和独立的平台 Demo 证据。

## 8. 客户 paper 与平台 Demo

客户 paper：每卡独立现金、持仓、成交、手续费、风险与盈亏；服务器拥有状态，客户不能修改本金、参数或伪造成交。

平台 Demo：平台统一持有测试账户，仅验证相同信号在交易所测试环境可被接受。默认单笔名义金额不超过 `10 USDT`，单 provider 每日不超过 `100 USDT`，具有 provider/card 全局熔断。Demo 成败不改变客户 paper 成交、余额、收益或结算。

UI 必须显示：“平台测试账户，不代表客户真实成交”。任何 provider 是本地 fixture 或未配置时，不得标记 connected、sent 或 filled。

## 9. 周盈利分成

- 周期为 UTC 周一 00:00:00 至周日 23:59:59。
- 三张官方策略已平仓 paper 净收益合并计算；净收益扣除 paper 开平仓模拟手续费。
- 计费基数为 `max(0, 累计净已实现收益 - 已结算高水位)`；亏损自然结转。
- 月/季/年卡 20%，终身 16%；使用账单期对应 entitlement 的合同快照。
- 上一张已审批未支付账单存在时，不生成重叠账单。
- 业务审批只产生应收，不自动扣钱包、不自动暂停会员、不更新高水位。
- 付款凭证经另一组 maker-checker 复核后才标记 paid 并提交新高水位。
- 所有页面均称“paper 模拟净收益”，不得称真实投资回报。

Paper 盈利分成是本版本已锁定的产品计费合同，必须在下单前以版本化披露向用户展示并保存确认凭证；任何费率或退款口径变更必须创建新计划版本、披露版本和 ADR，不能覆盖历史订单。

## 10. 身份、权限与真实状态

- Client 会话最长 7 天、闲置 24 小时；Operations/Maintenance 最长 12 小时、闲置 1 小时。
- Operations/Maintenance 强制 TOTP 与 recovery codes；关键操作要求 15 分钟内重新验证。
- API 中央策略为每个 method/path 声明 audience、认证、MFA、权限、数据范围、PII、敏感度、幂等、限流和请求体上限；未登记 handler 拒绝发布。
- 未知 Host 返回 404；内部端没有显式 assignment 时不回退 legacy 全权；撤权 tombstone 不得恢复旧权限。
- Telegram/WhatsApp 显示“未接入、不可验证”；Beta 只启用站内通知和满足全部 Gate 的 Email。
- `configured`、`enabled`、`alive`、`healthy`、`stale` 是不同状态，不得互相替代。

## 11. 指标

- 邀请接受率、商业披露确认率、试用激活率、付费激活率。
- 每卡启动数、完整决策轮率、paper 成交率和未成交解释率。
- 三 provider Demo 成功率、延迟、重复单数和熔断次数。
- Email delivery/bounce/complaint；credits 消耗与余额不足拒绝。
- 周分成生成、审批、付款、争议；重复发放/重复计费必须为 0。
- 401/403、跨 audience 拒绝、5xx、p95、Worker stale。

## 12. 非目标和硬关闭

- 不做社区策略市场、作者分润、自动支付、链上地址、客户充值、自动退款或自动对账副作用。
- 不接收客户交易所密钥，不开放真实现货或永续，不允许提现/划转/杠杆/衍生品 endpoint。
- Payment Worker 保持 disabled；未获明确授权不进行真实 Email、Demo smoke、DNS/TLS 或生产迁移。
- 不以静态 KPI、演示验证码、假二维码、倒计时、假回执或环境开关冒充真实业务结果。

## 13. 上线条件

Beta 只有在 `docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md` 全部通过后才可开放。平台产品身份、服务地区、隐私、条款、风险、Paper 收费和退款/不退款规则任一未形成可发布的版本化正文，或任一跨 audience、重复计费、假状态、真实订单可达、迁移/恢复/E2E 失败，均为否决项。这里的 Gate 是产品合同完整性与技术可验证性，不依赖仓库外部团队交付。
