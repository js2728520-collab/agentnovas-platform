# r4 Preview Canary、首小时监控与复盘

状态：`P0_PREVIEW_PASS / PRODUCTION_HOLD`。本记录只覆盖 preview Web-only canary，不构成 production 切流或付费 Beta 邀请授权。

## 1. 候选与阶段

- Release：`preview-7c047b6-wt-20260826T142018Z`
- Source tree SHA-256：`18be3df441b4a93395f834cb6582397ea9366b0b496923f4b07bf385b066ff2f`
- 容器首小时起点：`2026-08-26T14:43:26.711546173Z`
- 域名：`test.agentnovas.com`、`ops-test.agentnovas.com`、`main-test.agentnovas.com`
- Canary stage：`P0_PREVIEW_WEB_ONLY`
- 启用范围：以 `2026-08-26-r4-preview-capability-manifest.md` 为准；真实 provider、后台 Worker、资金、通知、模型调用和订单全部关闭。

后续阶段只能逐级推进：

1. `P0_PREVIEW_WEB_ONLY`：当前三域、合成/受控账号、无外部副作用。
2. `P1_INTERNAL_PRODUCTION_WEB_ONLY`：开发依赖停止项已于 2026-08-27 清零；仍需要 T9.5 六场人员演练 PASS、同制品生产授权和回滚值班人员到位。
3. `P2_INVITED_BETA`：在 P1 首小时 PASS 后按小批邀请扩展；仍不得顺带开启 provider/Worker。
4. 每个真实 provider/Worker 单独 staging → canary → 首小时，不共享 P1/P2 结论。

## 2. 首小时采样

从容器启动到 60 分钟完整保留 Docker 状态/日志；主动采样从第 42 分钟开始，每 60 秒检查四个容器状态、健康和 restart count，并请求三域 `/api/health/live`、`/api/health/ready` 的状态码与耗时。此前 42 分钟由容器 StartedAt、restart count、health history、应用/Caddy 日志及 T9.0 部署后 smoke 回溯，不伪造不存在的逐分钟样本。

结果：18 个主动采样点产生 108 个 HTTP 样本和 72 个容器样本；HTTP 全部 200，p95 0.194430 秒、最大 0.221486 秒，容器故障/restart 为 0。Client、Operations、Maintenance 各 5 行启动日志且 error marker 为 0；Caddy 有界 20,000 行 tail 中命中三个测试域 260 行，5xx 与 error marker 均为 0。外部 Worker 仍为 0，Research/Runtime/Demo/Payment/Email Gate 均保持 false。

证据：`t97-first-hour-monitor.log` SHA-256 `a9f85324a25f0c94c581215e954030286ba6059cbe9adc77fbf8c1f54bf12209`；`t97-first-hour-summary-final.log` SHA-256 `e5de2ab64ad8c4e872e03927ea39e2371948db14a28a8416e481ea7abd11c3d8`。

## 3. 停止条件

出现任一项立即停止推进并保留证据：

- 任一容器 unhealthy/missing、restart count 增加，或同一 live/ready 连续两次非 200。
- 5 分钟窗口 5xx ≥1%、p95 ≥1 秒，或浏览器出现新的不可恢复 JS/page error。
- Secret、客户凭证、完整私有 endpoint、非授权 PII、跨 audience/scope 数据或错误 Host 非 404。
- fake paid/sent/filled 状态、重复权益/credits/账本/高水位、未知订单被当作未下单或成交。
- migration checksum、DB role、RLS、审计 hash/anchor、备份/恢复或 current/previous 发生漂移。
- 任一被排除的 provider、Worker、外部写入、真实模型调用、订单或资金路径意外启用。
- T9.5 人员演练未 PASS，或没有用户 production 授权。开发依赖临时例外已经关闭，不再是当前停止项。

## 4. 首小时结束检查

结束时必须记录：

- 三端/数据库 health 与 restart count；六个公网 health endpoint 的样本、失败数与延迟。
- Client/Operations/Maintenance/Caddy 从 StartedAt 起的 4xx/5xx、error/exception/unhandled/fatal marker；预期 401/404 必须与测试动作对应。
- 外部 Worker 仍为 0，所有 provider/外部写入 Gate 未变化。
- preview/production PostgreSQL 容器、卷、网络继续隔离；migration 仍为 77，角色策略无 finding。
- 任何异常的时间线、影响、处置、owner 和复测日期。

## 5. 复盘结论

待首小时采样结束后填写：

| 项目 | 结果 |
| --- | --- |
| 首小时技术 Gate | PASS：108/108 HTTP 200，72/72 容器样本健康，0 restart/5xx/error marker |
| 异常/停止条件 | 未触发；Caddy 使用有界 tail，未保存 IP/请求正文 |
| Preview 决定 | `KEEP P0`：r4 Web-only preview 可继续保留 |
| Production/付费 Beta 决定 | `HOLD`：开发依赖停止项已关闭；T9.5 和用户授权仍未闭环 |
| 后续 owner/日期 | 用户指定 T9.5 人员与发布负责人后填写 |

此记录的 PASS 最多表示 P0 preview 候选可保留；不能替代 production 首小时，也不能把 `HOLD` 改写成发布批准。
