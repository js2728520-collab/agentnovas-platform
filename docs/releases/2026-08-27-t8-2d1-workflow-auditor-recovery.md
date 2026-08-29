# T8.2d1 专用 workflow、独立 Auditor 与恢复证据

日期：2026-08-27
状态：工程切片完成；真实 GitHub environment/runner fixture、staging/production/rollback 演练与 G7 仍阻断

## 交付

- 新增只接受七个冻结输入的 `workflow_dispatch`，固定 control commit、GitHub environment、并发键和
  `run_attempt == 1`，Runner 只取得短期 OIDC，不接收 SSH、数据库或 target 长期凭证。
- target 请求升级为 schema v2。authorization、operation 与 nonce 在 PostgreSQL v3 内部 gateway 由
  command/exact run/job/OIDC `jti` 确定性派生；旧 v2 privileged request 不再由 target 服务接收，target
  数据库角色也不再拥有 v2 reserve 权限。
- 新增默认关闭的 `release-provider-security-auditor`。它使用与 orchestrator 分离的只读 GitHub App、
  Ed25519 attestation key、HTTP caller secret 和 `agentnovas_release_auditor` 登录角色。该角色无表、sequence
  权限，只能执行 append-run-policy-attestation gateway。
- Auditor 只允许 GitHub GET exact run/environment/ruleset/approvals/attempt jobs；验证 active tag ruleset、无
  bypass actor、prevent-self-review、冻结 reviewer、无 rejected、自审拒绝、exact job/runner policy 和配置
  digest。它不能 dispatch，也不能读取 logs、artifacts 或 caches。
- target 先独立验证 GitHub OIDC，再请求 Auditor 生成绑定 exact run/job、review、runner、policy digest、OIDC
  `jti`/claims digest 的短时、确定性可重放签名事实，最后才调用 PostgreSQL v4 reservation。v4 先把
  target 本地加载的 Auditor trust digest 与 exact activation 冻结值比较，再委托内部 v3 派生标识；运行角色
  只获 v4 权限。
- 新增 11 项 G7 机器证据 manifest 生成器，要求每项结果文件通过、逐文件 SHA-256 和 security/release 两名
  不同审批人；它只聚合证据，不会自行启用发布能力。

## 恢复与数据库证据

- 隔离 PostgreSQL 16.14 fresh 数据库应用 87/87 migrations，并重新应用 least-privilege role template；真实
  role policy 输出 `findings=[]`。
- 实际 `pg_dump`/restore rehearsal 恢复 185 张表、87 个 migration registry 项，目标库校验后自动删除；
  source fixture 与临时客户端 volume 已清理。
- 受限 CI/CD PostgreSQL 升级、追加事实、并发、attestation、v3 reservation、receipt 与 sticky stop
  15/15 通过。

## 远端验证

在 `an-saas`、Node 22.21.1 runtime image 上完成：

- workflow/Auditor/target/role/config 回归 49/49；
- PostgreSQL 15/15；
- 全量串行 Node 测试 1567/1567；
- TypeScript、完整 ESLint 与 Client/Operations/Maintenance 三端 production build 通过；
- restricted Compose profile 使用四个 immutable image digest 完整解析；
- repository secret scan 覆盖 6430 个 tracked/untracked candidates，0 finding；
- `git diff --check` 通过。

## 仍未满足的 Gate

本记录不是 G7 通过证明。尚需经明确外部配置授权后建立真实 private read-only Auditor App、GitHub
environment/ruleset/reviewer/runner fixture，执行 staging、production、rollback、direct-dispatch/rerun、runner
失陷、callback replay、stop/cutover、break-glass 和首次 production enablement 演练，并由两名不同审批人
封存最终 manifest。此前所有 release 开关保持 `false`，Maintenance 仍只能登记平台事实。

本切片未提交、推送、创建 PR、dispatch、配置真实 secret、启动 release 服务、替换测试域名/DNS 或接触
production。
