# AI 控制面可复用组件规格

状态：`TARGET_TRUTH / CANDIDATE_COMPLETE`

日期：2026-08-30

## 1. Objective

把现有 Maintenance「模型与 Agent」「AI 用量」从 AgentNovas 专用页面升级为可复用的 AI 控制面，同时保持
Client、Research 与 Runtime 的确定性安全边界。目标用户是维护平台模型配置、可靠性和成本的技术管理员；包的
消费者是未来需要复用同一模型配置域与 React 管理器的其他项目。

成功结果：

- `@agentnovas/ai-control-plane` 提供无框架、无 I/O 的核心合同与状态派生。
- `@agentnovas/ai-control-plane-react` 提供注入式数据源、权限、文案和样式的可访问管理器。
- AgentNovas 采用 Connection → Deployment → Binding Policy 三层配置，保留不可变修订和旧 API 兼容。
- 浏览器和三个 Web 应用不能取得模型 Key；Secret Broker 负责密钥落盘，loopback AI Gateway 负责 Provider 调用。
- Client、Research、Runtime 和 Probe 进入统一用量事件；Provider 成本、平台 Credits 与未定价状态分开。
- 所有真实 Provider 调用和外部 Worker 继续默认关闭。

## 2. Tech stack and commands

- Node.js `>=22.21.0`、TypeScript 5.9、React 19、Next.js 16、PostgreSQL 16。
- 不新增 Redis、Cloudflare Runtime 或第三方运行时依赖；PostgreSQL 仍是唯一持久化真源。
- 包构建：`npm run build:packages`
- 包测试：`npm run test:packages`
- 打包验收：`npm run pack:packages`
- 项目测试：`npm test`
- 类型检查：`npx tsc --noEmit --incremental false`
- 静态门禁：`npm run lint && npm run quality:boundaries && npm run quality:key-custody`
- 三端构建：`npm run test:apps`
- 浏览器验收：`npm run test:e2e`

## 3. Resource model

### 3.1 Provider Connection

Connection 表示一个 Provider 协议和端点；敏感凭证只以 `secretRef` 出现在控制面。Connection 修改创建不可变
revision。AgentNovas 首版只接受公共 HTTPS，并拒绝账号密码、查询参数、重定向、私网/保留地址和 DNS
rebinding。其他宿主可以通过 `EndpointPolicy` 提供自己的网络策略。

### 3.2 Model Deployment

Deployment 表示 Connection 上的一个模型部署，保存模型 ID、能力声明、调用默认值、可选费率修订和启停状态。
能力至少包含上下文/输出上限、文本输入输出、流式和结构化输出。任何变更生成不可变 revision。

### 3.3 Binding Policy

Binding Policy 以 `consumer.role` 唯一标识业务角色；最多包含一个 primary 和两个有序 fallback。调用开始时固定
policy、deployment 和 connection revision，后续配置变化不改变已开始的调用。

固定角色：

- `research.requirements`
- `research.market_regime`
- `research.proposal_a`
- `research.proposal_b`
- `research.adversarial_review`
- `research.risk_review`
- `research.report`
- `runtime.market_summary`
- `runtime.adversarial_explanation`
- `runtime.risk_explanation`
- `client.assistant_message`
- `client.strategy_generation`

七智能体产品阶段是独立的确定性目录，不属于 Binding Policy，也不得被配置为任意 LLM 调用链。

### 3.4 Probe and activation

Probe receipt 绑定规范化配置指纹，记录安全错误码、延迟、模型目录、完成时间和是否验证补全能力，不保存 Key、
Prompt 或原始 Provider payload。Connection、secret、模型或能力发生变化后旧 receipt 不再满足激活 Gate。
匹配指纹的成功 receipt 在 24 小时内允许激活；过期只改变健康显示，不中断已开始任务。

### 3.5 Invocation and fallback

每次调用使用调用方生成的 `invocationId` 与规范化 `requestHash`。同 ID、同 hash 必须重放终态；同 ID、不同
hash 必须失败关闭。仅网络错误、超时、429 和 Provider 5xx 可以进入下一个 fallback。认证、配置、输入校验、
权限、预算、用户取消和模型输出合同失败不得静默换模型。

### 3.6 Usage, rates and budgets

统一 Usage Event 记录 consumer/role/operation、调用与尝试状态、选中修订、fallback rank、Token 明细、排队/
Provider/总延迟、安全错误分类、Provider 成本、settled Credits 和测试流量标记。安全读模型排除用户原始身份、
Prompt、结果、完整端点、Provider 请求 ID 与秘密。

Rate Card 可缺省；缺省时事件为 `unpriced`。预算策略是可选软预算，默认阈值 80% 与 100%，只生成持久化告警，
不自动停业务。Gateway 的请求大小、单次 Token、并发和速率限制是独立硬门禁。P-08 未冻结前不得用预算功能
冒充固定 Credits 定价。

## 4. Public package interfaces

核心包公开：

- Types：`ProviderConnection`、`ConnectionRevision`、`ModelDeployment`、`DeploymentRevision`、
  `BindingPolicy`、`BindingTarget`、`ProbeReceipt`、`InvocationReceipt`、`UsageEvent`、
  `RateCardRevision`、`BudgetPolicy`、`RoleDescriptor`、`CapabilityRequirement`。
- Ports：`ProviderAdapter`、`EndpointPolicy`、`SecretStorePort`、`ControlPlaneRepository`、
  `InvocationGateway`、`UsageSink`、`AiControlPlaneClient`。
- Pure functions：角色验证、规范化指纹、能力匹配、配置健康派生、fallback 计划与错误分类。

React 包公开 headless resource hook 和 `AiControlPlaneManager`。宿主必须注入 `client`、`roles`、权限、`messages`、
日期/数值格式器、状态通知和 class names。包不包含 AgentNovas URL、RBAC key、翻译表、全局 CSS 或品牌颜色。

两个包首版为内部 `0.1.0` ESM 包，包含类型声明、明确 exports、README、tarball 安装例，不发布 Registry。

## 5. AgentNovas adapters

- PostgreSQL adapter 负责事务、不可变 revision、乐观并发、幂等和审计。
- OpenAI-compatible adapter 只实现 Chat Completions 与 Responses，网络和 secret 通过端口注入。
- Secret Broker 使用浏览器 AES-256-GCM envelope 与 RSA-OAEP-SHA256 wrapping；Broker 私钥只在独立进程。
- AI Gateway 只监听 loopback，独立数据库角色和受管密钥目录，不配置 Nginx 路由。
- Maintenance 保留 `/ai-strategy?tab=models|usage`；旧 `/api/admin/llm-profiles` 与绑定路由作为兼容 facade。
- `AI_GATEWAY_ENABLED` 默认 `false`。Fake Provider 只用于测试，不构成真实 Provider 验收。

## 6. Migration and compatibility

- `0093_ai_control_plane.sql`：Connection、Binding、Probe、Invocation、Usage、Rate、Budget、Alert 与安全读模型。
- `0094_ai_secret_custody.sql`：secret command/receipt、Broker/Gateway 最小权限与旧密钥迁移证据。
- 保留 `llm_profiles` 和 `llm_profile_revisions` 的 ID 与历史 FK；持久化 adapter 将其解释为 Deployment。
- 每个旧 Profile 初始映射为一个 Connection；旧 Research/Runtime binding 迁入新 policy。
- `report` 与 `proposal_a` 分别复制到显式 Client 角色；旧表作为回滚快照保留，本切片不删除。
- 旧密钥迁移工具只在隔离进程读取 `LLM_PROFILE_ENCRYPTION_KEY`；成功后 Web/普通 Worker 不再配置该变量。

## 7. Threat model

| Boundary | Abuse case | Control |
| --- | --- | --- |
| Browser → Maintenance | Key 被日志、错误或响应回显 | 浏览器 envelope；字段白名单；响应只含 `hasSecret/secretRef` 状态 |
| Maintenance → DB | 配置成功但审计失败 | mutation、revision、idempotency 与 audit 同事务 |
| DB → Broker | 密文命令被重放或替换 | command digest、lease/fencing、终态 receipt、同 ID 不同摘要拒绝 |
| Broker → filesystem | 部分写入或权限过宽 | 0700 目录、0600 临时文件、fsync/rename 原子替换、所有者核验 |
| Web/Worker → Gateway | 内网接口被滥用成任意代理 | loopback、服务鉴权、operation allowlist、请求大小/速率/并发门禁 |
| Gateway → Provider | SSRF、DNS rebinding、重定向 | 公共 HTTPS、解析全部地址、固定连接目标、redirect=error |
| Provider → caller | 恶意/畸形模型输出 | 只返回标准化数据；业务调用方继续做 DSL/JSON 白名单校验 |
| Usage view → Maintenance | PII、Prompt、Key 或完整端点泄漏 | security-barrier 安全投影、伪名化和显式列白名单 |

## 8. Code style and project structure

- 核心包函数接受明确输入并返回 discriminated union；不得读取环境变量、数据库或网络。
- 外部输入在 route/Gateway 边界校验；SQL 全部参数化；错误使用稳定 code，不回显内部错误对象。
- React 组件使用语义 HTML、可见 label、键盘原生控件、loading/error/empty 状态和 `aria-live`。
- 实现按 contract → persistence → service → route → UI 的依赖顺序增量提交，每一切片保持构建和定向测试为绿。

## 9. Testing strategy

- Small：核心资源、指纹、能力、fallback、预算与错误分类。
- Medium：包 tarball、PostgreSQL 迁移/并发、Broker 文件、Gateway localhost/Fake Provider、旧 API facade。
- Large：Maintenance 完整配置、回滚、12 角色、Usage/Budget、四断点、键盘和 axe。
- 禁止真实外部 Provider、真实交易、外部 Worker、生产数据库或生产部署参与本切片验收。

## 10. Boundaries

Always：测试先于行为实现；默认关闭；秘密零日志/零响应；确定性代码拥有 DSL、风控和订单权。

Ask first：真实 Provider smoke、Registry 发布、远程 push/PR、测试站或生产部署、删除 legacy 表/secret。

Never：客户 BYOK、Redis/Cloudflare Runtime、真实永续路由、LLM 输出执行为代码/SQL/Shell、强制删除脏工作树。

## 11. Success criteria

- 两个 tarball 可被临时项目安装、类型检查并完成 React SSR。
- 从旧 Profile/修订/绑定升级无数据丢失且迁移可重跑。
- Web 构建、API、日志和安全视图不能取得模型 Key。
- 12 角色独立显示配置、Gate、primary/fallback 和实际命中状态。
- Client、Research、Runtime、Probe 全部能产生统一、可对账事件。
- 全量 test/type/lint/boundary/key-custody/secret-scan/三端 build/browser Gate 通过。
- Research、Runtime 外部解释、真实 Provider 与真实订单保持关闭。

## 12. Open questions

无。真实价格、原生 Provider、私网端点、客户 BYOK 与公开发布均明确不属于本切片。
