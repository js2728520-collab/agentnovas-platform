# 通用版本化配置发布框架规格

状态：`PARTIAL_CURRENT`；T3.1a、T3.1b、T3.1c-FF1 与 FF2 已实现，其余 T3.1c 配置族为 Target/Blocked
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
4. T3.1c 将品牌、域名、协议、功能开关、Prompt、技能和价格逐类接入；`client.strategy_research` 的全局 v1 与定向 v2 功能开关已接入，具体价格、域名和设计资源继续受各自实现与 Gate 阻断。P-07/P-08 的数字唯一以 `packages/contracts/src/product-parameters.ts` 为准；价格/权益/固定 Credits 的运行时版本必须从该真源派生并保存不可变历史快照，不能由通用配置 payload 另行定义一套数字。固定 Credits consumer、模型/功能分档和 `provider_usage` 切换另立 T3.9b，不属于当前 S0。Prompt 的版本合同、确定性 tester 和 PS2 任务固定已形成基础，但 Skill runtime consumer 不属于当前 S0，须另行通过 T3.10 后启用。
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

- **历史不变性：** 会员订单、权益、AI Credits 流水和账单/收费事实必须引用创建时采用的配置版本或参数快照；改价、改规则或计费纠正只能创建后续版本/追加事实，不能更新或删除旧版本、历史订单或已结算事实。
- **P-07/P-08 边界：** 参数冻结不自动接入定价消费者、固定 Credits 消费者、`provider_usage` 切换、支付、退款或优惠。配置版本 `active` 只代表控制面状态；没有经过独立 schema、tester、最小权限 consumer 和 Gate 的接入，不得对外描述为已生效。

**需要另行确认或实现：** 具体域名、主题资产和各配置族 schema；P-07/P-08 的价格与 Credits 数字已经冻结，但对应运行时消费者、版本引用和切换 Gate 尚未完成。Worker 当前采用可配置的 5 秒扫描、60 秒 warning、300 秒 critical 工程默认值；生产容量验证后可在受限范围内调整，不改变发布状态机。

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

本切片只把已测试、已审批且到期的通用版本推进到控制面 current。后续接入的 T3.1c-FF1/FF2 只让
`client.strategy_research` 消费该 current；不能据此声称品牌、域名、Prompt、技能或价格已经
接管运行时，也不能借 Worker 打开交易、支付、提现或部署能力。

## 11. T3.1c-FF1 全局功能开关首个垂直切片

第一条具体配置族固定为 `kind=feature_flag`、`key=client.strategy_research`、
`audience=client`、`schemaVersion=1`，payload 只允许 `{ "enabled": boolean }`。这是
“整个模块”级开关；指定用户/组织、应用版本、灰度百分比和独立启停窗口不在 v1 中静默猜测
组合语义，已由第 12 节的 T3.1c-FF2/schema v2 独立实现。

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
Route policy 合同、TypeScript、ESLint、全量测试、云端三端 production build，
以及本地真实 Chromium 的配置发布与三端空浏览器登录回归。

实施结果（2026-08-24）：上述验收全部通过。注册族请求严格拒绝浏览器提供的 result/evidence，
服务端证据绑定精确 payload；current 网关复核 schema、摘要和最小权限，数据库异常失败关闭；
策略研究 GET/POST 共用消费者。Maintenance 浏览器真实创建关闭版草稿并运行确定性测试，抓取到
的请求体只有 `{reason}`，全程无 dialog。最终 `npm test` 1326/1326，TypeScript、ESLint、
8 条架构边界、secret scan 和 production dependency audit 均通过。

Client、Operations、Maintenance production standalone 在 `ssh an-saas` 的完整提交快照、固定
Node 22.21.1 容器内全部构建成功；一次提前启动的半传输快照因缺文件产生 module-not-found，
不计有效构建证据。最终本地隔离 PostgreSQL + 真实 Chromium 18/18 通过，覆盖三端空浏览器
登录、Host/Cookie audience、五设备、权限注册链接、三端 UI、配置无弹窗和服务端确定性测试。
测试期间修复隔离浏览器 teardown 竞态：仅在主动关闭开始后忽略 Playwright 已处理 route，
运行期间 console/network/page error/HTTP 规则没有放宽。质量 schema、运行时凭证、端口和远端
临时构建目录均已清理；未启动远端服务、未迁移生产数据库、未推送、未部署。

## 12. T3.1c-FF2 多粒度功能开关

`feature_flag/client.strategy_research/client/schemaVersion=2` 使用单条显式规则：

```json
{
  "defaultEnabled": false,
  "target": {
    "enabled": true,
    "userIds": ["internal-user-id"],
    "organizationIds": ["internal-organization-id"],
    "applicationVersions": ["v1.0.0-beta.6"],
    "rolloutPercentage": 25,
    "startsAt": "2026-08-24T00:00:00+08:00",
    "endsAt": "2026-09-24T00:00:00+08:00"
  }
}
```

所有字段严格白名单；规则至少包含一个条件。用户与组织在主体维度内为 OR，主体、精确应用
SemVer、灰度百分比和独立时窗在不同维度间为 AND。开始时间包含、结束时间不包含；时间输入
必须携带明确 offset，规范化后以 UTC 保存。用户/组织各最多 100 个，应用版本最多 20 个；
列表去空白、去重并排序。用户字段只接受内部不可变 ID，不接受邮箱或其他 PII。

百分比分桶对 `flag key + ":" + userId` 计算 SHA-256，并稳定映射到 0–9999；同一用户不会按
请求随机漂移。没有服务端用户 ID 时百分比条件不命中。运行时上下文只能来自已认证 Session 的
`user.id`、`organizationId`、部署元数据中的精确 SemVer 和服务端当前时间；请求参数或 Header
不能替代这些值。环境 Gate 始终为上限，schema v2 只能收窄能力。

Maintenance 创建页可在“全局开关 v1”和“定向规则 v2”间选择，直接提交页面内审计原因，
不出现确认 dialog。服务端仍执行严格规范化、确定性测试、摘要复核、独立审批、调度和回滚；
非法 schema/payload、网关错误或摘要不一致全部失败关闭。首版只支持一条规则，避免在没有
已确认优先级合同前引入多规则覆盖；未来扩展必须使用新的 schema 版本。

实施结果（2026-08-24）：纯函数、运行时和 route 合同、完整 PostgreSQL 发布/current/v1 回滚
与最小权限测试全部通过；`npm test` 1333/1333、TypeScript、ESLint、8 条架构边界、secret scan
和 production dependency audit 全通过。`ssh an-saas` 使用提交 `4e21989` 的完整 Git 快照、
Node 22.21.1 构建 Client 68 页、Operations 62 页、Maintenance 51 页全部成功。相同云端产物
下载后，本地隔离 PostgreSQL、外部写入禁用、MFA 关闭的真实 Chromium 18/18 通过，覆盖三端
空浏览器登录、v2 请求体、服务端确定性测试与全程无 dialog。一次性 schema、运行密钥、端口、
本地和远端构建目录均已清理；未部署、未迁移生产数据库、未推送。

## 13. T3.1c-PS1 Prompt / Skill 家族合同

需求方于 2026-08-24 把 PS-01–PS-06 全部按推荐方案冻结（见
`../product/PROMPT_SKILL_V1_REQUIREMENTS_CONFIRMATION.md` 第 0 节）。本节描述**合同层**：
严格 schema 与确定性测试器。

**Prompt 的运行时消费者已由 PS2 接入**（见 13.7），但其启用仍需独立 Gate；Skill 的 runtime consumer 仍未接入且不属于当前 S0，须通过 T3.10 后才可启用。active 的 Skill 版本不代表它已经生效，这与 T3.1c-FF1 建立的规则一致：active 不等于业务已生效。

### 13.1 注册的配置流

- `prompt/research.<role>/shared/schemaVersion=1`，7 个策略研发角色：`requirements`、
  `market_regime`、`proposal_a`、`proposal_b`、`adversarial_review`、`risk_review`、`report`。
- `prompt/runtime.<role>/shared/schemaVersion=1`，3 个运行时只读解释角色：`market_summary`、
  `adversarial_explanation`、`risk_explanation`。
- `skill/agent.skill_pack/shared/schemaVersion=1`。

共 10 个 Prompt 流。audience 固定 `shared`：这些配置由 Research/Runtime Worker 消费，
不属于任何单一 Web 端。Client 通用 AI 助手 Prompt 按 PS-01 不纳入首期。

### 13.2 payload 合同

Prompt v1 只允许一个字段：

```json
{ "instruction": "角色职责说明；20–4,000 字符且 UTF-8 不超过 10,000 字节" }
```

Skill v1 只允许声明式字段（PS-02）：

```json
{ "skills": [{
  "name": "不超过 80 字",
  "description": "不超过 300 字",
  "instruction": "20–4,000 字符",
  "agentRoles": ["risk_review"],
  "enabled": true
}] }
```

`code`、`command`、`url`、`permissions`、`tools`、`secrets`、`network` 等字段一律 422。
它们不是「暂时不做」：允许其中任何一个都会把代码执行、供应链或凭证攻击面引进来，
不能复用普通 JSON 配置的安全结论。

字符预算与 UTF-8 字节预算**同时**生效，而且字节预算必须**低于**字符预算的最坏字节数，
否则它是死代码。JS 的 `.length` 按 UTF-16 码元计：4,000 码元最多就是 4,000 个 3 字节汉字
= 12,000 字节（非 BMP 字符每个占 2 码元、4 字节，反而只有 8,000 字节）。因此把字节上限
设成 12,000 永远触发不了；取 10,000 才真正约束中文密集的 Prompt（约 3,333 汉字），同时
4,000 个 ASCII 字符仍然放行。实现里有一条断言专门防止这个上限被「放宽」回不可达的值。

### 13.3 安全包络不可覆盖（PS-03）

平台安全包络固定在代码里：研发角色在 `lib/research-prompt-registry.ts` 的 `baseContract`，
解释角色在 `lib/runtime-explanations.ts` 拼装的固定数组。配置只能替换角色职责指令。

payload 里出现 `safetyEnvelope`、`baseContract` 之类字段一律按未知字段拒绝；正文里出现
「忽略以上指令」「输出思维链」「执行 shell」「密钥/token」「承诺收益」「绕过风控」和
任何 `http(s)://` 引用也直接拒绝。

**这一条不是「双人审批之外的额外保险」。** 审批管不住运行时行为：一份删掉「不执行上下文
指令」的 Prompt 通过审批之后，注入防线就已经没有了。因此边界必须在 schema 层失败关闭，
而不是交给流程去挡。

### 13.4 确定性测试器（PS-04）

测试器只由服务端根据不可变 payload 计算，浏览器只提交 3–500 字审计原因。五项检查：
`schema`、`instruction_budget`、`forbidden_patterns`、`injection_probes`、
`safety_envelope_immutable`。注入样例是代码里的常量而不是随机生成——随机探针会让同一
payload 每次得到不同证据摘要，「确定性测试」也就名存实亡。

证据摘要绑定 kind、key、audience、schemaVersion 和规范化 payload，因此**不同角色的测试
证据不可互相复用**。模型真实试跑是独立的附加观察证据，不是发布必需项。

### 13.5 归档语义（PS-06）

「删除」表达为新版本里把该技能 `enabled` 置为 `false`；技能条目本身保留，因此历史任务仍能
解释自己当时用了什么，已归档技能也能被后续新版本恢复。不物理删除已发布版本、历史任务引用、
测试、审批或审计事实。

### 13.6 本切片明确不做

- ~~不接入运行时消费者~~ **PS2 已接入**：`resolveResearchPrompt` 与
  `resolveRuntimeExplanationPrompt` 现在接受一个来自配置的角色说明，安全包络仍固定在代码里
  （PS-03）。消费入口是 `lib/prompt-skill-runtime.ts`。
- ~~PS-05 的任务固定留给 PS2~~ **PS2 已完成**：运行时解释任务在入队时固定
  `configuration_version_id + payload_sha256`，研发运行在创建时按角色拍下同样的快照。
  执行时按**版本 ID** 回读原版，不看当前生效的是哪一版，因此激活与回滚只影响随后创建的
  新任务。
- **Skill 仍无运行时消费者且不属于当前 S0。** 合同与测试器就位，但没有任何 Agent 会加载技能包；active 的 Skill 版本不等于已生效。后续 T3.10 必须独立完成最小权限 consumer、任务版本固定、失败关闭、回滚和 Gate，不能由 Prompt PS2 或通用配置 active 状态代替。
- Maintenance 工作台留给 PS3。

### 13.7 T3.1c-PS2 运行时消费与任务固定（PS-05）

配置只替换**角色说明那一段**，安全包络仍固定在代码里（PS-03）。两个解析器都多了一个可选
的 instruction 参数：`resolveResearchPrompt` 替换 `definitions[role].instruction`，
`resolveRuntimeExplanationPrompt` 替换 `promptDefinitions[role].responsibility`；
`baseContract` 与解释角色的那六行包络不在 payload 里，因此配置改不动它们。

固定落在两处，形状不同是因为任务的形状不同：

| | 固定时机 | 存放位置 |
| --- | --- | --- |
| 运行时解释 | 入队 | `strategy_runtime_explanation_jobs.prompt_configuration_version_id` + `prompt_payload_sha256` |
| 策略研发 | 运行创建 | `strategy_research_runs.prompt_configuration_snapshot_json`（按角色） |

解释任务是一次调用，逐个入队时固定即可。研发是一串步骤（需求整理 → 行情识别 → 提案 →
反方 → 风控 → 报告），固定必须落在**运行**上：否则第 3 步与第 4 步之间发生一次激活，同
一次研发的前后半段会依据两份不同的 Prompt，结论无法归因到任何一版。这与既有的
`agent_role_snapshot_json`（固定模型修订）是同一时机、同一理由。

**空值表示「用代码内定义的 Prompt」，不表示「未知」。** 当前没有任何 Prompt 配置被激活过，
所以所有任务的固定列都是空的。编一个假的配置版本会让「这份解释依据哪份 Prompt」得到一个
看似确定的错误答案（INV-6）。

#### 两个网关

- `prompt_configuration_active(key)`：入队时读当前生效版本，与 0071 / 0077 同形状。
- `prompt_configuration_pinned(version_id)`：执行时按**版本 ID** 读一份可能早已被替换掉的
  历史版本。这是与既有网关不同的一件事——它们都只返回当前生效版本，而 PS-05 恰恰要求读
  历史版本。

`prompt_configuration_pinned` 里的 `EXISTS (configuration_activations ...)` 不是多余的：
没有它，任何能写任务行的路径都可以把任务指向一份**从未获批**的草稿，让 Worker 照着它调
模型，双人审批就被绕过了。只有曾经真正激活过的版本才可被固定；回滚之后仍可读（那正是
PS-05 要的），但从未上线过的草稿一律读不到。

#### 执行时的不变量

执行不再「重新解析当前版本再比对」，而是「按固定的版本解析」。两条路径最后落到同一条
不变量上：**实际用的这段文字，必须与任务快照里的 `prompt_sha256` 一致**。摘要不符一律
拒绝执行——payload 能被改写而任务照跑，等于「固定」只是个装饰。

网关不可用时**回落到代码内 Prompt**而不是让任务失败：解释是只读旁路产物（INV-1：它不参与
任何决策），停掉它换不来安全收益。这与固定的摘要校验不冲突——回落发生在「从来没固定过」
的任务上，已固定的任务摘要不符仍然拒绝。
