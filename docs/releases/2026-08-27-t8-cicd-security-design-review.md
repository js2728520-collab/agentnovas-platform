# T8.0 Restricted CI/CD Security Design Review

日期：2026-08-27

范围：ADR-0024 与 `RESTRICTED_CICD_DELEGATION_SPEC.md`。本记录只放行 T8.1a 纯 domain contract；不授权
创建 GitHub App、修改仓库/environment/runner、增加运行时 route/secret/Worker/Ingress/target gateway、
dispatch workflow、部署服务或启用 staging/production。

## 结论

多轮 fresh-context 对抗复审最终未发现剩余 Critical/High，T8.0 通过。Current 能力仍为“只登记发布证据”，
CI/CD trigger 继续 disabled。非交互续跑按技能规则跳过跨模型 CLI，没有调用外部 Gemini/Codex CLI。

安全主张被冻结为：未经平台 command/approval、首次 production enablement、exact run/OIDC、未过期
snapshot、environment generation/expected current、target operation reservation 与 receipt，任何 provider
事件、GitHub direct dispatch/rerun、Runner 日志或 environment approval 都不能产生平台接受的
`succeeded/current`。GitHub environment 是纵深防御，不是平台授权真源。

## 主要收敛

- 固定 GitHub REST API `2026-03-10`，dispatch 必须返回并原子绑定 exact `workflow_run_id`；200 后绑定前
  崩溃也进入 unknown，未绑定 run 永不授权且不事后猜测关联。
- private 专用 dispatch App 每次枚举完整 installation 并精确缩权到单仓库
  `Actions: write + Contents: read`；独立 Auditor App 只读且 endpoint allowlist 禁止 logs/artifacts。
- environment job 保护通过后获取 OIDC；target 验证 repository/workflow/ref/SHA/run/attempt/environment/
  event/sub/jti，删除中间 bearer grant，第一次请求原子预留唯一 operation。
- target stop/cutover 竞争同一 durable mutex；owner epoch/fencing 覆盖 adapter、active marker 与 journal。
  外部步骤必须有 idempotency key 或权威 probe，否则只能进入 uncertain。
- durable target journal、active-release marker 与可重放签名 receipt 处理切流后崩溃；
  `cutover_committed` 决定物理 current，后续 health/provider failure 不得隐藏实际部署。
- target-local mTLS break-glass 不依赖 Maintenance Web/auth/DB，仍使用同一 mutex、target epoch 和签名回填。
- 双人 activation、不可变首次 production enablement、完整 execution snapshot、rollback migration/backup
  新鲜度和 receipt/Auditor key 生命周期都进入机器门禁。
- GitHub approvals API 无法区分普通批准与 admin bypass，因此 run review 只记录
  `provider_policy_observed`；平台 maker/checker 与 exact-run target gate 独立生效。

## 审查发现统计

第一轮 14 项发现全部关闭。第二轮及 remediation 复审累计新增并关闭：3 Critical、若干 High/Medium，
包括 stop 线性化、target crash window、environment/OIDC 顺序、Runner 主张、grant replay/signer、App 读取
权限/installation 漂移、首次生产授权、policy Auditor、break-glass、review-history ABA、receipt key、
stale owner 与 dispatch bind 崩溃窗。逐项处置表保存在专项规格第 19–20 节。

## 官方合同核对

- [Workflow dispatch 与 run API](https://docs.github.com/en/rest/actions/workflows)
- [Workflow run、attempt、cancel 与 review history](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)
- [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc)
- [Deployments 与 environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Environment review 与 admin bypass](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
- [Concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [GitHub App installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Actions secure use / self-hosted Runner](https://docs.github.com/en/actions/reference/security/secure-use)
- [Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## T8.1a 强制输入

T8.1a 必须以纯函数/类型和测试表达 strict public DTO、server-owned dispatch envelope、snapshot、完整状态
优先级、exact run/attempt/jti、policy attestation、单一 operation reservation、generation/current、owner
epoch、step idempotency/probe、stop/cutover 竞态和 receipt 事实。该切片不得引入网络、数据库、secret、
GitHub SDK、运行时 route 或真实 dispatch。
