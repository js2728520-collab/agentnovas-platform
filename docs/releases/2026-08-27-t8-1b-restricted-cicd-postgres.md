# T8.1b Restricted CI/CD PostgreSQL Evidence

日期：2026-08-27

状态：`COMPLETE / APPROVED_FOR_T8.1C_WORKER_ONLY / RUNTIME_DISABLED`

## 交付范围

- `0077_restricted_cicd_facts.sql` 新增 command、approval、activation、generation、attempt、authorization、
  delivery、run-policy attestation、target operation/owner epoch、provider event、deployment/stop receipt 与
  sticky stop 的追加事实和投影。
- 所有写入通过固定参数的 `SECURITY DEFINER` gateway；事实表启用 RLS、拒绝 `PUBLIC`、拒绝
  `UPDATE/DELETE`，安全状态视图不暴露 payload、nonce、signature 或 OIDC 细节。
- `least-privilege-roles.sql` 新增四个默认 `NOLOGIN` 的 release 机器角色，并只授予各自固定 gateway；
  `postgres-role-policy.mjs` 验证角色、表、sequence、schema、routine、membership 和触发器读权限收敛。
- `0078_harden_internal_registration_link_role_trigger.sql` 将既有角色保护触发器改为固定
  `pg_catalog,public` 的 `SECURITY DEFINER`，修复最小权限 Maintenance 写入路径的既有阻断。

## 失败关闭语义

- environment generation、expected current、active attempt、Worker fence、exact run attestation、target
  operation 与 target-local owner epoch 在同一事务内核对；reservation 会持续占用 environment，不能被
  lease/authorization expiry 覆盖。
- target receipt 只允许首阶段 `failed/uncertain-before/cutover/stop`；只有 `cutover_committed` 可继续到
  health success/failure/uncertain-after。terminal receipt 后不得追加更弱阶段或重新 takeover。
- provider 与 target 事实从完整不可变集合单调聚合；迟到旧 run 不能清新 lease，冲突 terminal 结论会把
  environment 置为 sticky blocked，后续正常 command receipt 不能把该环境级阻断写回 false。
- stop clear 必须同时具备 target-signed `stop_committed`、绑定 fresh activation/generation/current 的
  `clear_acknowledged`、不同 maker/checker，且不能覆盖 active target operation 或当前 generation attempt。
- 历史 reservation/takeover replay 在 owner epoch 推进或 operation terminal 后返回 stale/terminal，不再
  返回可执行的旧 epoch。

## 对抗复审

三轮 fresh-context 复审共暴露并关闭十项 High：旧事件清新租约、reservation 未占环境、provider/receipt
到达顺序 fail-open、stop 无目标确认、owner takeover 缺失、receipt 阶段可跳跃/倒退、成功后冲突终态未
阻断、历史 owner replay、跨 command 阻断可被覆盖、terminal 后新 takeover。三轮均无 Critical；受技能
三轮上限约束，最终两项修复由新增 RED→GREEN 双顺序/全 terminal 测试和完整验证矩阵收口。

## 远端验证

验证在 `ssh an-saas` 的一次性 PostgreSQL 16.14 与 Node.js 22.21.1 容器中执行，本地仅运行轻量 secret
scan/diff check。

| Gate | 结果 |
| --- | --- |
| restricted CI/CD PostgreSQL | 11/11 |
| 0076 → 0077 → 0078、幂等重跑 | 1/1；79 migrations，重跑 0 applied |
| fresh migrations + least privilege policy | 79/79；`findings=[]` |
| release recovery/role policy unit | 18/18 |
| 全量 Node tests，串行 PostgreSQL | 1472/1472，0 skipped，93.7 s |
| TypeScript / ESLint / architecture boundaries | 通过 / 通过 / 8/8 |
| repository secret scan / `git diff --check` | 3132 candidates，0 finding / 通过 |

## 未启用边界

本切片没有新增 route、可登录 release credential、GitHub App token、Worker、Ingress、target deployment
process、workflow 或 dispatch。受限 CI/CD 总开关仍关闭，Maintenance 仍不能触发部署；真实 perpetual
routing 仍关闭。本轮未提交、推送、创建 PR、修改 DNS/preview、dispatch workflow 或接触 production。
下一切片只放行 T8.1c：默认关闭的独立 Worker、短期 App token、binding drift 与固定 dispatch adapter。
