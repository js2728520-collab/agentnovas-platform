# T8.1a Restricted CI/CD Pure Domain Contract

日期：2026-08-27

范围仅为 `lib/restricted-cicd-domain.ts` 的纯函数/类型与 `tests/restricted-cicd-domain.test.mjs`。没有新增
route、数据库对象、GitHub SDK、凭证、Worker、Ingress、target gateway 或 workflow；Current CI/CD
trigger 继续 disabled，Maintenance 仍只能登记外部发布证据。

## 已实现合同

- 公共命令只允许 `environment/action/reason`，未知字段、任意 ref/command 与超限输入失败关闭。
- dispatch envelope 的 ref 与全部 inputs 由服务端 snapshot 生成；Git tag ref 按 Git 安全格式收紧。
- approval execution snapshot 冻结 release/tag/commit、四镜像、manifest、migration、workflow、generation、
  expected current、staging/rollback/G7/首次生产授权、policy/trust、maker/checker 与时间边界。
- provider policy attestation 精确绑定 repository/workflow/run/attempt/job/environment/jti，始终只是
  `provider_policy_observed`，永不升级为 `platformAuthorized`。
- target reservation 精确绑定 release/run/OIDC/environment/action/workflow/artifact/snapshot/generation/current；
  只有完全相同身份可恢复同一 operation。
- step guard 以 owner epoch fencing 拒绝旧 owner；完成 checkpoint 只允许跳过，未完成副作用必须有
  operation/step idempotency key 或权威 probe，否则进入 uncertain。
- target receipt 严格绑定 exact operation、四镜像、migration registry、实际 previous/current、权威
  owner epoch/journal sequence 与外部验签/key lifecycle 结论；receipt 不能自证签名有效。
- 状态投影以 target 物理事实优先：已 reservation 的 in-flight operation 不被 provider failure/cancel
  提前终态化；`cutover_committed` 后的 health/provider failure 仍记录实际 current。

## 对抗复审

三轮 fresh-context 实现复审先后发现并关闭：缺完整 snapshot/receipt、policy 未绑定 exact job、operation
身份欠绑定、checkpoint 重放副作用、provider/target 状态优先级错误、stale-owner receipt 与未来 approval
snapshot。最终复审无剩余 Critical/High，允许进入 T8.1b 数据库事实切片。

## 远端验证

验证在 `an-saas` 的 Node.js 22.21.1 容器和一次性 PostgreSQL 16.14 tmpfs 中完成：

- domain 10/10、TypeScript、目标 ESLint、8 条架构边界与 repository secret scan 通过；日志 SHA-256：
  `14f31c67a1b11c22b6565ed2eb0dfa80af48d587d58864907f548ea43914ac4f`。
- 全量测试 1459/1459；日志 SHA-256：
  `0bc17e10a18d8dd400c6286d5cc74313fd14f15f1921f797ef2bf01c8aef179f`。

首次全量尝试因容器数据库 hostname 不满足“仅 localhost 测试库”安全策略、精简 Node 镜像缺 Git 而失败；
没有放宽安全策略，改用 localhost 临时 PostgreSQL 和包含 Git 的官方 Node 镜像后通过。临时容器、数据库、
网络和远端源码目录均在取证后删除。本切片未提交、推送、创建 PR、dispatch 或接触 production。
