# AgentNovas 开发环境交接说明

> 最新文档入口为 `docs/README.md`。本文第 13 节对前文“全部完成”的表述进行了状态校正；接管者应以最新 PRD、Spec、系统评估和任务清单为准。

## 1. 接管入口

本文档是新开发环境和新 Codex 任务的第一入口。聊天记录不会自动随代码迁移，因此接管时必须依次阅读：

1. `AGENTS.md`
2. 本文档
3. `README.md`
4. `docs/adr/0003-postgresql-multi-agent-research-pipeline.md`
5. `docs/adr/0004-unified-dsl-v3-shadow-paper-runtime.md`
6. `docs/runbooks/self-hosted-strategy-research.md`
7. `git log -1 --stat` 与 `git status --short --branch`

当前开发分支已从 `codex/multi-agent-strategy-research` 切到 `codex/three-app-riverton-split`。交接版本以本文件所在的最新本地提交为准，不依赖未提交文件。

未经用户明确授权，禁止推送远程、创建 PR 或把仓库发布到任何托管平台。代码交接优先使用本地 Git bundle。

## 2. 不可改变的架构边界

- 目标部署为自有 Linux、Node.js 22.21+、PostgreSQL 16+、独立 Research Worker、独立 Runtime Worker、Nginx 和 Certbot。
- 不使用 Cloudflare Runtime，不引入 Redis。Web 与两个 Worker 以 PostgreSQL 为唯一持久化真源。
- 本期只提供策略研发、真实历史回测、影子盘和模拟盘；真实永续订单路由必须保持关闭。
- LLM 负责需求结构化、市场解释、独立提案、反方审查、风险说明和报告。DSL 校验、行情标准化、参数搜索、回测、评分、准入、风控和模拟订单意图由确定性代码控制。
- 回测是历史证据，不承诺未来收益。未达到门槛的候选必须明确标记 `NOT_QUALIFIED` 或“未通过标准验证”。
- 模型与交易所密钥只在服务端加密保存，不进入浏览器、Agent 公开事件、日志或 Git。

## 3. 本次本地提交交付内容

本次改造聚焦“我的策略”和“创建策略”工作区：

- “我的策略”改为可操作的策略列表与独立“回测与模拟”页签，移除无法点击、语义不清的标题卡片。
- 策略卡片增加创建时间、验证状态、回测状态，并提供“查看策略”“快速回测”“分享到策略广场”。
- 自用策略只有在用户明确点击分享时才切换为策略广场投稿；仍必须通过 `STANDARD_VERIFIED`，随后进入平台双人审核。
- 快速回测进入独立可视化工作区，显示真实服务端阶段进度、状态说明、核心指标、资金曲线和报告入口。
- 回测 API 保留原 JSON 响应，并新增 `?stream=1` 的 NDJSON 进度流。页面离开只断开进度订阅，不取消已经开始的服务端计算和报告保存。
- 创建策略页面扩展为更完整的工作区；成熟因子模板默认折叠，减少首屏拥挤。
- USDT 永续合约加载增加错误反馈和重试。Node Web/Worker 启用环境代理支持，解决受代理网络中 Binance 合约列表无法读取的问题。
- Node.js 最低版本统一提升到 22.21.0，以使用稳定的环境代理能力。

主要变更位置：

- `app/community-strategy-center.tsx`
- `app/strategy-backtest-center.tsx`
- `app/api/strategy-marketplace/[id]/backtest/route.ts`
- `app/api/strategy-marketplace/[id]/submit/route.ts`
- `app/multi-agent-research.tsx`
- `app/page.tsx`
- `app/globals.css`
- `next.config.ts`
- `package.json`

## 4. 已完成验证

本次提交前已完成：

- `node --test tests/*.test.mjs`：200 项全部通过。
- `npm run build`：通过。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 个错误；存在 7 个与本次改动无关的既有 warning，主要是图片元素和既有 effect 依赖提示。
- 真实浏览器验收：Binance USDT 永续合约接口成功返回并可选择 `BTCUSDT`。
- 真实浏览器验收：快速回测读取 1,000 根 K 线，阶段进度到达 100%，报告和资金曲线成功展示。

浏览器验收在本地开发数据库中新增了一条回测报告，属于测试数据。若迁移整个本地数据库，需要在新环境识别为验收记录，不应视为生产业绩。

## 5. 新环境启动

### 5.1 代码与依赖

```bash
node --version
npm ci
npm run postgres:migrate
npm run build
npm run dev
```

Web、Research Worker 和 Runtime Worker 分别启动：

```bash
npm run dev
npm run worker:research
npm run worker:runtime
```

Worker 不是 Web 进程的子任务。仅启动 Web 可以浏览页面，但后台研究和影子/模拟周期不会被消费。

### 5.2 配置与密钥

`.env`、`.env.local`、API Key、数据库口令、交易所凭证和加密主密钥不得放进 Git bundle。应通过密码管理器、加密磁盘或新环境的 Secret Manager 单独传输或重新创建。

如果数据库一并迁移，必须安全保留原有 `LLM_PROFILE_ENCRYPTION_KEY` 与 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`，否则数据库中已加密的模型 Profile 和交易所凭证无法解密。不要把这两个值写入交接文档。

需要通过网络代理访问交易所时，在新环境安全配置 `HTTP_PROXY`、`HTTPS_PROXY` 和必要的 `NO_PROXY`；项目脚本已设置 `NODE_USE_ENV_PROXY=1`。不得把带认证信息的代理地址提交到 Git。

### 5.3 数据库

代码迁移不包含 PostgreSQL 数据。需要保留账号、模型绑定、策略、回测报告和可恢复研究任务时，应单独执行加密备份：

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file=agentnovas-development.dump "$DATABASE_URL"
sha256sum agentnovas-development.dump
```

在新环境创建空数据库后恢复，再执行幂等迁移：

```bash
pg_restore --no-owner --no-privileges \
  --dbname="$DATABASE_URL" agentnovas-development.dump
npm run postgres:migrate
```

数据库备份包含用户和业务数据，应加密传输、限制访问，并且不得加入仓库。

## 6. 无远程推送的代码移交方式

在旧环境完成本地提交后创建单分支 Git bundle：

```bash
git status --short --branch
git bundle create ../agentnovas-codex-handoff.bundle \
  codex/three-app-riverton-split
git bundle verify ../agentnovas-codex-handoff.bundle
```

通过加密磁盘或可信文件传输把 bundle 复制到新环境，然后：

```bash
git clone agentnovas-codex-handoff.bundle agentnovas-platform
cd agentnovas-platform
git switch codex/three-app-riverton-split
git log -1 --stat
git status --short --branch
```

Git bundle 包含该分支的已提交代码和历史，不包含 `.env`、PostgreSQL、未跟踪上传文件或正在运行的进程。它不需要访问 GitHub，也不会暴露个人 GitHub 身份。

如果将来用户明确授权使用私有远程，再单独配置 Codex 提交身份和远程权限；授权前不得执行 `git push` 或创建 PR。

## 7. 新 Codex 接替提示词

在新环境用 Codex 打开仓库根目录后，可直接发送：

> 请先完整阅读 `AGENTS.md`、`docs/DEVELOPMENT_HANDOFF.md`、相关 ADR 和 `git log -1 --stat`，然后检查 `git status --short --branch`。继续在 `codex/three-app-riverton-split` 分支工作。不得推送远程或创建 PR，除非我明确授权。先报告当前架构、可运行状态和未完成事项，再开始修改。

Codex 仍然是同类开发代理，但新任务不会天然拥有旧聊天的短期记忆；仓库中的规则、交接文档、ADR、测试和 Git 历史才是可持续上下文。

## 8. 接管核验清单

- 分支为 `codex/three-app-riverton-split`，工作区干净，最新提交与旧环境一致。
- Node.js 不低于 22.21.0，`npm ci` 成功。
- PostgreSQL 恢复后的关键表行数和备份 SHA-256 记录一致，迁移完成。
- 登录、多租户隔离、模型角色绑定、交易所账户读取正常。
- `npm run build`、`node --test tests/*.test.mjs` 和 `npm run lint` 结果与交接基线一致。
- Web、Research Worker、Runtime Worker 分别启动，健康检查和租约正常。
- 合约选择、标准模式研究、SSE/轮询恢复、候选保存、动态回测、影子盘和模拟盘至少各完成一次验收。
- 客户响应和日志不显示供应商 Key、完整接口地址、数据库口令或隐藏推理。

## 9. 已知边界与后续工作

- 动态历史回测已经进入独立工作区；模拟盘仍由保存后的策略版本和 Runtime Worker 驱动，不会因为点击“快速回测”而自动部署。
- 真实永续订单路由仍关闭，任何后续开放都必须进行独立的高风险设计和安全评审。
- 生产 Linux 部署、真实域名切换和生产数据库迁移尚未在本次本地提交中执行。
- 交易所公开接口的可用性取决于新环境网络；代理配置不应被误判为 Cloudflare 依赖。
- 当前 lint 的 7 个既有 warning 可在后续独立清理，不能用全局忽略规则掩盖。

## 10. 2026-08-19 Riverton 三应用、RBAC、充值账本与邮件切片

本次后续增量以本地提交 `64ba128` 为基线，新建本地分支 `codex/three-app-riverton-split`，未推送远端。

已落地：

- 三应用 audience 合同：客户端 `agentnovas.com`、运营端 `zht.agentnovas.com`、运维端 `xm.agentnovas.com`。
- 三套独立本地脚本：`npm run dev:client`、`npm run dev:operations`、`npm run dev:maintenance`；生产启动脚本也按 audience 分开。
- 登录 session 增加 `app_audience`，三个应用使用独立 Cookie；客户端保留旧 `an_session` 兼容。
- 新增 RBAC 权限目录、固定数据范围、旧角色兼容映射、派生角色降权校验、敏感权限双审规则和有效权限 API。
- 新增 RBAC 管理 API：权限目录、有效权限、角色模板、角色、分配、变更申请、审批和审计查询；变更申请使用严格区分联合类型校验并绑定应用。
- 新增 PostgreSQL 迁移 `0015_riverton_three_app_rbac_wallet.sql`，覆盖 RBAC、充值订单、双式账本、钱包余额、风险、人工操作、对账、导出和通知服务商配置。
- 新增充值/钱包 API 骨架：余额、流水、充值订单创建和查询；未配置服务商时明确拒绝生成虚假充值地址。
- 新增运营端充值 API 骨架：列表、详情、统计、人工操作申请和审批；默认脱敏 PII。
- 新增运维端邮件/支付状态 API；Resend Webhook 现在读取原始 body、校验 Svix 签名、限制 body 大小并幂等保存已验证事件。
- 新增 Notification Worker 最小 PostgreSQL outbox 消费路径：只连接 `DATABASE_URL` 业务库，使用 `SKIP LOCKED`、租约、owner fencing、有限重试和 Resend 幂等键。
- 所有用户邮件统一使用 `noreply@agentnovas.com`；已配置的邮件模板和密码重置/内部账号验证链接均指向实际存在的页面。
- 新增 Payment Worker 与 Notification Worker 启动脚本，默认通过环境变量关闭；未满足完整配置时不发送邮件。
- 新增 Riverton systemd 与 Nginx 模板，仍为 Linux/Nginx/Certbot 直连，不使用 Cloudflare Runtime 或 Redis。
- 新增 ADR：`docs/adr/0005-riverton-three-app-rbac-wallet.md`。

仍未完成或明确受限：

- 尚未把根 `app/` 真实搬迁为三个完全独立的 Next 应用；当前是同一代码基线通过 audience、端口、Cookie 和构建目录隔离。
- RBAC 管理 UI 尚未实现；API 已有最小持久化骨架。审批 API 已在同一 PostgreSQL 事务中重新校验申请、应用已批准变更、写入决定和授权审计；拒绝不会改变权限。
- 真实 USDT 托管/支付服务商尚未选型，链上自动扫描、确认、入账和对账 Worker 仍是后续实现。
- Webhook 的签名验签和事件持久化已在本切片完成；provider event 到 `notification_deliveries` 的自动映射已由第 11 节后续增量补齐。
- 未执行真实 Resend 外发；Worker 只有在生产环境开关、API key、业务数据库和 active/verified provider 配置同时满足时才会发送。

本次验证：

- `npm test`：225 项通过。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning（`<img>` 和一个既有 effect 依赖提示）。
- `npm run build`：通过，包含 `/reset-password` 和 `/verify-email` 页面。
- `npm run test:apps`：客户端、运营端、运维端构建通过。
- `git diff --check`：通过。
- 未在本次验证中发送真实邮件、调用真实 Resend、执行生产数据库迁移或执行支付操作；RBAC 双审的并发 PostgreSQL 集成验收仍未完成，Notification Worker 集成验收见第 11 节。

## 11. 2026-08-20 Resend 投递状态闭环

在本地提交 `6931162` 之后继续完成通知生产闭环：

- Resend 发送请求增加 `notification_delivery_id` 标签；Webhook 可以在发送 API 响应回写前按本地投递 ID 安全关联，避免竞态丢事件。
- 已验证的 `email.sent`、延迟、送达、打开、点击、投诉、退信、失败和抑制事件会在同一 PostgreSQL 事务中持久化并映射回 `notification_deliveries`。
- 使用 `svix-id` 去重，以事件 `created_at` 和固定优先级处理乱序；旧事件不会回退新状态，标签与 provider message ID 冲突时不会更新任一投递。
- Webhook 只在事务提交后返回 HTTP 200；合法重复事件返回 200 但不会重复应用。畸形字段、错误发件人和无效签名继续拒绝。
- Worker 回写发送结果时保留 Webhook 已确认的 `delivered`/`failed` 终态；租约 fencing 失败时日志明确报告 `fenced`，不再伪报 `sent`。
- 新增幂等迁移 `0018_resend_delivery_events.sql`，记录供应商事件类型、事件时间、provider message ID、映射投递和处理时间，并增加唯一/查询索引。
- 部署模板补齐默认关闭的 `NOTIFICATION_EMAIL_SEND_ENABLED` 二次开关；上线手册增加 Resend 事件订阅、HTTP 200、重放和回滚验收步骤。

本次验证：

- `npm test`：235 项通过，包含真实本地 PostgreSQL 的并发重复、乱序、Webhook/Worker 竞态和冲突标识测试。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning。
- `npm run test:apps`：客户端、运营端、运维端生产构建通过。
- `npm audit --omit=dev --audit-level=critical`：0 个漏洞；`git diff --check`：通过。

仍未执行真实 Resend 外发、生产 Webhook 注册或生产数据库迁移；这些操作需要生产域名、Resend 密钥和明确的发布授权。RBAC 双审的真实并发 PostgreSQL 集成验收也仍是独立后续项。

## 12. 2026-08-20 Riverton 三应用前端与运营闭环

在本地提交 `6931162` 之后继续完成“三应用一库”前端计划；本节改动和第 11 节 Resend 未提交改动均保留在当前工作区，尚未创建本地提交、推送远程或创建 PR。

已落地：

- 根页面改为服务端 audience 分发，客户端主体迁入 `apps/client/ui`；运营与运维分别使用 `apps/operations/ui`、`apps/maintenance/ui`，共享 Shell、状态组件、确认对话框、数据 Hook 与 Access Center。
- 三端稳定路由、独立登录页和 Cookie 已完成。运营端与运维端不显示注册/忘记密码入口；错误 audience 页面返回 404，未登录保留 `next` 参数，403 不循环跳转。
- 客户端补齐钱包余额/流水、充值创建/追踪和通知中心；支付服务未配置时显示真实 503 原因，不生成地址或二维码。
- 运营端补齐概览、客户、组织、充值、人工操作/双人审批、只读账本、财务、RBAC 和授权审计工作区。
- 运营客户、充值、账本和财务接口接入当前应用 RBAC 与数据范围；充值列表/详情使用一致 PII 脱敏，人工操作禁止自审和重复决定。
- RBAC 列表和变更强制按当前 audience 过滤；敏感角色创建/分配/撤销进入双审，批准后的草稿角色可填写原因后发布并写入授权审计。
- 运维端补齐系统健康、模型 Profile、Agent 绑定、邮件、支付、RBAC 和审计；API/UI 不回显密钥、完整端点或 Webhook payload，并准确区分“已配置”“已启用”“正在运行”和“已配置但未发送”。
- 继承远端 `main` 的作用域紧急暂停：运维端按 PLATFORM/ORGANIZATION 范围暂停新开仓，策略开启与恢复均检查停控状态；可选自动平仓严格限定为 OKX Demo，不连接生产订单路由。
- 继承远端客服与品牌功能：运维端维护公开品牌、客服和公告字段，Telegram URL 强制 HTTPS 与域名白名单；客户端显示 Riverton Capital 和真实客服渠道，未配置时不生成虚假工单成功。
- `packages/contracts` 增加三端 UI 使用的 camelCase 响应合同、状态与格式化函数；组件不直接消费数据库 snake_case 行。

真实浏览器验收使用隔离 Chrome Profile 和一次性 PostgreSQL Schema 完成，覆盖 Client、Operations 申请人、Operations 审批人和 Maintenance 管理员。已验证三套 Cookie 隔离、充值未配置、PII 权限差异、资金操作第二人审批、角色应用隔离、模型/支付/邮件不泄密、键盘入口和 320/768/1024/1440 四档布局。唯一控制台错误是测试主动触发的预期支付未配置 503；测试服务已停止，一次性 Schema 已清理。

最终验证：

- `npm test`：259 项通过，包含三端 UI 合同、RBAC audience 隔离、数据范围、充值脱敏、审批冲突、Resend/PostgreSQL 并发、远端功能继承与原有客户端回归。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning。
- `npm run test:apps`：Client、Operations、Maintenance 三端生产构建全部通过，每端收集 95 个路由。
- `git diff --check` 与新增文件尾随空白检查：通过。
- 最终安全审查补齐模型 API 回执裁剪、角色模板 UI、角色管理/分配/审批权限分离、直接撤销防绕过、Client-only 注册/找回、敏感测试原因审计和精确稳定路由。

仍保持的边界：

- 未启用真实永续订单、真实支付、邮件外发、自动资金执行或生产迁移。
- 组织树和部分历史财务写接口仍保留旧角色兼容来源；新三端页面只暴露已接入 RBAC/data scope 的读取与申请流程。

## 13. 2026-08-20 七智能体说明书对齐与系统评估

根据《七智能体动态策略系统_用户说明书》重新核对 Client 交易大厅后，确认第 12 节的“三应用前端完成”只代表基础页面和部分 API 切片完成，不能代表旧后台能力、七智能体产品合同、安全收口和生产验收全部完成。

本轮新增并作为最新真源：

- `docs/product/PRD.md`
- `docs/product/SEVEN_AGENT_TRADING_HALL.md`
- `docs/specs/SYSTEM_SPEC.md` 与三应用 Spec
- `docs/architecture/CAPABILITY_MIGRATION_MATRIX.md`
- `docs/review/SYSTEM_ASSESSMENT_2026-08-20.md`
- `docs/api/API_CATALOG.md` 与核心 OpenAPI
- `docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md`
- `docs/roadmap/CONTROLLED_BETA_ROADMAP.md`
- ADR-0006/0007

关键校正：

- 三张官方策略卡目标为 BTC/ETH/SOL 的 USDT 现货；现有 1x 永续研究/回测属于独立模拟产品，不得冒充官方现货实盘。
- 七角色应为市场、技术、策略研究、反方、风险、AI 最终决策和执行；现有 runtime 的 `audit` 是 legacy 审计事件，不是 AI 决策官。
- 平台服务钱包仅支付会员/AI 服务，交易资金留在客户交易所。
- Client Hall 和 Meeting 已删除硬编码实时数据、fallback 业绩、静态会议和无行为紧急停止；无数据时显示真实空态。
- 131 个 API route 中仍有大量 legacy session/role 接口；Operations 旧能力未全部迁移；Maintenance Worker 健康缺真实心跳。
- 当前测试仍包含大量源码合同；rendered HTML 已不依赖 ignored/stale `dist`，CI 增加了真实 production HTML 冒烟。

本轮七智能体代码切片：

- `packages/contracts/src/trading-hall.ts` 固定七角色、三卡参数、现货产品边界和决策轮完整性。
- Runtime 新周期按市场、技术、策略、反方、风险、AI 最终决策、执行顺序记录；旧 audit 只作为 legacy 审计证据。
- `/api/trading-hall` 仅返回显式安全字段，不返回原始 runtime payload；Hall/Meeting 使用真实接口和空/错/加载状态。
- Client 首屏与策略广场同步使用七角色/三卡真源，删除静态报价、风险指数、延迟、假在线状态、假走势图和预计月化目标。
- `0020_runtime_final_decision.sql` 兼容旧 audit 并允许新 `decision` 事件；只在本地测试库执行，未执行生产迁移。
- 全量 268 个测试、TypeScript、Lint、三端构建和 Client production HTML 冒烟已通过；Lint 保留 7 个既有 warning。

`tasks/todo.md` 已改为 CURRENT/PARTIAL/TARGET/BLOCKED 证据状态。未经后续 Gate 验收，不得再对团队宣称“三端全部完成”或“生产就绪”。
- 真实支付服务商、链上扫描/入账、自动对账、客服工单、自动导出和功能开关编辑不在本阶段扩展范围。
- 当前 lint 保留 7 个既有 warning；没有新增全局忽略规则。

运行、路由、权限和验收说明见 `docs/runbooks/riverton-three-app-ui.md`。
