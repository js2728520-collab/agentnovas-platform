# ADR-0024：发布控制面使用精确运行授权和目标侧 fencing

状态：Accepted for incremental implementation；T8.2c Maintenance 控制面已实现，运行时持续 disabled

日期：2026-08-27

关联：ADR-0014、ADR-0016、ADR-0021、`RESTRICTED_CICD_DELEGATION_SPEC.md`

## 背景

当前 Maintenance `/releases` 只登记 CI/CD 或值班人员已经产生的不可变发布证据，不执行 Git、SSH、
数据库迁移、切流或回滚。V3 目标允许 Maintenance 发起受限部署，但 ADR-0021 要求先完成专项规格、
威胁模型和 G7；在这些条件完成前，扩大 Web 进程权限会把发布控制面变成远程命令执行入口。

仓库已有 `.github/workflows/container-release.yml`，由 SemVer tag 生成四张不可变 GHCR 镜像和聚合
manifest。它是制品生产工作流，不是 Maintenance 可调用的部署工作流，不能增加浏览器参数后兼任部署。

第一轮 fresh-context 审查指出十四类缺口：dispatch/run 关联、GitHub 直接触发绕过、G7 机器门禁、
并发环境操作、control ref 漂移、回调关联、unknown 状态、运行中紧急停止、rerun、证据真实性、Worker
数据库可见性、批准 TOCTOU、GitHub App 权限漂移和 rollback 新鲜度。本修订逐项收敛这些缺口。

## 决策

### 1. Web、Provider、Ingress 和目标部署凭证四域分离

新增独立 `release-orchestrator-worker` 出站进程、`release-orchestrator-ingress` 入站进程、只读
`release-provider-security-auditor` 和目标侧 deployment gateway。Maintenance Web 只能通过 PostgreSQL
gateway 追加命令和审批事实；不能调用 GitHub、
读取 GitHub App 私钥、安装令牌、webhook secret 或部署凭证。Worker 只租赁已批准命令、调用 GitHub 并
核验权威状态。Ingress 只验签和追加有界 delivery envelope。目标 gateway 独立持有环境部署能力和回执
签名材料；GitHub Runner 永远不能直接取得可绕过 fencing 的长期 SSH、数据库或 Docker 管理凭证。

Web、Worker、Ingress、Auditor、目标 gateway 使用互不兼容的数据库角色和 Linux secret。边缘仅把精确 webhook
path 转发给 Ingress，并把精确 OIDC deployment path 转发给 target gateway；任何进程失陷都不能同时伪造
批准、provider 结果和目标部署回执。

Worker 与 Auditor 还必须按 `staging`/`production` 拆成不同进程实例、Linux identity、binding/policy 和
credential mount。provider binding material 把 environment 纳入 SHA-256；claim、provider reconciliation 与
过期 dispatch recovery 的数据库 gateway 都接收并重验同一 environment。单份 binding/policy 或无环境过滤的
恢复循环不能同时服务两个环境。target 启动时必须要求 GitHub binding environment 与本地 adapter environment
完全相等。

Maintenance 的高风险人工动作进一步拆成两个独立服务。`release-identity-verifier` 只持有 WebAuthn RP/origin/
credential policy、专用 verifier 数据库角色和 verifier HTTP secret；它只收到短时 action authority handle、
规范化 mutation document 与签名材料，永远不接收浏览器 session secret，也不能执行发布 mutation。
`release-control` 只持有 control 数据库角色和另一份 HTTP secret；它不持有 WebAuthn policy、credential public
key 或 verifier secret，只能提交数据库强制消费的精确 mutation。Maintenance Web 保留自己的数据库角色，
通过数据库把 raw session 哈希绑定到一次性 authority，再按 verifier → control 顺序协调两个服务。

authority、assertion 和 consumption 均为 RLS 下的追加事实。数据库在 control transaction 内重算 mutation
SHA-256、核对 actor/session hash/permission/operation/idempotency/request、锁定并消费 assertion，然后才允许
对应窄 mutation；响应丢失时只重放已保存的同一结果，不能再次执行。已消费结果即使超过 assertion TTL 仍可
精确恢复，未消费的过期 authority 则失效。浏览器把不确定响应保留为同一 request/idempotency/body 重试。

这两个新服务只进入 Compose 的 `restricted-cicd` profile，位于 backplane、无宿主端口、默认关闭。当前
systemd 目录是旧环境迁移参考，不提供这两个服务的半成品 unit；不得据此在裸机路径启用控制面。

### 2. GitHub App 令牌必须在每次签发时重新缩权并验证

Worker 使用 private、不可公开安装且只服务本项目的专用 GitHub App。私钥仅存在独立 secret 文件，用于
换取最长一小时的安装令牌；请求必须显式携带单一 repository ID 和精确 `actions:write + contents:read`
权限，后者只用于解析 control ref 和核对 workflow 内容。Worker 在每次签发前以 App JWT 枚举完整
installation 集合，要求只有唯一 allowlisted installation，再核验 App registration identity/owner、
installation account、repository selection、目标 repository ID、suspended 状态和权限 allowlist；令牌响应
也必须精确等于该仓库与权限。新增第二个 installation 或任何范围扩大都令 readiness=false。
GitHub REST `GET /app` 不返回 private/public 可见性；因此 private 属性由 G7 管理面证据与独立 Auditor 冻结，
运行时不依赖伪造的 `public` 响应字段。响应中 GitHub 隐式加入的 `metadata:read` 是唯一允许的额外权限。

令牌只存在于单次函数内存，不写数据库、缓存、日志、异常、审计或证据。GitHub App 管理员仍是外部
高权限信任边界；平台负责发现漂移并停止授权，不能声称能够约束已失陷的 GitHub 组织管理员。

官方合同：<https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>

### 3. 固定 provider binding 绑定到不可变 commit 与 workflow digest

repository ID、workflow ID/path、环境、输入键均来自 Worker 部署配置，不能来自浏览器或通用 payload。
由于 dispatch 的 `ref` 合同是 branch/tag，Worker 使用受保护 control tag，但不信任 tag 名本身：每次租赁
时解析 tag，要求它等于 G7 activation 中的完整 40 位 commit SHA，并核对该 commit 上 workflow 文件的
SHA-256。dispatch 返回的 run 必须具有相同 `workflow_id`、`head_sha` 和仓库 ID；任一漂移停止 readiness，
旧批准过期，并拒绝授权。

第三方 Actions 固定完整 commit SHA。GitHub ruleset/protected tag 是防御层，不是不可移动性的唯一依据。

### 4. 平台只授权自己 dispatch 后返回的精确 run

固定 workflow 即使被人员直接从 GitHub 触发，也不能部署。流程如下：

1. Worker 在数据库事务中租赁经过审批的命令和环境 generation，冻结完整 execution snapshot。
2. Worker 使用固定 API 版本 `2026-03-10` dispatch；HTTP 200 响应必须给出 `workflow_run_id`，否则进入
   `dispatch_outcome_unknown`，不得重发。
3. Worker 原子绑定精确 run ID、要求 `run_attempt=1`，并生成短时、单次可预留的授权事实；不把 bearer
   secret 放入 workflow inputs。Worker 收到 200 后、绑定事务前崩溃也属于
   `dispatch_outcome_unknown`；未绑定 run 永远不能授权或被事后猜测关联。
4. staging/production job 必须先通过对应 GitHub environment 保护，再以 `id-token: write` 获取 OIDC token。
   Environment 中不保存任何 target/长期部署 secret，只作为第二道审批门。
5. Runner 把原始 OIDC token 与固定请求交给目标 gateway；目标 gateway 自行验证 issuer/JWKS、audience、
   repository、event、environment、subject、workflow/ref/SHA、run ID/attempt、runner、`jti` replay key 和过期
   时间，并调用专用数据库 gateway 原子预留与该 run 完全匹配的授权/operation。没有中间 bearer grant
   或由 Ingress 持有的 grant signer。

GitHub OIDC 官方 claim 包含上述运行与 workflow 标识：
<https://docs.github.com/en/actions/reference/security/oidc>。当前 workflow dispatch 响应合同见：
<https://docs.github.com/en/rest/actions/workflows>。

### 5. 环境 generation 和目标侧 CAS 是最终并发边界

PostgreSQL 对每个环境只允许一个 active lease，并分配单调 `environment_generation`；execution snapshot
同时绑定 `expected_current_deployment_id`。GitHub workflow 仍使用环境级 concurrency 且
`cancel-in-progress: false`，但 GitHub 只保证相同 concurrency group，且可能替换 pending run，因此数据库
lease 不是它的等价物。

目标 gateway 第一次接收请求时即原子预留 OIDC `jti`、授权 nonce 和唯一 operation ID；任何重复/并发
请求只能查询或推进同一个 operation，不能重做备份、拉镜像或准备步骤。它以 CAS 建立 durable
environment reservation，并维护 `prepared -> applying -> cutover_committed -> health_verified|failed|
uncertain` journal/active-release marker。旧 generation、current 变化、失效批准或重复授权全部拒绝。

每个环境在 target 上有一把跨进程 durable mutex。最终 generation/stop/current 验证、物理切流、active-
release marker 和 journal commit 全部在该锁内；target stop 也必须竞争同一把锁。先获得锁者先形成不可变
审计事实：cutover 先得锁则完成并记录实际状态后 stop 生效，stop 先得锁则旧 operation 永远不能切流。
GitHub cancel 的异步 202 响应不是此安全屏障。

准备、备份和 migration 使用独立 operation lock，不长时间占用 environment mutex；只有最终重验与切流进入
短临界区。target owner binding 包含唯一宿主 identity、journal root、compose/override 内容和 gateway build
摘要、安全关键 target 模块、依赖锁文件与 Node runtime 版本；Linux lock owner 以 boot identity、PID 与
start-time 证明，并在释放时精确比较 owner document。
证明不可得、owner 改变或不同 lock namespace 一律失败关闭。

mutex owner 同时持有单调 target owner epoch/fencing token；cutover adapter 和 journal commit 必须在实际
副作用点核对 epoch，旧进程恢复后不能继续。锁存储、owner 或 DB/auditor 状态不确定即失败关闭。外部
步骤不能笼统声称 exactly-once：每个 adapter 必须接受 operation/step idempotency key，或提供权威 probe/
reconcile；两者都做不到的步骤只能进入 `uncertain`。一旦 `cutover_committed`，物理 current 已改变，后续
health failure 必须记录实际 current 并进入 reconciliation required，而不能降格为普通 failed。

外部切流与 PostgreSQL 不能伪装成一个原子事务。gateway 若在切流前后失联，环境进入 reconciliation
required 并阻止新操作；恢复时以目标 journal、active-release marker、健康探测和签名 receipt 判断实际
状态，不能仅依据 Worker/GitHub timeout 猜测成功或失败。

### 6. 批准和 G7 activation 都绑定完整执行上下文

批准 snapshot 绑定 release、action/environment、四镜像 digest、聚合 manifest digest、migration set hash、
workflow commit/digest、environment generation、expected current、staging evidence、rollback compatibility、
G7 activation ID 和 `expires_at`。Worker 在 lease 时加锁重验；目标 gateway 在副作用前再次重验。任何字段
变化都使批准过期，必须创建新命令或重新批准。

G7 不是环境变量。数据库保存独立、追加式 `release_orchestrator_activations`，由 security 与 release 两个
不同角色批准，绑定 G7 证据 manifest、provider binding、workflow/artifact digest、GitHub environment/
ruleset/runner-group 规范化配置、target receipt 公钥集/算法策略和到期时间。生产 activation 还必须引用
不可变 `first_production_enablement`：由用户明确授权、绑定用户身份/recent MFA、同一 G7/provider/target/
workflow 摘要和有效期；静态环境变量或运维配置不能代替。缺少当前 activation、授权、证据漂移或到期都
令 Worker readiness=false。Auditor 使用另一个 private、不可 dispatch 的只读 GitHub App，在 environment
job 启动后对 exact run/job 重新查询当前 environment/ruleset/runner-group 配置，并追加绑定 run/attempt/job、
配置摘要、exact run review history/批准者、短到期时间和 replay key 的签名 policy attestation。它必须拒绝
可观察到的 rejected、自审、非冻结 reviewer 或环境/runner 漂移。team reviewer 在 activation 时展开并
冻结个人 ID，不能依赖事后 membership。但 GitHub review-history API 不提供“普通批准/管理员 bypass”
判别字段，因此 attestation 不得声称证明没有 bypass，也不得充当平台 production approval。它只证明
exact run/job/runner 与观察到的 provider 配置/历史；平台 maker/checker、first enablement、exact-run OIDC
和 target fencing 才是授权边界。target reservation 消费 attestation 是纵深检查，不能用它替代平台事实。

### 7. Provider 通知、权威查询和目标回执各司其职

Ingress 先对原始 body 验证 `X-Hub-Signature-256`，再以 `X-GitHub-Delivery` 去重，只保存有界规范化 envelope：
delivery/event/action、repository ID、workflow/run ID、run attempt、head SHA/ref、status/conclusion、body
SHA-256 与接收时间；不存原始 payload。回调只是唤醒信号。

Worker 使用精确 run ID 查询 GitHub 权威状态；GitHub success 只证明 workflow 编排结果，不能证明目标部署。
目标 gateway 的 `cutover_committed/health_verified` receipt 才是实际目标状态的权威证据。正常的 command
`succeeded` 要求 receipt 与 provider、artifact、批准 snapshot 全部一致；但若有效 receipt 已证明实际切流，
而 GitHub 随后断线或失败，平台仍必须把真实 deployment/current 追加为事实，同时把 workflow command
置为 `deployed_reconciliation_required`、停止后续发布并人工调查。不得为了维持“provider 失败不切
current”的简单状态机而隐瞒已经发生的目标切流，也不得因 provider 失败自动回滚。

### 8. 不确定性是标记，不是伪终态

命令的单调投影为 `requested -> approved -> leased -> dispatching -> dispatch_accepted ->
waiting_authorization -> running -> settling -> succeeded|failed|cancelled|rejected|expired|manual_intervention|
deployed_reconciliation_required`。
`dispatch_outcome_unknown` 与 `provider_state_unknown` 是阻止推进的 uncertainty flags，不是成功或可重试终态。

HTTP 非 200、响应缺 run ID、连接在提交后中断时绝不自动 dispatch。只能利用同一命令的精确 provider
证据进行 reconciliation；无法唯一定位时取消可识别候选、保持 target fence，并进入
`manual_intervention`。不得用时间相近或相同 inputs 猜测 run。

### 9. rerun 永远需要新平台命令

workflow 第一项检查 `github.run_attempt == 1`；Worker、OIDC 验证和目标 gateway 同样拒绝 attempt > 1。
GitHub UI/API rerun 因而不能复用原批准或授权。重试必须创建新平台命令、新 generation、新审批 snapshot
和新的精确 run binding。

### 10. Runner 失陷不能扩大已批准部署或伪造目标成功

自托管 Runner 按可失陷主机处理，不保存长期 secret，不与生产宿主机共用，不允许处理 PR/untrusted
workflow，并置于仅目标仓库可用的专用 runner group；优先使用一次性、每 job 销毁的 runner。workflow
`GITHUB_TOKEN` 默认只读，仅授权步骤使用 `id-token: write`。目标网络只开放 deployment gateway，且该
gateway 不接受 shell/SSH/SQL，只接受固定 schema 的部署请求。

制品使用 GitHub artifact attestation（可用计划支持时）核验构建来源，同时必须核对仓库内聚合 manifest
和四张 image digest；attestation 不是语义安全证明。已被精确授权的 Runner 即使失陷，也最多能启动该
批准 snapshot 中的同一 artifact/action/environment，不能扩大范围；最终部署成功由目标 gateway 的签名
receipt 证明，runner 日志、outputs 或上传 artifact 不能单独改变 current。

GitHub 明确说明自托管 Runner 不保证干净隔离且可能持久失陷：
<https://docs.github.com/en/actions/reference/security/secure-use>。

### 11. rollback 在执行时重新判断兼容性

rollback 目标必须曾在同一环境 succeeded、不是 current，并绑定精确目标 manifest。目标 gateway 在执行时
重新核对当前 schema migration registry checksum set、不可逆迁移标记、当前 deployment、备份 ID、备份
验证时间/保留期和恢复计划。不得自动执行数据库 down migration。兼容性过期或 current/generation 改变时
拒绝；不兼容只能 forward-fix 或进入人工恢复流程。

### 12. 紧急停止与切流共享目标侧线性化点

平台 stop 请求先阻止新租赁/授权，再由 target stop 与 cutover 竞争同一 durable environment mutex；只有
target 返回 `stop_committed` receipt 后状态才是“目标停止已生效”。若 cutover 已持锁，它必须先把实际
结果和 receipt durable 记录，随后 stop 生效；stop 后仍允许写入此前已经发生的物理事实，不能隐藏成功
切流。平台同时请求 cancel exact GitHub run、轮换 target authorization epoch/credential source 并停止
Worker；只有 receipt key 确认失陷时才按已冻结的 compromise 规则撤销对应验证 key，但异步 cancel
不能替代 target lock。解除 stop 需要独立 maker/checker、新 activation 和新 generation；旧命令不重放。

stop 请求在竞争 mutex 前必须以单环境 single-flight 方式持久化完整 intent；锁忙返回 pending，由目标后台
自动重放。同 ID 的 actor/reason/fingerprint 漂移或不同 ID 覆盖均在落盘前拒绝，避免 poison pending 阻断恢复。
签名 deployment receipt 在 DB append 前先写 target journal；key rotation 后按 receipt 自带 key ID 和签发时间
从 activation 绑定的受托管 Ed25519 SPKI keyring 验证历史签名，不能用当前公钥替代。

此外必须有不依赖 Maintenance Web、平台身份库或平台数据库可用性的 target-local break-glass stop。它仅
暴露在隔离管理面，使用独立 security/operations mTLS 身份，竞争同一 target mutex、递增 target
authorization epoch、写入本地 durable signed `stop_committed` journal/receipt，并在平台恢复后只追加回填
事实。平台 DB/授权审计不可达时，target 的新 reservation 和任何尚未进入同锁 cutover 的 operation 全部
失败关闭。

解除 target-local stop 保持三阶段：target 在本地 stop 仍 active 时先签平台 `clear_acknowledged`，平台双人
提交 cleared generation 后，target 再重验数据库 cleared fact 并追加本地 clear event。任何一步失败都不得
提前删除本地 stop。启动恢复以数据库 active operation 列表为真源，并周期回填尚未登记的平台 stop/receipt。

### 13. GitHub environment 是第二道防线

staging/production workflow job 引用各自 environment，且 OIDC 验证精确核对 `environment` 与规范化 `sub`；
production 配置 required reviewers、prevent self-review、限制 deployment branches/tags，并禁止管理员绕过。
environment 中不存 target/长期 secret。其规则、runner group/labels/ephemeral policy 形成 activation 摘要并
由独立只读 Auditor 在 activation、lease 前和 exact environment job 启动后核验；最后一次生成 run-specific
短时 attestation。若套餐/API 无法可靠核验，则 production activation/target reservation 失败关闭。
custom deployment protection rule 因 public preview 仅作可选纵深防御。

GitHub 官方 review-history 响应不能机器区分普通批准与管理员 bypass，所以 GitHub environment 明确不是
平台授权真源。临时提权/bypass 属于 GitHub 管理员信任边界；即使发生，也只能削弱第二道防线，不能创建
平台 command/approval/run binding 或通过 target reservation。任何文档、UI 或 G7 证据不得把
`provider_policy_observed` 写成 `platform_authorized`。

环境保护与管理员绕过的官方合同：
<https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>。

## 威胁模型摘要

| 威胁 | 强制控制 |
| --- | --- |
| 伪造 Maintenance actor/provider 回调 | session/RBAC/recent MFA；raw-body HMAC；精确 run 权威查询 |
| verifier/control 任一失陷或跨会话签名替换 | action authority 绑定 session hash；WebAuthn 与 mutation 双服务分权；数据库原子消费与精确结果重放 |
| GitHub 直接 dispatch/rerun | 只授权平台返回的精确 run；OIDC run binding；attempt=1 |
| ref/workflow/App 权限漂移 | commit + workflow digest；每次签发核验 installation/repository/permissions |
| 并发、迟到结果和 TOCTOU | environment generation；expected-current CAS；lease/approval expiry；目标重验 |
| Runner 失陷或伪造日志 | 只能启动已批准 snapshot；无长期凭证；目标锁/fencing 与签名 receipt |
| 回调重放/乱序/洪泛 | HMAC；delivery 唯一键；body/rate limit；单调事件；异步 reconciliation |
| 失效 G7 或人为开关误启 | 双人 activation 事实；证据 digest/expiry；staging/production 分离 |
| 紧急停止与切流竞态 | target durable mutex/线性化事实；generation bump；exact-run cancel |
| rollback 破坏 schema/data | 执行时兼容性重验；备份新鲜度；禁止自动 down migration |

## 拒绝的替代方案

- 在 Maintenance Web 保存 PAT、App private key 或 SSH key：长期 bearer/基础设施凭证进入 Web 失陷域。
- 由浏览器传 repository/workflow/ref/inputs：UI allowlist 不能约束直接构造请求。
- 仅依赖 GitHub required reviewers：可能受套餐、管理员绕过、配置漂移影响，且不能替代平台授权。
- 仅依赖 protected tag：tag 名可漂移，必须核对完整 commit 和 workflow digest。
- 由 Runner 自报部署成功：失陷 Runner 能伪造，必须由目标 gateway 接受 fence 并签发 receipt。
- 自动重试未知 dispatch 或 GitHub rerun：可能重复执行，必须新建平台命令。
- 从 Web/Runner 执行任意 SSH、Docker、kubectl、SQL 或 shell：构成基础设施 RCE。

## 后果

- Phase 8 必须按 domain contract、数据库事实/gateway、Provider Worker、OIDC/Ingress、目标 gateway、分离的
  WebAuthn verifier/control、UI、
  workflow 和 G7 演练分片实现；不能先做“能 dispatch”的捷径。
- 需要新增独立进程/DB roles、目标部署 gateway、OIDC 验证、环境 generation、签名 receipt、GitHub App、
  protected environments/control tag 和轮换/事故 Runbook。
- 仓库/GitHub 管理员与目标 gateway 管理员必须人员分离；恶意 GitHub 组织管理员是需要组织控制和审计的
  外部高权限边界，不是平台代码可以完全消除的风险。
- 本 ADR 不授权推送 tag、修改 GitHub 设置、创建 App、部署服务、启用 staging/production 或生产发布。
- 仅完成本 ADR 不代表触发能力已实现；G7 和用户首次生产授权前，Current 继续写“只登记证据”。
