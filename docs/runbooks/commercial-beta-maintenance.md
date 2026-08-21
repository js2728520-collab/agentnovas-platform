# Riverton Capital 付费 Beta Maintenance Runbook

## 1. MFA 恢复

1. 验证工单、账号、组织、回拨渠道和两名授权人员；不接受聊天截图作为唯一证据。
2. 冻结现有 session，记录 reason/requestId；使用一次性 recovery/reset 流程。
3. 新 recovery codes 只向本人一次展示，数据库只存 hash；运维人员不得复制保存。
4. 恢复后强制重新登录与 recent MFA，复核旧 session/recovery code 已失效。

## 2. Demo provider 熔断

触发：生产域名/危险权限、重复 clientOrderId、单笔/日限额异常、拒单激增、回执不一致、凭证疑似泄露。

1. 启用 provider 全局 kill switch，再按 card 缩小范围；记录 reason/actor/time/requestId。
2. 停止 Demo Execution Worker 新 claim，保留队列和数据库证据。
3. 核对客户 paper 不受影响；禁止为了“保持一致”回滚 paper 成交。
4. 检查 allowlist、权限、时钟、签名、限额和 query-after-timeout；轮换测试密钥时不在聊天/日志传值。
5. 使用 fixture 回归后再在 staging 做显式授权小额 smoke；解除后不自动重放未知结果 intent。

所有控制与验证操作完成后，在 Maintenance `/audit` 以 domain/action/status/cursor 复核命令状态、actor、reason、subject、requestId/traceId 与时间。该投影覆盖 Demo、模型、集成、商业设置、安全停控和身份/MFA allowlist 事件，不提供 response payload、幂等键、订单 ID 或密文；授权变更继续在 audience 隔离的 `/access/audit` 查询，Worker 实时状态在 `/health` 查询。

## 3. Email suppression 与恢复

- bounce/complaint 进入 suppression；complaint 不得记 delivered。升级时只回填 sender、provider/tag 和唯一 delivery 全部一致的历史事件，落库仅保存规范化收件人 SHA-256；冲突映射跳过并人工调查。
- 确认 domain/key/webhook/templates/retention/allowlist 和 Worker heartbeat；任一缺失保持 `configured_not_sent`。
- 核对 quiet hours 延迟使用客户 IANA 时区并覆盖 DST/跨午夜；延迟不得增加 attempts、持有 lease 或阻塞站内通知。
- 测试只发 allowlist 收件人并引用模板/version/idempotency key；不在 payload 保存密码/token。
- 解除 suppression 需要明确证据、原因和审计，不批量重发过期安全通知。

## 4. 密钥轮换

适用于 LLM、Email、Demo 账户和加密 KEK。先建立新 secret/version，验证 `hasSecret` 与测试环境权限，再原子切换引用并撤销旧值。浏览器/日志/文档/工单只记录 secret ID/hash 后缀，不记录明文或完整 endpoint。轮换失败立即 kill switch/disable，不用旧值通过聊天回传救急。

## 5. Worker stale / queue backlog

固定告警阈值由 `lib/maintenance-health-metrics.ts` 作为代码真源，Maintenance `/health` 同时返回当前深度、最老任务年龄和 warning/critical 阈值：

| 队列 | Warning | Critical | 初始响应 |
| --- | ---: | ---: | --- |
| Notification Email | 120 秒 | 300 秒 | 检查 Worker heartbeat、allowlist、suppression 和 Resend readiness |
| Platform Demo execution | 60 秒 | 180 秒 | 先确认 provider/card kill switch 与 external writes 开关 |
| Strategy runtime/research | 120 秒 | 300 秒 | Beta Research 固定 disabled；Runtime 核对 lease 与行情快照 |
| Membership review | 1 小时 | 4 小时 | 通知 Ops maker/checker，不代替业务审批 |
| Performance review/payment | 1 小时 | 4 小时 | 检查重叠账单和付款双审，不自动扣款 |

深度为 0 时状态为 healthy；有积压且年龄超过阈值才升级。公开 `/api/health/live` 和 `/api/health/ready` 仅返回 alive/ready 与时间；DB pool、迁移 checksum/commit、Worker/queue 细节只在 Maintenance RBAC 页面提供。建议发布告警同时监控：API 5xx ≥1%/5 分钟、p95 ≥1 秒/5 分钟、跨 audience 拒绝异常升高、Email complaint 任一、Demo duplicate clientOrderId 任一、Credits/权益重复副作用任一。后四项直接进入 SEV0/SEV1，不等待时间阈值。

1. 对比 configured、enabled、heartbeat age、commit SHA、last success/failure、current job、queue depth/oldest age。
2. 确认进程/systemd、DB connectivity、lease owner/fencing 和最近 deploy；环境开关不是存活证据。
3. Worker 恢复时依赖幂等/lease，不手工把未知任务标 success。
4. Demo/payment 相关异常优先 kill switch；Notification backlog 评估通知时效和 suppression。
5. 保存 requestId/worker instance/commit/job ID 与安全错误码，不复制 raw provider body。

## 6. 事故分级

- SEV0：真实订单/支付/提现路径可达、secret 泄露、跨 audience 大规模读取、重复高水位/credits；立即全局停控与通知负责人。
- SEV1：会员重复激活、Demo 限额/幂等异常、Email 大量错误投递、核心 Worker stale。
- SEV2：单客户可恢复错误、非核心页面/指标异常。

恢复顺序：阻断副作用 → 保全证据 → 明确客户影响 → 修复/回归 → 经授权恢复 → 事后报告。禁止删除账本/审计或直接生产 SQL 掩盖问题。
