# Restricted CI/CD Delegation Spec

> 文档状态：`TARGET_TRUTH / T8.2D1_WORKFLOW_AUDITOR_RECOVERY_COMPLETE / APPROVED_FOR_LIVE_FIXTURE_AND_G7_ONLY`。
> 专用 workflow、独立只读 Auditor、数据库内 v4 Auditor-trust-bound reservation、实际 restore rehearsal 与 G7 manifest
> 生成器已完成；下一步仅放行经授权的真实 provider fixture、失陷演练及 G7。当前运行时仍只登记发布证据，不具备 CI/CD trigger；任何代码或配置
> 存在都不能在 G7 和用户首次生产授权前改变该 Current 事实。

状态：T8.1a–T8.2c、T8.2d1 complete；approved only for live fixture/rehearsal/G7；runtime 未获启用授权

目标阶段：V3 Phase 8

决策真源：ADR-0024

## 1. 目标、非目标和安全主张

目标是在不让 Maintenance Web、GitHub Runner 或浏览器获得长期基础设施凭证的前提下，发起固定的
staging、production 和 rollback 流程，并只在 provider 身份、平台授权、环境 fencing、不可变制品和目标
签名回执一致时追加 ADR-0014 发布事实。

安全主张：未经平台授权、批准已失效、control/workflow 漂移、并发 current 变化、GitHub rerun、伪造
webhook 或扩大 GitHub App 权限均不能切换 current，也不能生成平台接受的 succeeded deployment。已被
平台精确授权的 Runner 若运行中失陷，可能启动该批准 snapshot 本身，但不能改变 artifact/action/
environment、创建第二个 operation 或伪造 target receipt/current。

本规格不实现或授权任意 Shell/SSH/SQL、任意 Git ref/workflow/inputs、浏览器凭证管理、自动 push/tag/
merge、自动建 GitHub App、数据库 down migration、生产部署或真实 CI/CD 启用。

## 2. 信任边界

```text
Maintenance browser
  -> Maintenance Web (session/RBAC/recent MFA/origin/idempotency)
  -> PostgreSQL one-action authority (raw session -> server-side session hash binding)
  -> release-identity-verifier (WebAuthn policy; no raw session or mutation authority)
  -> release-control (no WebAuthn policy; exact assertion + mutation digest only)
  -> PostgreSQL atomic assertion consumption + append-only command/approval/activation facts
  -> release-orchestrator-worker (lease + fixed provider binding)
  -> GitHub App installation token (one repository + Actions write/Contents read + <= 1h)
  -> fixed workflow at verified control commit/digest

fixed workflow
  -> protected GitHub environment job (no target/long-term secret)
  -> GitHub OIDC identity (exact repository/workflow/run/attempt/environment/jti)
  -> target deployment gateway validates OIDC
  -> target narrow DB gateway atomically reserves authorization + operation
  -> target environment mutex + generation + expected-current CAS
  -> target-signed deployment receipt

GitHub webhook
  -> ingress raw-body HMAC + delivery replay key
  -> bounded normalized delivery fact
  -> Worker exact-run lookup/reconciliation
  -> receipt verification + append-only release deployment fact
```

| 域 | 可以持有 | 明确禁止 |
| --- | --- | --- |
| Maintenance Web | session、命令/审批 gateway | GitHub/target secret、provider egress、任意部署命令 |
| Identity verifier | WebAuthn policy/public key、assertion registrar/resolver、独立 HTTP/DB 身份 | raw session、control secret、发布 mutation、发布事实表读取 |
| Release control | exact mutation executor、独立 HTTP/DB 身份 | WebAuthn policy/public key、registrar、裸 mutation gateway、发布事实表读取 |
| Worker | App private key file、固定 binding、租赁/核验 gateway | Web session、审批权、目标长期凭证、客户数据 |
| Ingress | webhook secret、delivery gateway | App private key、provider dispatch、OIDC/grant signer、审批权 |
| Provider Security Auditor | 独立只读 App key、run-policy attestation key、append-policy gateway | Actions write/dispatch、命令/审批、target 能力、客户数据 |
| GitHub Runner | 单次 OIDC token、固定输入 | 长期 SSH/DB/Docker 凭证、业务 DB、current 写权限 |
| Target gateway | 环境部署能力、receipt key、fencing gateway | 任意 shell API、批准创建、GitHub App private key |

GitHub 组织/仓库管理员和目标 gateway 管理员是外部高权限边界，必须人员分离。平台能够检测 provider
binding 漂移并失败关闭，但不能声称约束已恶意接管整个 GitHub 组织和目标基础设施的同一管理员。

## 3. 固定 provider binding 与 readiness

Worker 启动配置必须严格满足以下合同；未知字段、缺项或运行时漂移均令 readiness=false 且不租赁命令：

| 字段 | 约束 |
| --- | --- |
| provider | 固定 `github_actions` |
| apiVersion | 固定 `2026-03-10` |
| apiBaseUrl | 固定 `https://api.github.com`；非 GHE 不可覆盖 |
| repositoryOwner/name/id | 单一仓库，ID 为最终身份，不来自 DB/UI |
| appId/installationId/accountId | private 专用 App；registration owner/identity 与 allowlist 完全一致。private 可见性由 G7 管理面证据证明，REST `GET /app` 不提供该字段 |
| appPrivateKeyFile | 绝对 secret 文件，权限最多 `0440`，不接受内联 key |
| workflowId/path | 固定数字 ID 与固定 path，二者都核对 |
| workflowControlRef | 受保护 control tag，仅用于 dispatch ref |
| controlCommitSha | 完整 40 位 SHA，来自当前 G7 activation |
| workflowSha256 | control commit 上 workflow 内容 SHA-256 |
| oidcAudience | 固定 target deployment gateway audience |
| runnerEnvironment | 明确 `github-hosted` 或专用 `self-hosted` policy |
| environmentPolicyDigest | environment/ruleset/reviewer/admin-bypass 规范化配置 SHA-256 |
| productionReviewerAllowlistDigest | activation 时冻结的个人 reviewer numeric ID/type 集合 SHA-256 |
| runnerPolicyDigest | runner group ID、repository allowlist、labels、ephemeral policy SHA-256 |
| receiptTrustDigest | receipt 公钥集、Ed25519、RFC 8785 canonicalization 策略 SHA-256 |
| auditorTrustDigest | Auditor App/binding 与 attestation 公钥集/算法策略 SHA-256 |

每次 mint installation token 前必须：

1. 使用 App JWT 枚举完整 installation 集合，要求只有唯一 allowlisted installation；核对 App registration
   owner/identity、installation account/repository selection/suspended 状态；private 可见性由 activation 前的
   G7 管理面证据冻结，不能依赖 GitHub REST 响应中并不存在的 `public` 字段；
2. 请求体显式限定唯一 `repository_ids: [repositoryId]` 和
   `permissions: {actions: write, contents: read}`；`contents:read` 仅用于 ref/content drift 核验；
3. 核对令牌响应 repository 与 permissions 精确相等，不接受 superset；GitHub 隐式返回的
   `metadata: read` 是唯一允许的附加项，请求体仍只发送 `actions: write, contents: read`；
4. 令牌仅存在函数局部内存，最长一小时，不进入日志/错误/DB/telemetry；
5. 新增第二个 installation、owner 变化、installation 扩权、仓库选择变化或 provider 响应合同变化都拉低
   readiness；App 可见性变化由 G7/独立 Auditor 的管理面复核拉低 activation readiness。

`providerBindingSha256` 不是人工填写的自由摘要。Worker 对以下有序 JSON 字段重算 SHA-256：provider、API
版本/基址、repository owner/name/id、App/installation/account ID、workflow ID/path/control ref/control commit/
content digest、OIDC audience 与 runner environment。Maintenance 只可通过 owner-controlled gateway 记录同一份
不可变 binding material；claim 必须同时匹配摘要和完整 material，数据库绑定 run URL 也从该已匹配材料派生。

每次 lease 前必须解析 control tag，核对完整 commit SHA、workflow ID/path/content digest。GitHub ruleset/
protected tag 是纵深防御，不代替上述核验。

独立 `release-provider-security-auditor` 在 activation、lease 前和 exact environment job 启动后核对
environment/ruleset/runner-group 配置摘要。它使用另一个 private 专用 GitHub App 和独立 Linux secret；
每次签发最长一小时、不可 dispatch/write 的 token，只允许目标 repository 的 `Administration: read`、
`Actions: read`、metadata read，以及目标 organization 的 `Organization self-hosted runners: read`。Auditor
同样必须枚举完整 App installation 集合、要求唯一 allowlisted installation，并核对 token 响应权限精确
相等。其调用端点只允许 GET exact environment/ruleset、run/attempt/job/approvals 和 runner-group 配置；
即使 `Actions: read` 技术上可读更多资源，也明确禁止 logs、artifacts、cache 和其他 run 内容。其 egress
仅允许 GitHub API，数据库角色只能执行 `append_release_run_policy_attestation(...)`，不能读写命令、
审批、activation、授权或 deployment。

environment job 启动后，target 以 exact run OIDC 身份请求 Auditor 重新查询 exact run/attempt/job、当前
environment/ruleset、实际 runner group/labels，并调用
`GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals` 取得 exact run review history。可观察到的 rejected、
自审、非冻结 reviewer、环境不匹配或 runner/config 漂移失败关闭。若 GitHub environment 配置使用 team
reviewer，activation 创建时把当时允许的个人 reviewer numeric ID/type 展开冻结；Auditor 不依赖事后
team membership。

GitHub 官方 approvals schema 没有“普通批准/管理员 bypass”判别字段，因此 Auditor 不能证明 absence of
bypass，也不能把 review 写成平台授权真源。临时移除/恢复规则或管理员 bypass 属于 GitHub 管理员外部
信任边界；它最多削弱 provider 的第二道防线。target reservation 无论 attestation 内容如何，仍必须独立
满足平台 maker/checker、first production enablement、exact platform-bound run/OIDC、snapshot/generation/
current/stop。换言之，`provider_policy_observed` 绝不等于 `platform_authorized`。

Auditor 用独立 Ed25519 key 对 RFC 8785 attestation 签名并通过 gateway 追加事实，至少绑定 repository/
workflow/run/attempt/job、environment ID/name、review event/decision/reviewer numeric ID/type/time 与完整审批
证据规范化 digest、triggering actor、
runner identity/group/labels、两类 policy digest、OIDC `jti` digest、issued/expires time（短于 target
reservation 窗口）、nonce 和 key ID。Auditor key-set/算法摘要绑定 activation；attestation nonce 唯一。
target reservation 必须在同一事务中核验并消费 exact run 的未过期 attestation，lease-time digest 不能替代。

review history 与 `Actions: read` 的官方合同：
<https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10#get-the-review-history-for-a-workflow-run>。

若仓库套餐/API 无法读取 required reviewers、prevent self-review、当前 admin-bypass 配置、deployment ref
policy、runner group/repository allowlist/labels/ephemeral policy，production activation 或 target reservation
失败关闭；该检查只证明查询时的配置与 run history，不证明从未发生临时 bypass。custom deployment
protection rule 不在必需摘要内。

## 4. 公共命令合同

目标 API 只接受：

```json
{
  "environment": "staging | production",
  "action": "deploy | rollback",
  "reason": "3-500 chars"
}
```

`releaseVersionId` 仅来自 URL；`Idempotency-Key` 仅来自 header。请求体是 strict object，额外字段返回 422。
repository、workflow、ref、sha、artifact、image、host、command、script、sql、env、inputs、token、callback URL
不存在于公共 DTO。Web 不接受任何可解释为命令、模板或环境变量的自由字段。

内部 dispatch envelope 的键集合和值上限是代码常量，不得把请求体 spread/merge 进去：

```json
{
  "ref": "<verified server-owned control tag>",
  "inputs": {
    "schema_version": "2",
    "command_id": "<platform command id>",
    "release_version_id": "<immutable release id>",
    "environment": "staging | production",
    "action": "deploy | rollback",
    "artifact_manifest_sha256": "<approved snapshot>",
    "environment_generation": "<decimal generation>"
  }
}
```

这些 inputs 是非秘密关联字段；一次性授权不通过 input 传递。

## 5. 权限、人员分离和 activation

| 权限 | 能力 |
| --- | --- |
| `maint.releases.workflow.view` | 查看安全状态、命令时间线和脱敏证据 |
| `maint.releases.workflow.stage` | 为已验证版本请求 staging deploy/rollback |
| `maint.releases.workflow.production.request` | 创建 production 请求，不能批准 |
| `maint.releases.workflow.production.approve` | 独立批准 production/rollback |
| `maint.releases.workflow.activation.request` | 请求 staging/production activation |
| `maint.releases.workflow.activation.approve` | 独立 security/release checker 批准 activation |
| `maint.releases.workflow.production.enable` | 用户明确创建首次 production enablement；不可由运维配置代替 |
| `maint.releases.workflow.stop` | 立即启用 sticky stop |
| `maint.releases.workflow.stop.release` | 作为不同人员批准解除 stop |

所有写入要求 Maintenance audience、精确权限、recent MFA、same-origin、reason、持久化幂等和追加审计。
版本创建者、production 请求者、批准者不得为同一用户；服务账号不能批准。activation 需要 security 和
release 两个不同人，且不能是 activation requester。

`release_orchestrator_activations` 是机器门禁而不是环境变量，至少绑定：environment、G7 evidence manifest
SHA-256、provider binding digest、control commit、workflow digest、environment/runner policy digest、target
gateway identity、receipt/auditor trust digest、production reviewer allowlist digest、允许的 artifact policy、
审批人、创建/到期时间。staging 与 production
分开。

运行拓扑也必须分开：`release-orchestrator-staging`/`release-orchestrator-production` 与对应 Auditor 是四个
独立实例。每个实例只加载一份 environment-bound provider binding/Auditor policy；裸机实例使用不同 Linux
identity，容器实例使用不同 secret source。provider binding 的规范化 material 和 digest 必须包含
`environment`。claim、reconciliation、expired-dispatch recovery 都只能读取/修改该 environment；另一个环境的
过期或 blocked operation 不能阻塞、恢复或泄露到本实例。启动前机器 preflight 必须核对 Worker/Auditor 的
repository/workflow/control commit/environment/runner 与 policy digest 完全一致，且同环境两进程只能成对启停。

首次 production 还必须存在不可变 `first_production_enablement`：由具备专用权限的用户以 recent MFA 和
明确 reason 创建，绑定用户 actor ID、G7 manifest、provider/environment/runner/target/workflow/receipt
trust 摘要、created/expires time。production activation gateway 必须引用并重验它；环境变量、静态配置、
security/release 双审或代码 Gate 均不能替代。缺少未过期 activation/enablement 或任何绑定漂移时，命令
不得 lease，Worker readiness=false。

## 6. 批准 execution snapshot 与 TOCTOU

批准时冻结并摘要以下字段：

- command/release/action/environment；
- release commit/tag、四镜像 digest、聚合 artifact manifest digest；
- migration set/version/checksum digest 和不可逆标记；
- control commit、workflow ID/path/content digest；
- environment generation、expected current deployment ID；
- production 所需同制品 staging succeeded deployment/receipt；
- rollback 历史目标、兼容性/备份 evidence 与各自有效期；
- G7 activation ID/digest、production 时的 first enablement ID/digest；
- environment/runner policy digest、production reviewer allowlist digest、receipt/auditor verification
  key-set/algorithm digest；
- maker/checker、reason、created/approved/expires time。

Worker 的 lease gateway 在数据库事务和行锁下重新计算当前事实，只在 snapshot 完全相等时返回 dispatch
材料。目标 gateway 在任何副作用前再次核对 generation/current/stop/expiry/artifact/workflow/run。任何
漂移都追加 `expired` 或 `rejected` 事实，不可就地修改旧 snapshot；用户必须创建新命令或重新批准。

## 7. 状态机、不确定性和幂等

```text
requested -> approved -> leased -> dispatching -> dispatch_accepted
                                              -> waiting_authorization
                                              -> running -> settling
                                              -> succeeded | failed | cancelled
                                              -> deployed_reconciliation_required
pre-target-reservation states -> rejected | expired | cancelled | manual_intervention
target reservation exists -> target journal/receipt 决定实际结果，不能被 stop/expiry 覆盖
```

状态由 append-only event 投影，禁止倒退或覆盖历史。`dispatch_outcome_unknown`、
`provider_state_unknown`、`receipt_missing` 是阻止推进的 uncertainty flags，不是 succeeded，也不是自动重试
许可。只有精确 run 和 receipt 的权威事实能清除相应标记。

- 同 actor/idempotency key/canonical payload 返回同一命令；不同 payload 返回 409。
- 同一 environment 最多一个 active lease；数据库 partial unique/gateway lock 是权威约束。
- lease 持有单调 fencing token；旧 owner 的迟到写入被 gateway 拒绝。
- 正常路径只有 `succeeded` 才追加 ADR-0014 succeeded deployment 和更新 current。
- 例外路径中，若目标签名 receipt 已权威证明 `cutover_committed/health_verified`，但 provider 随后失败或
  丢失，平台必须按实际状态追加 deployment/current，并把 command 置为
  `deployed_reconciliation_required`、停止该环境后续操作；不能隐瞒已经发生的切流或自动回滚。
- failed/cancelled/rejected/expired/manual_intervention 在没有有效 cutover receipt 时不改变 current。
- 无法唯一定位 provider run 时不得用时间窗口、相同 inputs 或 actor 猜测关联。

合法转移与优先级：

| 当前条件 | 后续事实 | 优先级/约束 |
| --- | --- | --- |
| requested/approved 且拒绝或过期 | rejected/expired | 终止，不能 lease |
| leased/dispatching/accepted/waiting 且尚无 target reservation | expired/cancelled/manual_intervention | fencing 保持；永不授权 |
| target 已原子 reservation、未 cutover | 只能由 target journal 进入 failed/cancelled/uncertain 或继续 | 平台 expiry/stop 不能覆盖 target outcome |
| stop 先取得 target mutex | target `stop_committed`，operation cancelled | cutover 永远不得开始 |
| cutover 先取得 target mutex | durable cutover outcome/receipt，随后 stop_committed | 实际 deployment/current 必须记录 |
| provider success 先到、无 receipt | settling + receipt_missing | 不改变 current |
| receipt success 先到、provider 未终结 | settling | 记录实际 target evidence，等待 provider |
| receipt success 后 provider failed/cancelled/unknown | deployed_reconciliation_required | actual deployment/current 仍按 receipt 记录；环境停止 |
| cutover_committed 后 health failed/uncertain | deployed_reconciliation_required | `cutover_committed` 已决定物理 current；健康失败不能改写成“未部署” |
| stop/cancel 后迟到 provider success、无 cutover receipt | cancelled/manual_intervention | 不改变 current |
| stop/cancel 后迟到有效 cutover receipt | deployed_reconciliation_required | receipt 作为物理事实优先，不能丢弃 |
| target journal uncertain | manual_intervention + environment blocked | 只能由签名 reconciliation receipt 清除 |

所有 terminal projection 都允许继续追加“迟到但真实”的 provider/target evidence；terminal 只禁止再执行
副作用，不允许删除或忽略已经发生的物理事实。

## 8. PostgreSQL 事实与 gateway 边界

前向迁移新增下列事实，不改写既有迁移：

- `release_workflow_commands`：规范化命令、maker、idempotency、snapshot digest、状态投影键；
- `release_workflow_approvals`：approve/reject、checker、reason、snapshot/expiry；
- `release_workflow_activations`：G7 manifest、binding、双审、environment、expiry；
- `release_workflow_first_production_enablements`：用户 actor/MFA、G7/provider/target/workflow/trust 摘要、expiry；
- `release_workflow_environment_generations`：每环境 generation、active lease、expected current；
- `release_workflow_attempts`：lease/fencing、provider run ID/attempt、安全 URL、不确定性；
- `release_workflow_authorizations`：精确 run/OIDC binding、`jti` replay key、target reservation、expiry；不存
  bearer grant/token；
- `release_workflow_target_operations`：唯一 operation ID、authorization nonce、target journal projection；
- `release_workflow_run_policy_attestations`：exact run/job、environment/runner policy、OIDC jti digest、签名/
  key ID、expiry、消费事实；
- `release_workflow_events`：规范化 provider/target 状态与摘要；
- `release_workflow_deliveries`：delivery ID、run locator、body SHA-256、处理结果；不存 raw payload；
- `release_workflow_receipts`：目标签名 envelope、key ID、验证结果；
- `release_workflow_stops`：sticky stop/解除事实和 generation bump。
- `release_workflow_human_action_authorities`：数据库计算的 session hash、actor、recent MFA、permission、operation、
  mutation digest、idempotency/request 与短 TTL；不向 verifier 暴露 raw session；
- `release_workflow_human_action_assertions`：verifier 登记的原始签名字节、credential/counter/policy hash，只能
  绑定一个 authority；
- `release_workflow_human_action_assertion_consumptions`：control 事务内写入的精确 mutation 结果；已消费后跨 TTL
  仍只返回相同结果，不重新执行。

角色和 gateway：

- Web：只能签发一次性 human-action authority、读取脱敏视图并协调两个内部 HTTP 服务；不能直接执行
  request/approve/activation/stop mutation；
- Identity verifier：只能登记/解析 assertion，不能读取 session、签发 authority 或执行 mutation；
- Release control：只能执行强制消费 assertion 的单一 gateway，不能调用 registrar 或任何裸 mutation；
- Worker：`lease_release_workflow_command(...)` 必须原子返回完整、已重验 snapshot；另有 bind-run、append-
  provider-event、settle-receipt、heartbeat gateway；不得 broad SELECT；
- Ingress：只能执行 append-delivery gateway；不参与 OIDC authorization 或 grant 签发；
- Auditor：只能执行 append-run-policy-attestation gateway；不能 SELECT/UPDATE 命令、审批、授权或部署；
- target gateway：只能执行 reserve-exact-run-operation、validate-fence/CAS、append/reconcile-receipt gateway；
- Client、Operations、Runtime/Research Worker、其他角色和 PUBLIC：零权限。

gateway 必须把“读取事实再决定写入”放在单一事务中，不能要求低权限进程自行 SELECT 后拼接判断。

## 9. Dispatch 和精确 run 绑定

1. Worker 把状态推进到 `dispatching` 并持久化本次 request digest/fencing token。
2. 使用 `X-GitHub-Api-Version: 2026-03-10` 请求固定 workflow dispatch endpoint；禁止 redirect，连接和响应
   timeout 有界。
3. 只有 HTTP 200 且 JSON 含合法 `workflow_run_id`、allowlisted GitHub `run_url/html_url` 才接受。
4. bind-run gateway 原子核对命令仍持有 lease、run ID 未绑定、attempt=1、snapshot 未过期，并创建短时一次
   性授权事实。
5. 随后 Worker GET exact run，核对 repository/workflow/event/head SHA/ref/attempt；不匹配立即拒绝并 cancel。
6. 429/5xx、非 200、响应缺 ID、提交后断连，以及 Worker 已收到 200/run ID 但在 bind-run 事务提交前崩溃，
   均置 `dispatch_outcome_unknown`，不得再次 POST dispatch。
7. 所有未在数据库绑定的 run 永远不能通过 target authorization。恢复时可以用 webhook/run inventory 找到并
   取消可能候选，但不得把候选事后关联到命令；若无法证明未执行，保持 target fence 并进入 manual
   intervention。

`dispatch_accepted` 仅表示精确 run 已绑定，不表示 workflow 已获授权，更不表示目标部署成功。

GitHub 当前 dispatch 响应与 workflow-run API：

- <https://docs.github.com/en/rest/actions/workflows>
- <https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10>

## 10. OIDC 一次性授权

workflow 的 staging/production deploy job 必须引用同名 GitHub environment；GitHub 保护规则通过、job 启动
后，job 才以最小 `id-token: write` 获取 OIDC token。Environment 中不得存 target、SSH、DB、Docker 或其他
长期部署 secret；它只提供审批/策略门。目标 gateway 直接接收原始 OIDC token 与 strict deployment request，
不存在可重放的中间 deployment grant，也没有 Ingress/grant signer。

目标 gateway 必须：

1. 从固定 GitHub issuer discovery/JWKS 验证签名、issuer、固定 audience、`nbf/iat/exp` 和算法 allowlist；
2. 精确核对 `repository_id`、`repository`、`repository_owner_id`、`workflow_ref`、`workflow_sha`、`ref`、
   `run_id`、`run_attempt == 1`、`runner_environment`、`event_name == workflow_dispatch`、`environment`、
   规范化 `sub` 和 `jti`；
3. 禁止 reusable workflow；若 token 出现 `job_workflow_ref/job_workflow_sha`，请求失败关闭，而不是忽略；
4. 以 `jti` 作为 token replay key，请求独立 Auditor 在该 environment job 已启动后生成 exact run/job 的短时
   `provider_policy_observed` attestation；该事实是纵深检查，不是 production approval；
5. 调用窄数据库 gateway，在同一事务中核对 command/run/snapshot/generation/activation/first-production-
   enablement/stop/expiry 和未过期、未消费、同 `jti` 的 run-policy attestation，预留 authorization nonce 与
   唯一 target operation ID；
6. OIDC token、authorization header 和完整 claims 不得进入日志、DB、error 或 telemetry；只保存规范化
   claim digest、必要 allowlist 字段和 `jti` replay key；
7. 第一次成功请求即完成 reservation；同一 OIDC `jti`、authorization nonce 或 command 的并发/重试只能
   查询/推进该 operation，不能创建第二次备份、拉取、准备或切流；
8. 对尚未完成 run binding/attestation 可返回明确 retryable 状态，workflow 只作短时有界退避；其余失败
   关闭。

GitHub OIDC claims 的官方合同：<https://docs.github.com/en/actions/reference/security/oidc>。

直接从 GitHub 手工 dispatch 的 run 没有数据库中精确 run authorization，因而不能建立 target operation。
GitHub UI/API rerun 会产生 `run_attempt > 1`，workflow、Worker、OIDC verifier 和 target state machine 四层
均拒绝；任何重试必须是新命令。

## 11. Webhook 与 reconciliation

- Ingress 只在精确 path 接收最大 256 KiB raw body，解析前校验 `X-Hub-Signature-256` HMAC-SHA256，使用
  constant-time compare；缺失/格式错/不匹配统一 401。
- `X-GitHub-Delivery` 使用严格 UUID/有界格式并有唯一约束；重复 delivery 返回原处理结果。
- allowlist 仅接受需要的 `workflow_run` action；10 秒内追加 delivery fact 并返回，后续异步处理。
- envelope 只含 delivery/event/action、repository ID、workflow/run ID、run attempt、head SHA/ref、status/
  conclusion、body SHA-256、received time 和处理码，不保存 raw payload/header/token。
- 任一 run locator 与绑定不匹配即隔离；不能让“合法签名、错误 run”的事件推进状态。
- Worker 只查询 exact run，核对 run attempt 和 jobs for that attempt；webhook 丢失、乱序/redelivery 不影响
  单调状态。
- provider conclusion=success 只允许进入 `settling`；无有效目标 receipt 时绝不 succeeded。

官方 webhook 合同：

- <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>

## 12. 环境并发、目标 gateway 和 receipt

workflow 使用 `concurrency: agentnovas-deploy-${environment}` 与 `cancel-in-progress: false`。GitHub 默认允许
并发，且同 group 只保留一个 running 和一个 pending，新的 pending 可能取消旧 pending；因此它只是削峰，
数据库 generation 和目标 CAS 才是正确性边界。官方合同：
<https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency>。

target deployment request 为 strict schema，至少绑定 command、run、attempt=1、workflow SHA、artifact manifest
digest、environment、generation、expected current、action、OIDC token。target 在第一次接收时原子预留 OIDC
`jti`、authorization nonce 和唯一 operation ID；同 key 的所有重试只返回/推进同一 operation。

target 实例加载的 GitHub provider binding 自身也必须冻结同一 `environment`；若它与 adapter config 的
environment 不同，进程在连接数据库、监听端口或执行任何 adapter 前失败关闭。

每个 environment 使用 target 本地、跨进程、重启后可恢复的 durable mutex、单调 owner epoch/fencing token
与 journal。operation 状态至少为
`prepared -> applying -> cutover_intent_durable -> cutover_committed -> health_verified | failed | uncertain`：

1. `prepared` 在任何外部副作用前 durable，绑定全部批准/OIDC/fence 字段；
2. 每个外部 adapter 必须接受 operation/step idempotency key；若 provider 不支持，则必须提供权威 probe/
   reconcile 后才能安全推进。副作用成功但 checkpoint 未 durable、且无法 probe 的步骤只能进入
   `uncertain`，不得声称 exactly-once 或盲目重做；
3. 最终 generation/stop/expected-current 验证、`cutover_intent_durable`、物理切流、active-release marker 与
   `cutover_committed` 都在同一 target environment mutex 内；
4. target stop 竞争同一 mutex。cutover 先得锁则实际结果/receipt 先 durable，stop 随后生效；stop 先得锁则
   写入 `stop_committed`，旧 operation 不得切流。该顺序形成明确线性化审计事实；
5. cutover adapter 在物理副作用点、active marker 与 journal commit 都重新核对 owner epoch/fencing token；
   旧 owner 暂停后恢复、锁 failover 或 lease 过期时不能继续。锁存储、owner、DB 或 Auditor 状态不确定即
   失败关闭；
6. GitHub cancel 的异步 202、平台 generation update 或 Worker 停止都不能替代 target mutex。

长时间的 image pull、backup 和 migration 只持 operation lock；environment mutex 仅覆盖最终 stop/current/
authority 重验、cutover intent、物理切流、marker 与 cutover journal。target instance binding 同时包含唯一宿主
identity、journal root、compose/override、gateway、全部安全关键 target 模块、依赖锁文件与 Node runtime 版本摘要；
不同宿主、实现或 lock namespace 不能共享 owner identity。Linux 活锁证明使用 boot identity、PID 与进程 start ticks，无法读取或无法证明时失败关闭；释放
mutex 前必须对 owner document 做精确 CAS。

成功或失败后，target 用 Runner 不可读取的独立 Ed25519 key 对 RFC 8785 canonical JSON receipt 签名。
receipt 绑定全部请求字段、实际 previous/current deployment、四镜像 digest、migration registry digest、
backup ID、journal phase/sequence、started/completed time、result、receipt nonce 和 key ID。Activation 与 approval
snapshot 绑定完整 verification key-set digest、每把 Ed25519 SPKI、公钥摘要、算法/canonicalization policy、
not-before/not-after。正常轮换允许有界 overlap；target-local 已签名 receipt 必须先于 DB append 持久化，恢复时
按该 receipt 的 `keyId` 与签名时间从受托管 keyring 选择历史公钥，不得拿当前公钥替代。已在平台 compromise 事实之前接收、验签并持久化的历史 receipt 可按签发时
有效 key 继续验证；因 compromise 撤销时必须记录 `compromised_at`，撤销后首次观察到的该 key receipt
无论 payload 自报何时签发都拒绝，既有 receipt 也进入影响面复核。

`cutover_committed` 本身决定物理 current；其后的 health failure/uncertain 仍必须记录实际 current，并把
command 投影为 `deployed_reconciliation_required`，不能当作普通 failed。

切流与 PostgreSQL 不是原子事务，不能伪装成一个事务。journal 与 active-release marker 必须允许 target
按 command/authorization nonce/operation ID 查询并重发同一签名 outcome。gateway 若在 cutover 前后崩溃，
reservation 保持、环境 readiness=false 且禁止新操作；恢复流程读取 journal、active-release marker、实际
路由/容器和健康探测，追加签名 reconciliation receipt。即使 stop 已请求，已经发生的物理结果仍必须
记录。有效 receipt 已证明切流但 provider 非 success 时，canonical deployment/current 按真实状态追加，
command 进入 `deployed_reconciliation_required`；不得因 provider failure 或 stop 隐藏事实或自动回滚。

## 13. Workflow、Runner 与制品

- 新增专用 `restricted-deployment.yml`，只启用 `workflow_dispatch`，首项拒绝 `run_attempt != 1`。
- inputs 与第 4 节完全一致，未知/缺失/超限值失败；固定 workflow 自行核对 manifest 和四张 digest。
- 第三方 Actions 固定完整 commit SHA；`GITHUB_TOKEN` 默认只读，仅所需 job 开 `id-token: write`。
- 禁止 `latest`、可移动 SemVer image、现场源码构建或把用户字符串交给 shell eval。
- staging/production deploy job 引用各自 GitHub environment；OIDC 必须在该 job 内、保护规则通过后获取，
  并核对 token 的 `environment/sub`。Environment 不存 target/长期部署 secret。production 开 required
  reviewers、prevent self-review、deployment branch/tag policy，并禁止 admin bypass；若套餐/API 无法可靠
  配置和审计这些规则，production activation 不得建立。
- custom deployment protection rule 因 public preview/套餐约束只作可选纵深防御，不能成为基线依赖。
- 制品核对聚合 manifest、四张 image digest 和 migration set；套餐支持时生成/验证 GitHub artifact
  attestation，但 attestation 不证明业务语义安全。
- 自托管 Runner 视为可持久失陷：不得与生产宿主共用，不处理 PR/untrusted workflow，专用 runner group
  仅允许目标仓库，最小网络，优先 ephemeral per-job 销毁，不持久化 secret/cache。
- environment/ruleset/runner group/labels/ephemeral policy 的规范化摘要进入 activation，并由独立只读
  security auditor 在每次 lease 前复核；任何漂移使旧 approval/activation 过期。

官方依据：

- Action 固定 SHA 与 Runner 安全：<https://docs.github.com/en/actions/reference/security/secure-use>
- 环境保护：<https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>
- artifact attestation：<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>

## 14. Production 与 rollback

production deploy 必须引用同 release、同聚合 manifest 和四镜像 digest、且签名 `completedAt` 与接收时间都不超过 24 小时的 staging succeeded receipt，
以及不同人员批准和 production activation。目标 gateway 执行前再次验证 staging 证据仍对应批准 snapshot。

rollback 目标必须曾在同 environment succeeded、不是 current。兼容性 evidence 必须在执行时重算并绑定：
当前 migration registry 名称/checksum set、不可逆迁移标记、目标 manifest 支持范围、current deployment、
environment generation、备份 ID、verified_at、retention、恢复演练版本和恢复计划。证据短时过期；任何变化
拒绝。禁止自动 down migration；不兼容只能 forward-fix 或进入人工备份恢复流程。

## 15. 紧急停止与失陷响应

平台 sticky stop gateway 先在同一事务中追加 `stop_requested`、递增 generation、使尚未 target reservation 的
授权失效并禁止新 lease。随后 target stop 请求必须取得与 cutover 相同的 environment durable mutex：

- stop 先得锁：写入签名 `stop_committed` receipt，旧 operation 永远不能进入 cutover；
- cutover 先得锁：必须先把真实 cutover outcome/receipt durable，stop 再取得锁并生效；平台仍记录已经
  发生的 deployment/current，不能因为 stop 而禁止事实写入；
- target 未确认时 UI/状态只能写 `stop_requested/target_pending`，不得宣称已停止物理切流。

Worker 同时对已绑定 exact run 请求 GitHub cancel、停止新 dispatch，并按事故范围禁用 App installation、
撤销 Worker DB login、轮换 target authorization epoch/credential source。GitHub cancel 只被视为异步请求，
不是线性化点。若切流已完成，cancel 不等于回滚；需按事故/rollback 流程追加新事实。解除 stop 需不同
人员 maker/checker、新 activation 和新 generation；旧命令不自动重放。

target 还必须提供不依赖 Maintenance Web、平台 auth 或平台 DB 可用性的 break-glass stop：

- 仅在隔离管理网络暴露，不与 deployment endpoint 共用入口；
- 使用 target-local、独立 security/operations mTLS 身份 allowlist 和硬件/文件密钥；正常 GitHub Runner、
  Worker、Web 身份均不能调用；
- 调用后竞争同一 environment mutex，递增 target-local authorization epoch，写本地 durable signed
  `stop_committed` journal/receipt，并阻止所有尚未取得 cutover mutex 的 operation；
- 若 mutex 正忙，先以单环境 single-flight 方式持久化完整 stop intent，再返回 `stop_pending`，后台循环必须自动
  取得同一锁并提交；不同 stop ID 或同 ID 不同 actor/reason/fingerprint 均失败关闭且不得留下 poison pending；
- 平台不可达期间，新 reservation、DB/Auditor 核验或 owner 状态不确定全部失败关闭；
- 平台恢复后只把 break-glass actor fingerprint、reason、receipt/journal 摘要和实际先后追加回填，不能
  重写本地历史；解除仍走平台 maker/checker、新 activation/generation 和 target 本地确认。

解除 stop 分三步：target 在本地 stop 仍 active 时先签 `clear_acknowledged`，平台 maker/checker 事务提交新
generation 与 cleared fact，target 再重验该 cleared fact 后追加本地 clear event。第一步不得提前删除本地
sticky stop；任一步失败都保持停止。target 启动后以数据库 active operation 列表为恢复真源，并周期重发
本地未回填的 stop 或终态 receipt，因此平台数据库短时不可用不会阻止隔离管理面的 break-glass stop。

演练至少覆盖：Web session 失陷、Worker/App key 泄漏、installation 扩权、webhook secret 泄漏、control
tag/workflow 漂移、直接 dispatch、rerun、Runner 失陷、批准事实篡改、并发切流、stop 与切流竞态、过期
rollback/backup。每项必须证明 current 不被错误改变且能回到“只登记证据”。

## 16. 安全错误与可观测性

Maintenance 只展示 configured/enabled/healthy、环境 activation 状态、队列深度/最旧年龄、最近成功时间和
安全错误码。允许错误码包括：`disabled`、`activation_missing`、`activation_expired`、`binding_invalid`、
`binding_drift`、`installation_scope_drift`、`credential_unavailable`、`provider_unreachable`、
`dispatch_outcome_unknown`、`callback_invalid`、`run_mismatch`、`attempt_rejected`、`authorization_expired`、
`generation_stale`、`current_changed`、`receipt_missing`、`receipt_invalid`、`artifact_mismatch`、
`receipt_key_revoked`、`target_operation_uncertain`、`stop_target_pending`、`environment_policy_drift`、
`runner_policy_drift`、`run_policy_attestation_missing`、`auditor_unavailable`、
`first_production_enablement_missing`、`break_glass_stopped`、`migration_incompatible`、
`emergency_stopped`、`manual_intervention`。

不得返回 token、OIDC claim 全文、key/path、GitHub response body、完整内部 endpoint、workflow logs、raw
webhook 或 target receipt signature。指标按低基数字段聚合；command/run ID 只进入访问受控审计。

## 17. 实施切片

1. **T8.0**：ADR、威胁模型、状态/gateway/provider/OIDC/target/失陷合同冻结；运行时不变。
2. **T8.1a**：纯 domain contract：strict DTO、snapshot、完整状态优先级、run/attempt/generation/owner epoch/
   policy attestation/target operation/receipt 类型，明确 cutover 后健康失败、step idempotency/probe 与 stale-
   owner fencing；无网络、DB 或 secret。
3. **T8.1b**：PostgreSQL command/approval/activation/generation/attempt/auth/delivery/receipt/stop 事实，事务
   gateway、RLS/ACL 和并发/TOCTOU 测试。
4. **T8.1c**：独立 Worker、App token 缩权、binding drift 与固定 dispatch adapter；总开关仍关闭。
5. **T8.2a**：独立 Ingress、raw-body webhook 验签和异步 provider reconciliation。
6. **T8.2b**：目标 deployment gateway、OIDC exact-run 验证、target mutex/journal、generation/current CAS、
   固定 deploy adapter和签名 receipt。
7. **T8.2c**：Maintenance 请求/审批/activation/stop UI；独立 WebAuthn verifier 与 release-control；action-bound
   authority、数据库原子消费、响应丢失/跨 TTL 精确重放、角色断点与 axe。已完成，两个服务仍默认关闭且仅
   进入 Compose `restricted-cicd` profile。
8. **T8.2d1**：专用 workflow、独立只读 Auditor、数据库内 v4 Auditor-trust-bound reservation、实际 restore rehearsal 与 G7
   manifest 生成器。已完成，全部服务仍默认关闭。
9. **T8.2d2**：真实 environment/ruleset/reviewer/runner fixture、staging/production/rollback/失陷演练和 G7。

每个切片结束时 Current 文档必须准确写明 capability 是否仍 disabled。T8.1a 可以在 T8.0 第二轮复审通过
后开始，但 provider/DB/Ingress/target 实现不得偷跑到 domain 切片。

## 18. G7 验收映射

| G7 要求 | 必需的机器证据 |
| --- | --- |
| 固定仓库/workflow/commit/制品 | binding drift、workflow digest、manifest/image mismatch tests |
| 无长期 token/任意命令 | secret custody、token exact scope/TTL、strict DTO/gateway tests |
| direct dispatch/rerun 无法部署 | environment-bound exact run OIDC、jti/reservation、attempt>1 drills |
| production 同制品 staging + 独立批准 | snapshot/expiry、自审拒绝、staging receipt identity tests |
| 并发与 TOCTOU 失败关闭 | lease/generation、run-policy attestation、owner epoch、expected-current CAS tests |
| callback 伪造/重放/乱序无效 | HMAC vector、delivery unique、wrong run/attempt、reconciliation tests |
| Runner 失陷不能扩大/伪造成功 | approved-snapshot immutability、target fence、forged log/output/receipt tests |
| rollback 合法且当前兼容 | history/current、migration checksum、irreversible、backup expiry fixtures |
| stop 与 cutover 有线性顺序 | target same-mutex race、journal recovery、late receipt、exact-run cancel drills |
| Web/平台不可用仍能紧急停止 | target-local mTLS break-glass、authorization epoch、signed backfill drill |
| G7/首次生产不能靠环境变量绕过 | 双人 activation、first enablement fact、policy/trust digest/expiry tests |

G7 必须输出不可变 evidence manifest，逐项绑定测试日志 SHA-256、workflow/provider/target 版本和审批人。
G7 全部通过后仍需用户明确批准首次 production activation；代码 Gate 通过不等于部署授权。

## 19. 第一轮审查发现处置

| # | 发现 | 修订处置 |
| --- | --- | --- |
| 1 | dispatch 未可靠返回 run ID | 当前 `2026-03-10` 合同返回 `workflow_run_id`；固定版本、缺 ID 失败关闭且不重试 |
| 2 | GitHub 直接触发绕过平台 | target 验证精确 run OIDC；未绑定 run 无法建立 target operation |
| 3 | G7/production 仅人为声明 | 双人、过期、摘要绑定的 activation 事实与 readiness 门禁 |
| 4 | 环境并发未序列化 | DB active lease + generation + expected-current CAS；GitHub concurrency 仅纵深 |
| 5 | control tag 可移动 | 每次核对完整 commit、workflow content digest 和 returned run head SHA |
| 6 | webhook 缺 run locator | envelope 增加 repository/workflow/run/attempt/head SHA/ref 并逐项核对 |
| 7 | unknown 终态矛盾 | 不确定性改为阻塞 flag；无法唯一解析进入 manual intervention |
| 8 | stop 不覆盖 running | target stop/cutover 共用 mutex、generation bump、exact-run cancel |
| 9 | rerun 复用旧授权 | workflow/Worker/OIDC/target 四层拒绝 attempt>1，新命令才可重试 |
| 10 | evidence 可被 Runner 伪造 | target-signed receipt + artifact/manifest provenance；日志不是真源 |
| 11 | Worker 角色无法重验事实 | 原子 lease gateway 返回完整已重验 snapshot，无 broad SELECT |
| 12 | 批准与执行存在 TOCTOU | snapshot 绑定完整上下文、expiry、lease 与 target 双重重验 |
| 13 | App installation 未来扩权 | 完整 installation 集合、private App、repository 与 exact permissions 漂移停机 |
| 14 | rollback 兼容性/新鲜度缺失 | 执行时重算 migration/backup/current/generation，禁止自动 down migration |

## 20. 第二轮审查发现处置

| # | 级别 | 发现 | 修订处置 |
| --- | --- | --- | --- |
| 1 | Critical | stop/cutover 无线性化点 | target durable environment mutex；二者竞争同一锁并记录先后 |
| 2 | Critical | 切流后 receipt/current 崩溃窗 | prepare/commit/outcome journal、active marker、operation 查询/重放和签名 reconciliation |
| 3 | Critical | environment/OIDC 顺序不成立 | OIDC 只在保护通过后的 environment job 获取；environment 无 target/长期 secret；核对 environment/sub |
| 4 | High | Runner 失陷主张过强 | 收窄为只能启动已批准 snapshot，不能扩大范围/创建第二 operation/伪造 receipt |
| 5 | High | grant 可并发重放前置副作用 | 删除 bearer grant；首次请求原子预留 jti/nonce/operation，重试只推进同一状态机 |
| 6 | High | actions:write 不能读 ref/content | 专用 App 精确增加 contents:read，并继续核对响应 exact scope |
| 7 | High | grant signer 信任链未定义 | 删除 signer/grant；target 本地验原始 OIDC，并调用窄 DB gateway 原子 reservation |
| 8 | High | 只检查单个 installation | private 专用 App；每次枚举完整 installation 集合并要求唯一 allowlisted installation |
| 9 | High | 首次 production 用户授权非机器事实 | 新增不可变 first_production_enablement，绑定 actor/MFA/G7/provider/target/workflow/trust/expiry |
| 10 | High | environment/runner 配置可漂移 | activation 绑定规范化摘要；独立只读 auditor 每次 lease 复核，无法核验则 production fail closed |
| 11 | Medium | OIDC claims 不完整 | 增加 event/environment/sub/jti；禁止 reusable workflow；jti 唯一 |
| 12 | Medium | in-flight transition 不完整 | 增加完整转移/优先表，late physical receipt 高于 stop/cancel 投影 |
| 13 | Medium | receipt key 生命周期未定义 | activation/snapshot 绑定 Ed25519/RFC8785 key-set；轮换 overlap 与 compromise semantics |
| 14 | Medium | 200 后 bind 前崩溃未覆盖 | 明确归入 dispatch_outcome_unknown；候选只取消、不事后关联，未绑定 run 永不授权 |

### 第二轮 remediation 复审追加处置

| # | 级别 | 发现 | 修订处置 |
| --- | --- | --- | --- |
| 15 | High | policy audit 存在 lease 后 TOCTOU | environment job 启动后生成 exact run/job 短时签名 attestation，target reservation 原子消费 |
| 16 | High | Auditor 信任域未冻结 | 独立进程/private read-only App/Linux secret/egress/DB gateway/attestation key 合同 |
| 17 | High | Web/auth 故障时无 target stop | 隔离管理面 mTLS break-glass、同 mutex、target epoch、本地签名 journal 与恢复回填 |
| 18 | Medium | cutover 后 health failure 投影不明 | `cutover_committed` 决定物理 current，健康失败进入 deployed_reconciliation_required |
| 19 | Medium | exactly-once 掩盖副作用崩溃窗 | adapter step idempotency key 或权威 probe；两者都无则 uncertain |
| 20 | Medium | mutex 无 stale-owner fencing | 单调 owner epoch；adapter/marker/journal 均核对，ownership 不确定失败关闭 |
| 21 | High | approvals API 无法区分普通批准/admin bypass | 明确 environment 仅纵深防御；attestation 只写 observed，平台 approval/exact-run target gate 独立生效 |
| 22 | Medium | Auditor 权限不足/粗粒度附带读取 | 增加 `Actions: read`，核对 exact token scope，并以 GET endpoint allowlist 禁止 logs/artifacts |
