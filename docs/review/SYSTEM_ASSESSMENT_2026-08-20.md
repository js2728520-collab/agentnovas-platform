# AgentNovas Platform 系统评估

评估日期：2026-08-20
评估对象：`codex/three-app-riverton-split`，HEAD `6931162` 加当前未提交工作区
结论：架构方向成立，七智能体第一批纵向切片与清洁 CI 已在本次评估后完成，但整体仍只能称为“受控测试开发基线”，不能称为生产就绪或三端全部完成。

## 1. 执行摘要

项目已经拥有有价值的底座：PostgreSQL、多 Agent 研发状态机、确定性回测/运行时、三 audience、独立 Cookie、可配置 RBAC、双式账本、通知 outbox、Resend Webhook 幂等和共享内部工作台。当前最大问题不是“没有功能”，而是新旧权限、页面、接口、产品语义和验证层级同时存在，导致完成度被高估。

最需要立即纠正的四件事：

1. 建立 audience/API 的统一安全边界，逐步停止无限期 legacy role 回退。
2. 持续验证已经完成的七智能体产品/运行时对齐，不让静态数据和假控制回归。
3. 维持已经修复的清洁 CI，确保不再依赖被 `.gitignore` 忽略的旧 `dist`。
4. 按迁移矩阵补齐旧运营能力，之后再删除 4,857 行 Client 单体中的旧 Admin。

## 2. 代码事实

| 指标 | 当前值 | 说明 |
| --- | ---: | --- |
| API route 文件 | 131 | 三端构建都会编译同一 API 面 |
| 显式出现新 access-control 模式的 route | 30 | 搜索口径，不代表全部正确 |
| 使用 `requireUser/currentUser` 的 route | 50 | 多数仍依赖 legacy role/旧数据范围；集合可能重叠 |
| Client 主文件 | 4,857 行 | 包含客户 UI 与已不可导航的旧 Admin |
| 全局 CSS | 3,850 行 | 视觉规则重复、难以按模块维护 |
| 以源码正则为主的测试文件 | 38 | 能防合同删除，但不能证明运行行为 |
| 检测到数据库/PostgreSQL 相关测试文件 | 15 | 有价值但覆盖远低于接口面 |
| raw SQL/Postgres pool 使用文件 | 68 | 与兼容 getDb 并存 |
| `getDb` 使用文件 | 64 | 双数据访问模型增加迁移成本 |

## 3. 维度评分

评分 1–5：1 为不可控，3 为可继续开发，5 为可验证生产成熟。

| 维度 | 分数 | 判断 |
| --- | ---: | --- |
| 产品一致性 | 2→3 | 七角色、服务钱包/交易资金和真实/模拟展示已对齐；官方现货本地执行仍未实现 |
| 应用分离 | 3 | 页面、Cookie 和 Shell 已分；API 面仍共享且缺中央 audience policy |
| 身份与授权 | 2 | 新 RBAC 有基础；legacy fallback、bootstrap、密码和限流是高风险 |
| 数据与账本 | 3 | PostgreSQL/不可变账本方向正确；双迁移/双访问模型需收敛 |
| Agent/策略工程 | 3 | 状态机、确定性引擎和证据链较强；七产品角色已对齐，历史 audit 仍需迁移观察 |
| 前端工程 | 2→3 | Hall 静态数据和假按钮已移除；Client 单体、脆弱 i18n 与自动化浏览器覆盖仍明显 |
| 集成与 Worker | 3 | Notification 闭环质量较好；健康页缺真实心跳，支付仍骨架 |
| 测试与 CI | 2→3 | 清洁 CI 与真实 production HTML 冒烟已修复；源码正则占比仍高，关键 E2E 尚未仓库化 |
| 可观测性 | 2 | 局部有 audit/trace；缺统一 request ID、Worker heartbeat 和 SLO |
| 文档与交接 | 2→3 | 本轮已建立分层文档，但旧 handoff/任务状态仍需同步 |

## 4. P0 问题

### P0-1：API audience/RBAC 覆盖不完整

证据：三端共享 131 个 route；大量旧接口只调用 `requireUser(role)`。页面隐藏不阻止直接 API 调用，新组织树还复用旧接口。

风险：跨应用功能越权、数据范围扩大、撤权后旧角色自动恢复权限。

措施：建立 API route policy 清单和测试；所有内部业务接口要求明确 audience + permission + scope；为 legacy fallback 设置迁移开关和截止日期。

### P0-2：认证与 bootstrap 基线不满足内部高权限应用

证据：密码 KDF 参数偏低；缺登录限流和 MFA；setup/bootstrap 仍需严格收口，历史实现可重置高权账号。

风险：凭证撞库、初始化入口被滥用、高权限账户失守。

措施：先写攻击/限流集成测试，再升级密码 KDF、一次性 bootstrap、MFA/强认证和安全审计。

### P0-3：交易大厅产品语义与运行时不一致

原始证据：说明书七角色包含 AI 决策官，旧 runtime 以审计占第七事件；研发 DSL 为永续模拟，官方卡定义为现货；会议页曾含静态内容。

整改状态：`CURRENT/PARTIAL`。共享合同、运行时 `decision` 事件、Hall API、三策略卡、Meeting 决策轮和 legacy 缺口展示已完成；真实现货本地执行仍为 `BLOCKED`。

风险：客户误解风险边界、模拟被视为真实、审计记录不符合承诺。

措施：采用 ADR-0006/0007；先完成合同、真实状态 UI 和新事件角色，再讨论任何真实执行。

### P0-4：存在静态实时数据与无行为控制

原始证据：Hall 曾硬编码 BTC 价格、风险、OKX Demo 和 fallback 策略；Client “紧急停止”没有操作合同；会议页曾使用静态时间和结论。

整改状态：`CURRENT`。Client 首屏、官方策略卡和 Hall/Meeting 已删除静态报价、风险指数、延迟、收益目标和假角色状态，改为批准的产品合同、API 真实数据或明确空态；无行为按钮已移除，合同测试防止回归。

风险：虚假业务状态、关键风险控制不可用。

措施：API 无数据即空状态；去掉假按钮；会议读取真实 decision round。

### P0-5：CI 清洁环境可靠性不足

原始证据：`tests/rendered-html.test.mjs` 曾读取被忽略的 `dist/server/index.js`；本地 dist 早于当前源代码。

整改状态：`CURRENT`。源码合同测试不再读取 dist；CI 在三端真实构建后启动 Client production server 执行 HTML 冒烟。

风险：本地旧产物让测试假绿，fresh clone 失败或验证错误版本。

措施：测试自己构建临时产物，或将 rendered-html 移入 build 后 suite；CI 删除旧产物后运行；README 与脚本保持一致。

## 5. P1 问题

- Client 主文件和 CSS 过大，客户/旧 Admin/登录/交易大厅耦合。
- 旧通用审批可以跨多个业务对象修改状态，缺少统一事务、行锁、幂等和业务适配器。
- 公开 health 泄露过多内部配置/队列信息；内部 health 又缺真实心跳。
- 通知/成员流程可能把临时密码保存到 payload；应改为一次性设置链接。
- PostgreSQL 兼容层仍使用 SQLite/Drizzle schema 类型，且存在两套迁移真源。
- Operations 只迁移了骨架；团队、策略治理、完整财务和组织管理未完成。
- Maintenance 缺数据集成、Worker 运行态和统一系统审计。
- i18n 依赖 DOM 文本替换，容易在异步内容、可访问名称和服务端渲染中失真。
- 没有 Playwright/Cypress 级别的仓库化关键 E2E；手工浏览器记录不可替代可重跑测试。
- 当前 `tasks/todo.md` 全部勾选，与实际差距冲突。

## 6. 已有优势

- Worker 使用 PostgreSQL lease、`SKIP LOCKED`、幂等和 fencing，方向正确。
- 策略研发对 LLM 与确定性计算做了较清晰的职责分离。
- 回测包含下一根开盘、费用、资金费率和确定性风险等重要约束。
- RBAC 已有应用、权限目录、数据范围、角色模板、角色版本、分配、变更申请和审计基础。
- 账本采用 numeric 与双式分录，明确不可变和反向修正。
- Resend Webhook 对签名、幂等、乱序和 Worker 竞态已有扎实测试。
- 新 Maintenance 安全视图开始避免密钥和完整端点回显。

## 7. 推荐技术优化

### 架构

- 建立 `lib/api-policy`：每个 route 注册 audience、permission、scope、PII policy 和 mutation sensitivity。
- 把 Client 按 Hall、Strategies、Account、Membership、Auth 拆分；旧 Admin 迁移完成后删除。
- 建立正式服务层，route 只做 request/response；SQL、scope 和业务状态机不写成单行 handler。
- 选定 PostgreSQL migration 真源并写 ADR；对兼容 getDb 设置退出计划。

### 安全

- 密码、限流、MFA、bootstrap、CSP、健康信息最小化作为 Gate 1。
- 将 PII、secret 和供应商 payload 安全视图做成可测试 serializer。
- 敏感 mutation 使用版本/幂等键、事务和追加式审计。

### 质量

- 源码正则只保留结构合同；关键逻辑改为函数、route integration 和浏览器 E2E。
- 每个 P0 先有失败测试；CI 在 clean checkout、空 dist 和临时 DB 上运行。
- 构建矩阵使用项目实际 PostgreSQL 主版本，并覆盖 Node 最低版本。

## 8. 结论

项目不是推倒重来：核心研究、运行、账本、通知和 RBAC 资产值得保留。正确策略是先修“真源与边界”，再按纵向切片迁移旧业务。若继续在静态 UI、legacy API 和全勾选任务清单上叠加功能，系统会越来越难以证明安全和完成度。
