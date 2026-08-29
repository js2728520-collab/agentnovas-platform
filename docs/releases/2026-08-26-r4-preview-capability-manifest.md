# r4 Preview 启用能力与 Provider 清单

状态：`RELEASE_CANDIDATE_SCOPE`。本清单冻结 r4 首轮 canary 的最小安全范围，不构成 production 发布授权。新增任何 provider、Worker 或外部副作用都必须新建 go-live 记录并重跑对应 Gate。

候选：`preview-7c047b6-wt-20260826T142018Z`；source tree SHA-256 `18be3df441b4a93395f834cb6582397ea9366b0b496923f4b07bf385b066ff2f`。

## 1. 首轮允许启用

| 平面 | 能力 | 首轮状态与边界 |
| --- | --- | --- |
| 三端基础 | Client、Operations、Maintenance HTTPS、Host/audience/Cookie、独立登录与最小 DB role | `ENABLED`；三端只读容器、loopback origin、Caddy 边缘入口 |
| 身份安全 | 邀请/注册、邮箱验证能力、登录/找回、五设备、单设备/全量退出、RBAC/scope/recent-MFA 合同 | `ENABLED`；MFA enrollment 能力存在，但 enforcement 首轮仍为 false |
| Client | 账户、商业披露、会员/试用状态、Credits、钱包/账本只读、Paper 组合/交易大厅/工作记录、站内通知、支持页 | `ENABLED_CONTROL_PLANE`；只允许站内和已持久化 Paper 数据，不启后台外部 Worker |
| Operations | 内部/客户邀请、账号生命周期、客户最小 PII 投影、组织/数据中心/团队、会员/credits/充值/财务只读与 maker-checker、审批/审计 | `ENABLED`；任何真实资金仍在外部人工渠道，系统只记录证据和受控账本决定 |
| Maintenance | health、技术/授权审计、角色、安全停控、配置版本、模型 Profile/绑定管理、集成状态、AI 用量、工作记录脱敏导出、release 证据登记 | `ENABLED_CONTROL_PLANE`；只登记/管理，不执行 Git、SSH、任意 SQL 或基础设施命令 |
| 通知 | 站内 inbox、偏好和免打扰 | `ENABLED_IN_APP_ONLY`；不发送 Email/Telegram/WhatsApp |
| 发布 | r4 preview 三域与 current/previous 应用回滚点 | `ENABLED_PREVIEW_ONLY`；production/current/tag/push/PR 均未授权 |

## 2. Provider 与后台进程

| Provider/进程 | 环境事实 | 首轮决定 |
| --- | --- | --- |
| 优盾 USDT/TRC20 deposit-only | DB `disabled`，Client/Maintenance API key 均 absent，provider test false，Payment Worker false | `DISABLED/NOT_CONFIGURED`；客户不能创建真实充值地址，Webhook/入账不开放 |
| Resend Email | DB `disabled`，API key/Webhook secret absent，发送开关 false | `DISABLED/NOT_CONFIGURED` |
| Telegram / Meta WhatsApp | DB 均 `disabled` | `DISABLED`；只显示经验证的公开支持配置，不伪造可达性 |
| LLM Profiles | 8 个 Profile enabled，7 个 Research + 3 个 Runtime binding；真实 provider 未在 r4 做 smoke | Profile/绑定管理 `ENABLED`；真实模型推理 `EXCLUDED_FROM_CANARY`，不得以“已配置”替代 provider/费用/失败恢复证据 |
| Strategy Research Worker | `STRATEGY_RESEARCH_ENABLED=false`，无运行容器 | `DISABLED` |
| Strategy Runtime Worker | `STRATEGY_RUNTIME_ENABLED=false`，无运行容器 | `DISABLED`；不生成新 Paper 决策/成交 |
| Platform Demo | 账户 0，Worker false，external writes false，无运行容器 | `DISABLED`；OKX/Binance/Bybit fixture 通过不等于真实 Demo 已启用 |
| Execution Service / live routing | 无运行容器；真实订单 named Gate 与永续均硬关闭 | `BLOCKED` |
| Configuration Activation Worker | 无运行容器，active configuration 记录 0 | `DISABLED`；已有内核/UI 不代表调度器运行 |
| Payment Worker | Client/Maintenance 均 false | `RETIRED/DISABLED`，不是当前收费或入账路径 |

## 3. 明确不在首轮范围

- 任何客户真实订单、自动跟单、永续、杠杆、做空、提现、划转、代付、自动退款或资金出站。
- 真实充值地址、Webhook 自动入账、真实 Email/Telegram/WhatsApp、真实 Demo 下单或真实 LLM 调用。
- Strategy Research/Runtime/Notification/Demo/Execution/Configuration Activation 后台进程。
- 市场策略投稿/审核/上架的 V3 状态机、作者分账、优惠券/固定价、Prompt/Skill runtime、客户交易账户接入。
- Maintenance 触发 CI/CD、任意 ref/workflow/Shell/SSH/SQL；T8.0 仍为安全评审。
- production push/tag/PR、生产迁移、生产域名切流或能力开放。

## 4. 变更规则与证据

从 `DISABLED/EXCLUDED/BLOCKED` 改为 enabled 时，必须写明 owner、provider/product/capability、凭证域、网络、最小角色、测试账号、限额、kill switch、回滚、监控和停止条件；使用同一候选完成 staging 真实 smoke，再由不同人员批准。不能一次开启多个 provider 来共享一份结果。

r4 事实审计位于 `t96-capability-audit-final.log`，SHA-256 `83e4f5fcedfd66d63ad92d1cef4844551c48b8f6f2baa623da5ebaa082ad0893`；补充环境 Gate 日志 `t96-gate-flags.log` SHA-256 `000df8d797aca8f5a359383a867e10c901cb6b6cb060c301b6c1e171a8b2eb5b`。审计只输出布尔值、状态和计数，未输出 secret、endpoint 或连接串。
