# AgentNovas 全平台 V3 分阶段升级路线图

状态：`TARGET/INCREMENTAL_EXECUTION`；M1 三端极简安全版已完成，后续业务里程碑继续按 Gate 推进
分支：`codex/platform-v3-doc-sync`
日期：2026-08-29

## 1. 推进原则

- 先冻结合同，再改架构，再做纵向功能切片。
- 每阶段保持系统可构建、可测试、可回滚。
- 高风险项尽早做威胁模型和真实可行性验证，但最后才开放生产权限。
- 真实现货、永续、提现/划转和自动部署各自独立里程碑。
- 未完成 Gate 的能力显示真实 blocker，不放置伪可用入口。
- P-01–P-12 采用双轨：不依赖未决参数的工作继续推进；依赖参数的页面、API、Worker 或 Gate 只做到安全边界、接口或草稿状态后停止并失败关闭。
- 第一里程碑先交付三端极简安全版，不开放真实交易、资金出站或受限部署。

## 2. 依赖图

```text
Phase 0 产品参数与文档
  ├─> Phase 1 身份/RBAC/权限链接
  ├─> Phase 2 行情与市场基础
  ├─> Phase 3 配置/计费/主题基础
  │
  ├─> Phase 4 AI 与策略市场
  │      └─> Phase 5 真实现货与自动跟单
  │             └─> Phase 6 永续/外汇贵金属
  │
  ├─> Phase 7 提现/划转（独立资金轨）
  └─> Phase 8 CI/CD 控制面

Phase 1–8 全部按需汇入 Phase 9 正式发布
```

## 3. Phase 0：产品冻结与升级基线

目标：把已确认需求转成可开发合同，消除会改变架构或价格的空白。

交付：

- PRD 参数 P-01–P-12 的负责人和结论。
- ADR-0021、V3 System/三端 Spec、API target families。
- 当前能力与 V3 差距矩阵。
- 分阶段任务看板、风险登记和里程碑。

退出条件：产品真源、当前事实和依赖登记一致。G0 未全部通过时，只阻断依赖未决参数的能力，不阻断已明确且无风险的 M1 极简化工作。

### 3.1 M1：三端极简安全版

按纵向切片依次推进：

1. 基线与文档真源。
2. 三端 Shell 与五中心路由。
3. 三端数据看板精简。
4. 设置、主题与语言。
5. 现有功能归位与冗余清理。
6. 三端体验、远端质量与测试域名验收。

Client 主导航为数据看板、交易中心、策略中心、行情、AI 助手；Operations 和 Maintenance 分别采用目标规格中的五个业务中心。Client 支持七种现有语言并默认英语，Operations/Maintenance 仅支持中英并默认简体中文。P-10 已冻结为 Riverton 经典/海湾/松林调色板及明暗配对。M1 的六主题、四断点、设置恢复、Host/Cookie audience 隔离和无障碍测试站 Gate 已于 2026-08-29 完成；这不代表 G8 的生产域名、真实邮件、性能和跨职能发布 Gate 已通过。

## 4. Phase 1：三端身份、权限与注册重构

纵向切片：

1. Operations 隐藏并退休组织架构 UI。
2. 角色注册链接数据模型、token、安全和审计。
3. 五级角色生成/撤销/注册完整链路。
4. Client 手机号、邮箱验证和 5 设备会话。
5. PII 字段权限和导出一致性。
6. MFA 采用“能力保留、当前关闭、正式生产 Gate 后三端统一开启”的分阶段策略。

进度（2026-08-23）：第 1–4、6 项核心实现和自动化测试已完成；第 5 项及 G1 真实邮件、
生产 MFA 开启态和目标环境完整证据仍待完成。设备城市定位和第 6 台交互见 ADR-0022，
MFA 上线策略见 ADR-0023。

退出条件：G1 通过；现有 Beta 会员/Paper 回归全绿。

## 5. Phase 2：多市场行情平台

纵向切片：

1. provider/symbol/calendar/capability 合同。
2. 加密行情源选择和 Coinbase fallback。
3. WebSocket、stale、重连和主备切换。
4. A 股/港股实时行情与搜索。
5. 韩股/日股扩展。
6. 外汇/贵金属行情基础。

退出条件：G2 逐市场通过；陈旧行情硬阻断新开仓。

## 6. Phase 3：Maintenance 配置、计费、主题与语言

纵向切片：

1. 品牌、域名、协议和 i18n 配置版本。
2. 六套主题 token 和组件/图表适配。
3. 功能开关多粒度与定时发布。
4. Prompt/技能草稿、测试、双审和回滚。
5. 套餐、Credits、USDT 支付、退款和优惠版本。
6. Token 用量多维统计。

实施快照（2026-08-24）：通用版本内核、Maintenance 工作台、最小权限到期激活 Worker，以及
`client.strategy_research` 全局 v1 与用户/组织/版本/稳定百分比/独立时窗定向 v2 已完成；
品牌/域名、Prompt/技能、价格/Credits 仍按任务清单和产品参数依赖推进，Phase 3 尚未满足退出条件。

退出条件：配置历史不可覆盖，所有高风险变更可回滚。

## 7. Phase 4：AI 助手与策略市场

纵向切片：

1. QuantDinger 差异清单和 AI 助手信息架构。
2. 对话取消/重试/幂等和 Credits 单终态已完成；固定 Credits 数值与分档等待 P-08。
3. 结构化策略、回测和准入合同。
4. 客户投稿/审核/上架/下架。
5. 策略详情、作者、费用和风险披露。
6. 跟单配置、版本快照、暂停/停止。

退出条件：G3 通过；全部执行仍留在 Paper/Demo。

## 8. Phase 5：真实现货与自动跟单

顺序：OKX/Binance 现有基础复核 → 最终 P-01 优先列表逐家适配 → 灰度客户。

纵向切片：

1. 余额/持仓持续对账。
2. Client live activation 和 blocker UI。
3. provider 真实最小额 smoke 与精度修正。
4. 自动跟单扇出、幂等、部分成交和 reconcile。
5. live book、费用、绩效和策略收费。
6. provider/account/strategy 熔断、紧急平仓和恢复。

退出条件：G4 与单 provider G4A 通过后，只解锁该 provider 的现货。

## 9. Phase 6：USDT 永续、外汇与贵金属

永续与外汇/贵金属分别建专项 ADR 和执行 Spec，不复用现货结论替代。

永续重点：杠杆、保证金、position mode、reduce-only、funding、标记价格、强平和 ADL。
外汇/贵金属重点：交易场所、市场时间、合约、杠杆、隔夜费、报价和地区限制。

退出条件：专项 Gate 通过且项目硬边界获得明确更新授权。否则持续 `BLOCKED`。

## 10. Phase 7：提现、划转与服务费

这是独立资金项目，不与 Phase 5 交易执行共享高权限凭证。

纵向切片：产品/合规合同 → 资金服务与密钥域 → 地址/限额/冷静期 → 双审 → 服务费/账本 → 链上对账 → 事故恢复 → 小额灰度。

退出条件：G5 全部通过；任何部分完成都不开放资金出站。

## 11. Phase 8：Maintenance CI/CD 控制面

纵向切片：专项 ADR/威胁模型 → 纯 domain contract → 追加命令/审批事实 → 固定 workflow 与短期凭证适配器
→ staging 触发 → 回调证据 → production 双审 → rollback → 失陷演练。

T8.0 的 ADR-0024/专项规格与 T8.1a–T8.2c 均已完成。T8.2a 交付默认关闭的独立 Ingress、raw-body HMAC、
append-only delivery 与 exact-run 异步 reconciliation；两轮 fresh-context 对抗复审关闭 systemd 信任域塌缩
和 terminal reconciliation 饥饿两项 High，并通过远端 81 迁移、PostgreSQL/ACL/Ingress/Worker 验证。当前
T8.2b 交付默认关闭的 target gateway、exact-run OIDC、authority/CAS、durable journal、固定 digest adapter、
签名 receipt/keyring rotation 和离线 break-glass stop。T8.2c 已交付 Maintenance 控制 API/UI、分离的
WebAuthn identity verifier/release-control、action-bound authority、数据库原子 assertion 消费和响应丢失精确
重放，服务仅进入默认关闭的 Compose profile。T8.2d1 已完成专用 workflow、独立只读 Auditor、数据库内 v3
reservation、实际 restore rehearsal 与 G7 manifest 生成器。T8.2d2a 已把 provider binding/claim/recovery、
Worker/Auditor Compose/systemd 与启动 preflight 按 staging/production 隔离；T8.2d2b 已把同一候选安全替换到
三域 Web-only preview，并以受支持的 exclusive-create custom dump/TOC/hash 与容器 network namespace
门禁复验 backup/role policy，保持全部 release/外部写入 Gate 关闭。当前只进入经授权的真实 provider fixture、
恢复/失陷演练与 G7，生产启用仍阻断，
Current 继续只登记证据。

退出条件：G7 通过；当前“只登记证据”能力在此之前不变。

## 12. Phase 9：全平台收口与正式发布

- 三端完整旅程与四断点/无障碍。
- 多语言、主题、SEO 和性能。
- 全量迁移/恢复/回滚演练。
- 运营、技术、安全、财务和客服演练。
- 按 provider/product/capability 形成明确发布清单。

当前进度：T9.0 隔离 preview 候选、四镜像、三测试域名、应用回滚和 T9.3 的 77 迁移
fresh/N-1/rerun/concurrent/154 表 backup/restore 已完成。该证据只覆盖当前 Paper/受控 Beta 候选；
性能、运营演练、产品参数和各高风险能力 Gate 仍未完成，因此尚未达到 G8。

退出条件：G8 及所有本次启用能力 Gate 通过。

## 13. 建议里程碑

| 里程碑 | 范围 | 可对外能力 |
| --- | --- | --- |
| M0 | Phase 0 | 文档与排期准备完成 |
| M1 | 极简安全版切片 0–5 | 三端五中心、数据看板、设置/主题/语言与现有可靠能力归位，不开放实盘 |
| M2 | Phase 4 | 策略市场可在 Paper/Demo 运行 |
| M3 | Phase 5 单 provider | 小范围真实现货与自动跟单 |
| M4 | Phase 6/7/8 逐独立 Gate | 永续、资金出站、自动部署分别灰度 |
| M5 | Phase 9 | 全平台正式版本候选 |

具体日期在 P-12 冻结前不填写，避免把未经估算的目标伪装成承诺。
