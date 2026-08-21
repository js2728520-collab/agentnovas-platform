# Riverton Capital 商用 Paper SaaS 完整收口计划

状态：版本管理与最终本地发布 Gate 已完成；本提交进入目标远端 `main` 验证
集成分支：`codex/three-app-riverton-split`
本轮实施起点：`4fea508`（最终交付提交以当前分支 HEAD 为准）
目标：完成代码可控范围内的全部 P0/P1，交付可收费、可审计、可恢复的受邀商用版本

## 1. 商用产品边界

- 产品是三张官方现货策略驱动的 Paper SaaS，不托管客户交易本金，不接收客户交易所密钥。
- 客户会费与 Paper 盈利分成使用外部人工收款、脱敏凭证和不同人员复核；系统负责订单、权益、Credits、应收、审计和通知。
- OKX Demo、Binance Spot Testnet、Bybit Demo 是平台测试账户执行证据，与客户 Paper 资产、收益和结算彻底分离。
- 平台自己维护七类版本化商业披露正文、发布审批和客户接受证据；不再把“等待外部法务团队”作为工程 Gate，也不把工程实现表述为法律意见。
- 真实支付、客户充值、提现、自动退款、真实现货/永续交易和社区策略分账不是本产品的未完成功能，继续从路由、Worker、菜单和部署配置硬关闭。未来若改变商业模型，必须新建 PRD/ADR 和专项安全实施。
- 外部 Email、Demo、DNS/TLS 等在没有真实凭证时必须显示 `not_configured/configured_not_sent`，代码可完成 readiness、验证和运行手册，但不得伪造 connected、sent、filled 或 healthy。

## 2. 唯一真源与完成定义

真源顺序：PRD → 七智能体合同 → `packages/contracts` → System/三端 Spec → ADR/API Catalog/OpenAPI → Gate/Runbook → 本计划与 `tasks/todo.md`。

一个功能只有同时满足以下条件才可标记完成：

1. 数据库约束/事务和迁移可 fresh、rerun、N-1；
2. 中央 API Policy、audience、RBAC、data scope、PII 与幂等策略齐全；
3. 页面具备 loading/empty/error/success、确认、重复提交保护和准确文案；
4. 单元/合同/PostgreSQL/浏览器测试覆盖成功、拒绝、并发和回滚；
5. API Catalog、Spec、Runbook、发布证据同步；
6. 不出现假数据、假成功、跨 audience 泄露、密钥回显或不可达按钮。

## 3. 实施轨道

### Track 0：商业合同、试用与产品真相

- 增加平台维护的商业披露草稿、发布、历史版本和双人复核；预置不含虚构主体/地区的安全正文模板，并强制部署方补齐产品身份字段后才能发布。
- 把 Client 的“法务 Gate”重命名为商业披露接受 Gate，统一 API 错误、页面和通知文案。
- 完成邀请接受、3 天试用、试用到期、会员到期、只读保留和新开仓停止的确定性状态机。
- 完成账号安全页：资料、改密、MFA 状态、会话撤销、恢复码重新生成与审计。
- 完成支持入口与平台公告真实配置；未配置客服渠道时只显示不可用状态。

验收：未发布完整披露时商业能力失败关闭；同一 bundle 只接受一次；新版本重新确认；试用/会员到期不再新开仓；历史 Paper 与账单只读可查。

### Track 1：Operations 业务全生命周期

- 客户：列表/详情、备注历史、冻结/恢复、归档、归属转移、会员/Credits/Paper/应收摘要。
- 组织：组织树、成员、邀请、激活/停用、汇报关系和组织范围验证。
- 团队：每日简报、月目标、跟进记录、受控 CSV 导出；全部使用服务端分页与 URL 筛选。
- 数据中心：客户、会员、策略启动、Paper 周期、应收和通知的真实统计，不使用静态 KPI。
- Credits 调整：maker 创建、checker 决定、同事务不可变分录、禁止负余额、自审和重复入账。
- 财务：会员订单、周分成、应收、结算、付款资料、调整单统一状态和只读账本引用。
- 审批：将会员、分成、Credits、RBAC、充值历史操作、归属和策略治理投影到统一审批收件箱；决定仍由各领域事务完成。
- 策略治理：官方三卡版本/启停/发布证据和跟随策略只在 Maintenance 管理，Operations 仅查看业务影响；社区市场继续隐藏。

验收：SELF/DIRECT_REPORTS/TEAM_TREE/ORGANIZATION_SET/PLATFORM 的列表、详情、计数、导出一致；敏感操作不同人复核；冻结和撤权立即撤销会话/能力；所有副作用可审计且幂等。

### Track 2：Maintenance 平台控制面

- 商业披露版本、产品身份、客服/公告、Email allowlist 和发布 readiness 工作区。
- 模型 Profile 版本、验证、Agent 绑定、回滚和密钥不可回显。
- 数据/新闻集成目录、enabled/healthy/stale、最近成功/失败和安全测试回执。
- 三平台 Demo 账户控制、provider/card kill switch、限额、最近验证与净化回执。
- Worker/API/DB/Email/Demo 的统一技术审计，关联 requestId/traceId，支持安全筛选与游标分页。
- 公开健康只返回粗粒度；内部健康明确区分 configured/enabled/alive/healthy/stale。

验收：Maintenance 不读取 Operations 授权数据；所有 secret 只返回 `hasSecret`；回滚/测试/停控要求 recent MFA、原因和幂等键；日志和回执无完整端点、PII 或 provider payload。

### Track 3：Client 完整客户旅程

- 邀请设置密码 → 登录 → 商业披露确认 → 试用/会员选择 → 人工付款指引 → 订单追踪。
- 首页与会员页显示真实试用/权益/Credits/三卡 Paper 状态、待办和失败原因。
- Paper 详情展示组合、持仓、真实成交历史、七阶段证据、traceId 和独立平台 Demo 安全摘要。
- Demo 区始终标注“平台测试账户，不代表客户真实成交”，provider 未配置或失败不影响 Paper 状态。
- 独立的绩效账单、通知、账号安全、支持与公告页面；钱包保持只读，充值说明明确关闭。
- 清理遗留永续、客户交易所连接、假验证码、假地址、静态行情/KPI 与不可达入口。

验收：关键旅程可用真实 API 重复执行；401 回登录、403 留在无权页、409/422 展示业务原因；四档响应式、键盘、焦点、`aria-live`、axe 与 console/network Gate 通过。

### Track 4：平台质量、部署与发布证据

- 补齐 API inventory、OpenAPI、数据库角色脚本、最小 env、systemd/Nginx、Worker heartbeat 和结构化指标。
- 增加 CI quality-release job：测试、类型、Lint、三端 build、Playwright、axe、bundle、Lighthouse、生产依赖审计和 secret scan。
- 完成本地隔离 PostgreSQL 的 fresh/N-1/rerun/checksum/concurrent migration、备份/恢复、前向回滚演练。
- 完成四身份、三 audience、试用/付费/到期、双审、七阶段、Demo failure、Email 未配置和恢复码消费浏览器验收。
- 更新 PRD、Spec、ADR、能力矩阵、API Catalog/OpenAPI、Gate、Runbook、handoff 和发布证据。
- 最终代码质量与独立反证审查；清理开发工具链 high/critical 或记录有负责人/日期的临时例外。

验收：`npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run test:apps`、Playwright、bundle/Lighthouse、audit、secret scan、`git diff --check` 全绿；恢复演练可复现且清理临时数据。

### Track 5：不可变版本管理

- Maintenance `/releases` 登记 SemVer tag、commit、artifact SHA-256、migration version 和发布说明。
- 版本创建/验证人员分离；staging/production deploy/rollback 结果只追加，失败不切换 current。
- 发布 API/UI 只保存证据，不成为 SSH、迁移、Git 或切流执行器；Client/Operations 无菜单、路由和数据库读取。
- OpenAPI、API Catalog、ADR-0014、CHANGELOG、Release Runbook 和环境元数据模板同步。

验收：幂等 replay、自审阻断、production 前置 staging、合法回滚、表不可变、数据库角色隔离、API Policy 和真实浏览器页面通过。

## 4. 增量顺序

1. Track 0 数据合同/迁移/测试 → API → UI；这是其他商业页面的共同门禁。
2. Track 1 按“客户组织 → Credits → 团队分析 → 财务审批”纵向切片逐个完成。
3. Track 2 与 Track 3 在共享合同稳定后逐页完成；共享热点由当前集成分支串行修改。
4. 每个切片先写失败测试，再做最小实现、错误路径、浏览器验收和文档同步。
5. Track 4 持续运行；最终才启动三端长期本地服务、生成一次性验收账号、提交并进入推送确认。

## 5. Git 与交付规则

- 继续只在 `codex/three-app-riverton-split` 工作；不 rebase/amend/reset/force push，不改写历史。
- 保留 `github-old`，只允许最终集成分支进入 `origin`。
- 不提交 `.env*`、密钥、密码、私钥、数据库备份、运行日志、一次性账号或 provider fixture 原文。
- 完成功能和 Gate 后创建普通提交；推送前重新核对 status/branch/remotes/SSH/secret。
- 当前集成分支通过显式 refspec 普通推送到目标远端 `main`；不推送其他分支、不 force、不改写历史。
