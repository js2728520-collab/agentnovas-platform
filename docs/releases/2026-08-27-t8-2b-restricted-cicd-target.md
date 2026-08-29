# T8.2b Restricted CI/CD Target 验证记录

日期：2026-08-27

状态：完成；能力继续默认关闭，仅放行 T8.2c Maintenance 控制 API/UI。

## 交付

- 独立 loopback deployment gateway 与隔离的 TLS 1.3 双向认证控制端口；GitHub OIDC 严格绑定 exact run、首次 attempt、environment、workflow/ref/commit/job 与唯一 jti。
- PostgreSQL 原子 reservation、target authority/final cutover CAS、生产同制品 staging 凭证和 rollback 历史/迁移/备份重验。
- operation lock 与短临界区 environment mutex 分离；Linux boot/PID/start-ticks 活锁证明、owner document CAS、数据库真源恢复和目标本地 checkpoint/receipt 精确重放。
- 固定 image digest adapter、custom-format PostgreSQL backup、TOC/restore-plan 摘要、物理状态 probe、owner-fenced marker 与失败关闭的不确定状态。
- target-local sticky stop、数据库离线 break-glass、锁忙 single-flight durable pending、平台恢复回填，以及 target ack → 平台 maker/checker clear → target local clear 三阶段解除；stop/clear-ack 的 exact signed bytes 同样先写本地 journal，响应丢失跨轮换时按历史 key 重放。
- receipt trust policy 携带受托管 Ed25519 SPKI keyring 和生命周期；跨正常轮换按已持久化 receipt 的 key ID/签发时间验证，compromise 失败关闭。
- target instance binding 覆盖宿主 identity、journal root、compose/override、gateway、六个安全关键模块、`package-lock.json` 与 Node runtime 版本。

## 对抗复审关闭项

三轮 fresh-context 复审无 Critical，关闭 target binding 漏绑定实现、离线多 stop 分叉、mutex busy 丢 stop、生产凭证只看接收时间、跨轮换旧 receipt 不可恢复、过期 authority 恢复仍产生副作用等 High；最终同轮复核无剩余 Critical/High。同轮 Medium poison pending 和 stop/clear-ack receipt 跨轮换重放也已关闭。

## 远端验证

所有重型验证在 `an-saas` 的 Node.js 22.21.1 / PostgreSQL 16.14 隔离环境执行：

- TypeScript：通过（禁用增量缓存）。
- target/OIDC/journal/adapter/service：31/31。
- fresh `agentnovas_t82b_review11`：84/84 migrations，0 skipped。
- least-privilege role template：成功；role policy `findings=[]`。
- PostgreSQL + target 联合套件：44/44。
- ESLint：通过。

一次初始远端 TypeScript 命令因 bind mount 上 `tsconfig.tsbuildinfo` 无写权限同时报告缓存错误；改为 `--incremental false` 后通过。该环境错误未执行代码，也不是产品缺陷。

## 未执行

未配置真实 GitHub/target credential，未 dispatch，未启动 release Worker/Ingress/target，未替换 preview 三域，未修改 DNS，未提交、推送或创建 PR，也未接触 production。公开 route、专用 workflow、G7 和首次生产启用仍被后续切片阻断。当前只验证 backup custom dump、TOC/hash、freshness 与 restore-plan 摘要；retention、实际 restore rehearsal 版本/`verified_at` 和 target manifest 支持 schema range 必须在 T8.2d/G7 形成机器证据，未完成前不得宣称 rollback 可恢复性验收通过。
