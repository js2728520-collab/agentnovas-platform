# 通用版本化配置发布框架规格

状态：`PARTIAL_CURRENT`；T3.1a、T3.1b 与 T3.1c-FF1 已实现，其余 T3.1c 配置族为 Target/Blocked
日期：2026-08-24
上位真源：`../product/PRD.md` 第 10、12 节；`V3_SYSTEM_TARGET_SPEC.md` 第 10 节；`V3_MAINTENANCE_APP_TARGET_SPEC.md` 第 2–5 节

## 1. 目标

为品牌、域名、协议、功能开关、Prompt、技能和价格提供同一套不可变发布内核，使每个配置版本依次经过
`DRAFT → TESTED → APPROVED → SCHEDULED → ACTIVE → SUPERSEDED/ROLLED_BACK`，并满足：

- 配置内容创建后不可覆盖，历史消费者始终引用精确版本 ID。
- 创建者不能批准自己的版本；审批、调度、激活和回滚均追加事实并审计。
- 回滚只能引用同一配置流中曾通过测试、审批且成功生效过的版本。
- 幂等重放返回同一事实；同一配置流的并发版本号、调度和激活由 PostgreSQL 串行化。
- 时间统一存储为 `timestamptz`；外部输入必须携带明确 UTC offset，响应统一为 ISO UTC。

本规格只定义配置发布控制面。它不能打开真实交易、支付、提现、部署或绕过任一能力 Gate。

## 2. 已确认假设与分片边界

1. 通用 payload 只保存非秘密 JSON；`secret/password/token/apiKey/privateKey` 等字段必须在边界拒绝。模型、支付和集成密钥继续留在既有只写不读专用表。
2. T3.1a 交付数据库状态机、服务与受控 API；到期版本由有权限人员显式激活，不引入常驻调度 Worker。
3. T3.1b 交付 Maintenance 工作台和到期激活 Worker；Worker 只消费数据库中已测试通过、已审批且到期的版本，不能自行测试、审批、调度或回滚。
4. T3.1c 将品牌、域名、协议、功能开关、Prompt、技能和价格逐类接入；首个 `client.strategy_research` 全局功能开关已接入，具体价格、域名和设计资源继续受 P-07/P-08/P-10/P-11 阻断。
5. audience 固定为 `client/operations/maintenance/shared`；配置流以 `(kind, key, audience)` 唯一识别。
6. T3.1b 分为 UI 与 Worker 两个可独立验收的切片：工作台先行，自动到期激活器随后交付。工作台把人工提交明确称为“登记测试证据”，不能冒充自动测试；在 T3.1c 消费者接入前，active 只代表控制面 current 投影。

## 3. 数据与状态合同

### 3.1 配置版本

每个版本保存 `kind/key/audience/versionNumber/schemaVersion/payloadJson/payloadSha256/createdBy/reason/idempotency/requestId/createdAt`。
版本号在单个配置流内单调递增；payload 规范化后计算 SHA-256。版本表禁止 `UPDATE/DELETE`。

### 3.2 追加事实

- `configuration_test_results`：保存 `passed/failed`、证据摘要、执行人和原因；注册配置族由服务端测试器生成结果和摘要，其他配置族暂存外部测试证据；同一版本可重复测试，状态取最新事实。
- `configuration_approvals`：每版本只允许一个 `approve/reject` 最终决定；reviewer 必须不同于 creator。
- `configuration_schedules`：每版本只允许一个生效时间事实；只接受未来或当前的带 offset 时间。
- `configuration_activations`：以 sequence 投影每个配置流的 current；`activate` 激活目标版本，`rollback` 回到曾在同流生效过的历史版本。

所有事实表禁止 `UPDATE/DELETE`。错误操作通过后续版本或新事实纠正，不改写历史。

### 3.3 状态投影

```text
无测试事实                         -> draft
最新测试 failed                    -> test_failed
最新测试 passed、无审批             -> tested
审批 reject                        -> rejected
审批 approve、无调度                -> approved
审批 approve、有调度、未生效         -> scheduled
该版本是当前且由 activate 生效       -> active
该版本是当前且由 rollback 恢复       -> rolled_back
曾生效但已被其他版本替代              -> superseded
```

被拒绝版本不可重新进入发布链；需要修改时创建新版本。测试失败可以针对同一不可变内容重新测试。

## 4. API 合同

| 方法与路径 | 权限 | 行为 |
|---|---|---|
| `GET /api/maintenance/configuration-versions` | `maint.configuration_versions.view` | 按稳定游标查询版本、派生状态和当前版本 |
| `POST /api/maintenance/configuration-versions` | `maint.configuration_versions.manage` | 幂等创建不可变草稿 |
| `POST /api/maintenance/configuration-versions/{id}/tests` | `maint.configuration_versions.manage` | 注册族只接收原因并运行服务端确定性测试；其他族追加人工通过/失败证据 |
| `POST /api/maintenance/configuration-versions/{id}/approval` | `maint.configuration_versions.approve` | 独立 approve/reject |
| `POST /api/maintenance/configuration-versions/{id}/schedule` | `maint.configuration_versions.approve` | 登记明确时区的生效时间 |
| `POST /api/maintenance/configuration-versions/{id}/activation` | `maint.configuration_versions.activate` | 到期激活，或回滚到历史已验证版本 |

所有写 API 要求 Maintenance session、显式权限、同源校验、幂等键、requestId、3–500 字原因和审计；敏感权限在 MFA 正式开启后自动要求 recent MFA。请求体严格拒绝未知字段，单个 payload 序列化后不得超过 64 KiB。

## 5. 项目结构与代码风格

- `postgres/migrations/0069_versioned_configuration_framework.sql`：表、约束、不可变触发器和权限定义。
- `postgres/migrations/0070_configuration_activation_worker.sql`：Worker actor、到期索引、心跳类型和最小 `SECURITY DEFINER` 激活网关。
- `postgres/migrations/0071_active_feature_flag_consumer.sql`：Client 只读 current 功能开关最小权限网关。
- `lib/configuration-family-registry.ts`：注册族身份、严格 schema、服务端测试器和安全判定。
- `lib/active-feature-flags.ts`：环境 Gate、current 投影、payload 摘要复核和失败关闭。
- `lib/versioned-configuration-domain.ts`：纯输入归一化、秘密字段拒绝和状态类型。
- `lib/versioned-configuration-service.ts`：事务、并发锁、状态投影和审计。
- `lib/configuration-activation-worker.ts` 与 `scripts/configuration-activation-worker.mjs`：全局租约、候选扫描、逐项隔离处理、心跳和受限常驻循环。
- `app/api/maintenance/configuration-versions/**`：薄 Route Handlers。
- `packages/contracts/src/versioned-configuration.ts`：安全响应合同。
- `tests/versioned-configuration-*.test.mjs` 与 `tests/configuration-activation-worker-*.test.mjs`：纯函数、PostgreSQL、API policy、并发/崩溃恢复和权限合同。

Route Handler 只做鉴权、受限 body 读取和响应映射，例如：

```ts
const { user } = await requireAccessPermission(request, MANAGE_PERMISSION);
const payload = await commercialJson(request, 70_000);
return Response.json(await createConfigurationVersion(await getPostgresPool(), {
  actorUserId: user.id,
  idempotencyKey: idempotencyKey(request),
  requestId: requestId(request),
  version: payload,
}), { status: 201, headers: { "cache-control": "no-store" } });
```

SQL 只使用参数化查询；动态配置 key 永不参与 SQL 标识符、Shell、URL fetch 或 HTML 注入。

## 6. 命令与测试策略

- 定向合同：`node --test --experimental-strip-types tests/versioned-configuration-domain.test.mjs tests/versioned-configuration-postgres.test.mjs tests/versioned-configuration-contract.test.mjs tests/configuration-activation-worker-contract.test.mjs tests/configuration-activation-worker-postgres.test.mjs`
- 全量测试：`npm test`
- 类型：`./node_modules/.bin/tsc --noEmit`
- Lint：`npm run lint`
- Maintenance 构建：在 `ssh an-saas` 的 Node 22.21+ 隔离目录执行 `npm ci --include=dev && npm run build:maintenance`
- 安全：`npm run quality:secret-scan && npm audit --omit=dev --audit-level=high`

纯 domain 测试覆盖严格字段、payload 大小、秘密字段、时区和状态；PostgreSQL 测试覆盖 fresh/rerun、不可变、maker/checker、幂等冲突、并发版本号、过早激活、current 投影、合法/非法回滚、全局租约、崩溃释放、到期竞态和数据库最小权限；API 合同测试覆盖 audience、权限、recent MFA、同源、body limit 和 inventory。

## 7. 边界

**始终执行：** 服务端授权与输入校验；追加式审计；参数化 SQL；安全响应 allowlist；失败关闭；提交前测试/类型/Lint/secret scan。

**需要另行确认：** 具体域名、价格、Credits、主题资产和各配置族 schema。Worker 当前采用可配置的 5 秒扫描、60 秒 warning、300 秒 critical 工程默认值；生产容量验证后可在受限范围内调整，不改变发布状态机。

**绝不执行：** 在通用 payload 保存 secret/PII；允许创建者自审；覆盖或删除历史；让浏览器传 SQL/Shell/任意 workflow 参数；通过配置绕过真实交易、资金或部署 Gate。

## 8. T3.1a 完成标准

- 迁移、纯 domain、服务和六个 API 路径均实现并进入中央 policy inventory。
- 状态机、并发、时区、幂等、不可变和回滚 PostgreSQL 测试通过。
- 仅 Maintenance 数据库角色可访问新表，Client/Operations 明确无权限。
- 全量测试、类型、Lint、云端 Maintenance production build 和安全扫描通过。
- 本阶段不宣称 T3.1 整体完成；T3.1b-Worker 已在后续切片完成，具体配置族仍在 T3.1c。

实施结果（2026-08-24）：上述五项已通过。中央 inventory 登记 268 个 method route；
定向 domain/PostgreSQL/API 合同、1298 项全量测试、TypeScript、ESLint、secret scan 和
production dependency audit 均通过；Maintenance production build 在 `ssh an-saas` 的
Node 22.21.1 隔离容器完成。未启动服务、未迁移生产库、未部署。

## 9. T3.1b-UI 实施结果

2026-08-24 已交付 Maintenance `/configurations` 工作台和权限导航。工作台按不可变配置流
展示版本、状态、payload SHA、顶层字段差异、测试/审批/调度事实和 current 投影；提供明确
计划日期（含 DST）对应的浏览器时区 offset 与 UTC 预览，并可按稳定游标加载完整历史。草稿
创建和人工测试证据登记使用页面内审计原因直接执行，
草稿、测试、审批、调度、激活和回滚均在页面内填写审计原因后直接提交，不使用打断流程的
模态确认框。权限分离、创建者不得自审、状态机前置条件、幂等键、busy 防重复提交和不可变
审计事实保持不变。T3.1c-FF1 接入后，注册的策略研究功能开关使用专用字段和服务端测试，
激活或回滚会从下一次 Client 请求改变该模块判定；其他配置族仍只改变控制面 current 投影。

页面明确提示人工动作只是“登记测试证据”，不会冒充浏览器自动测试；在 T3.1c 消费者接入
前，active/current 也不会被描述为具体运行时已经生效。真实 Chromium 已覆盖四档宽度、axe、
键盘、资源预算、网络/控制台边界及一次无弹窗草稿创建。

## 10. T3.1b-Worker 实施结果

2026-08-24 已交付独立 Configuration Activation Worker。进程启动必须显式配置
`CONFIGURATION_ACTIVATION_WORKER_ENABLED=true`，并使用精确数据库账号
`agentnovas_configuration_activation_worker`；默认每 5 秒扫描一次、每批最多 50 条，允许范围
分别限制为 1–30 秒和 1–100 条。全局 PostgreSQL advisory lease 保证同时只有一个扫描者；
连接崩溃会由数据库自动释放 session lease。单个候选失败只回滚自身语句并继续处理后续版本。

Worker 只能读取不可变配置事实、维护自己的 `worker_instances` 心跳，并执行唯一的
`configuration_activation_worker_activate(text)` 数据库网关。它没有配置审批、调度、回滚、
秘密表、客户/支付数据或直接写 activation/audit 表的权限。`SECURITY DEFINER` 网关由 migrator
拥有，固定安全 `search_path`，撤销 PUBLIC 执行权，并在数据库当前时间下重新检查最新测试通过、
批准、到期和尚未生效；随后获取与人工激活相同的配置流事务锁，生成固定 worker 身份、原因、
幂等键、激活事实和审计事实。进程不能从参数伪造 actor、审计内容或事实 ID。

Maintenance 健康投影显示该 Worker 的配置、存活、最近成功和受限错误码；队列延迟 60 秒进入
warning、300 秒进入 critical。Container Compose 使用独立 `configuration-activation` profile，
仅连接 backplane，不具备 egress/edge 网络；systemd 和示例环境默认关闭。生产配置审计要求
专用 DSN、Maintenance/Worker 开关值一致且只报告启停状态，不回显配置值。

本切片只把已测试、已审批且到期的通用版本推进到控制面 current。后续 T3.1c-FF1 只让
`client.strategy_research` 消费该 current；不能据此声称品牌、域名、Prompt、技能或价格已经
接管运行时，也不能借 Worker 打开交易、支付、提现或部署能力。

## 11. T3.1c-FF1 全局功能开关首个垂直切片

第一条具体配置族固定为 `kind=feature_flag`、`key=client.strategy_research`、
`audience=client`、`schemaVersion=1`，payload 只允许 `{ "enabled": boolean }`。这是
“整个模块”级开关；指定用户/组织、应用版本、灰度百分比和独立启停窗口属于 T3.3 的后续
schema 版本，不在 v1 中静默猜测组合语义。

该配置遵循双重 Gate：环境变量 `STRATEGY_RESEARCH_ENABLED` 必须已经为 `true`，active
配置才能参与判定。环境 Gate 为 `false` 时，配置永远不能把能力打开；没有 active 配置时
保持当前环境 Gate 行为，避免接入瞬间改变生产状态；active 配置为 `false` 时立即失败关闭。
回滚切换控制面 current 后，下一次请求读取回滚目标，不复制第二份可覆盖状态。

草稿创建先经过注册表的严格 family/schema/key/audience 校验。Maintenance 使用服务端确定性
测试器生成 `passed/failed` 和证据 SHA-256，不接受浏览器伪造 feature flag 的测试结果；通用
人工测试证据路径暂为尚未接入的其他配置族保留。Client 数据库角色不能读取通用配置表，
只能执行一个由 migrator 拥有、固定 `search_path`、撤销 PUBLIC 权限的参数化只读网关，且
网关只返回 Client/shared 的当前 feature flag 安全投影。

运行时消费者只返回启用/禁用判定、所用版本 ID 和受限原因码，不把原始 payload 暴露给
浏览器或日志。配置缺失按既有环境 Gate；已激活配置不符合注册 schema、数据库网关异常或
payload SHA-256 不一致时失败关闭。该切片不能控制真实订单、提现/划转、支付启停、MFA、权限、部署或
任何外部写入 Gate。

Maintenance 创建表单固定首个注册族的 key、audience 和 schema，只让操作者选择开/关；测试
请求只提交审计原因，结果、tester ID 和证据摘要由服务端绑定到不可变 payload。策略研究
GET/POST 共用同一运行时判定：环境 Gate 为 false 时不查询配置；为 true 时才读取最小权限
current 网关。Client 角色没有配置底表权限，网关异常、非法 schema 或摘要不一致均返回统一
功能关闭，不泄露数据库错误或配置内容。

**验收：** 严格 schema 与未知字段拒绝；服务端测试证据确定且不可伪造；环境关闭不可被
配置开启；active `false` 能关闭现有模块；回滚恢复前一已验证版本；Client role 无底表权限。

**验证：** family 纯函数 RED/GREEN、完整迁移链 PostgreSQL/current/rollback/role 测试、
Route policy 合同、TypeScript、ESLint、全量测试、云端 Client/Maintenance production build，
以及本地真实 Chromium 的配置发布与三端空浏览器登录回归。
