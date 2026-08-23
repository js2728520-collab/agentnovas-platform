# AgentNovas 全平台 V3 升级准备度评估

评估日期：2026-08-23
分支基线：`refactor/foundation` → `codex/platform-v3-doc-sync`
需求真源：PRD V3.0

## 1. 总体结论

当前项目不是从零开始。三端隔离、RBAC、Paper/Demo、账本、版本证据、Execution Service、凭证隔离、订单回执/对账和 live book 已形成较强基础。

但确认稿把产品从“受控 Paper Beta”扩展为完整多市场交易平台。最大的差距不是页面数量，而是产品参数、内部注册模型、多市场数据授权、客户策略市场、provider 逐家验收、资金出站和 Maintenance CI/CD 权限边界。

建议按 V3 路线图推进，不进行一次性全仓改造。

## 2. 能力准备度

| 域 | 当前基础 | V3 差距 | 状态 | 风险 |
| --- | --- | --- | --- | --- |
| 三端隔离 | audience/Cookie/RBAC/DB role 已有 | V3 菜单与 target API 扩展 | `PARTIAL` | 中 |
| Client 身份 | 邮箱验证、国际手机号、5 设备、提醒和全量退出已实现 | 城市级定位参数、真实邮件与浏览器 G1 | `CURRENT/PARTIAL` | 中 |
| Operations 身份 | 权限链接、自助注册、扁平账号目录已实现 | 四身份浏览器 G1 | `CURRENT/PARTIAL` | 中 |
| 行情 | 加密市场与回测基础 | 多 provider、股票/外汇/贵金属、实时 SLA | `TARGET` | 高 |
| AI 助手 | 对话、DSL、回测基础 | QuantDinger 差异、精简 UI、固定 Credits | `PARTIAL` | 中 |
| 策略市场 | 旧社区能力曾存在/已关闭 | 投稿审核、作者、收费、版本与风控 | `TARGET` | 高 |
| Paper/Demo | 证据分离和七阶段较完整 | 接入新策略市场/多市场 | `CURRENT/PARTIAL` | 中 |
| Execution Service | 凭证隔离、适配器、幂等、对账 | 余额对账、激活入口、真实 smoke | `BLOCKED` | 极高 |
| 真实现货 | named gate 与记账基础 | provider 逐家生产验证 | `BLOCKED` | 极高 |
| USDT 永续 | 部分历史研发基础 | 完整衍生品风险与项目硬边界 | `BLOCKED` | 极高 |
| 提现/划转 | deposit-only 账本基础 | 独立资金服务全套合同 | `BLOCKED` | 极高 |
| 会员/Credits | 版本/账本基础 | 新价格、固定扣费、退款/优惠 | `PARTIAL` | 高 |
| Operations | 客户/财务/审批基础 | 新角色链接、交易干预、V3 报表 | `PARTIAL` | 高 |
| Maintenance | 模型/健康/版本证据基础 | 技能/Prompt/定价/开关/CI trigger | `PARTIAL` | 高 |
| 主题/i18n | 基础响应式 | 六主题、完整英语默认与多语言 | `TARGET` | 中 |
| 发布质量 | 强 Gate 与恢复证据 | 为真实交易/资金/CI trigger 增量扩展 | `PARTIAL` | 极高 |

## 3. 首要决策缺口

1. 首期五家交易所的真实开发顺序和 MetaMask 用途。
2. 外汇/贵金属交易场所及服务地区。
3. 股票行情供应商授权与 SLA。
4. 策略上架门槛、跟单收费和作者分账。
5. 套餐价格、Credits 数值和退款规则。
6. 提现/划转服务费、限额和托管责任。
7. 项目验收日期与资源投入。

## 4. 安全优先级

### P0

- 角色链接越级、泄露和批量注册风险。
- 客户交易凭证与 Execution Service 边界。
- live book 与交易所余额/持仓分叉。
- 未知订单、部分成交和重复下单。
- 永续杠杆/强平风险。
- 提现/划转密钥与资金出站。
- Maintenance CI/CD 被用作远程命令执行器。

### P1

- 多市场授权、stale 行情和错误主备切换。
- 策略作者收费、版本更新与责任披露。
- Operations PII、导出和高风险交易干预。
- 配置/Prompt/价格未经审批直接影响生产。

### P2

- 六套主题、i18n、SEO 和体验一致性。

## 5. 推荐启动顺序

1. 完成 Phase 0 产品参数和资源评审。
2. 先做 Phase 1 权限链接与组织 UI 退休，修正最明确的需求偏差。
3. 并行准备 Phase 2 行情供应商和 Phase 3 配置/计费基础。
4. 在 Paper/Demo 上完成 Phase 4 策略市场，再进入真实交易。
5. 真实现货先单 provider 小灰度；永续、资金出站和 CI/CD 分别独立立项。

## 6. 结论

项目具备升级基础，但不适合直接“打开已有实盘代码”。先完成文档、产品参数、任务和 Gate 的统一，是降低返工和资金风险的必要步骤。当前文档分支完成后，应由需求方、技术负责人和安全负责人共同评审 Phase 0，再授权进入开发。
