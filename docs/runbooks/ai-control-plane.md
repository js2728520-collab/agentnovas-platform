# AI 控制面运维 Runbook

状态：`TARGET_TRUTH / CANDIDATE_COMPLETE`

日期：2026-08-30

适用范围：自托管 Linux、Node.js 22.21.0+、PostgreSQL、Maintenance Web、Client Web、Research Worker、
Runtime Worker、AI Secret Broker 与 loopback AI Gateway。本 Runbook 不授权真实 Provider 测试、部署、公开
npm 发布、真实交易或恢复 legacy 永续 Research Worker。

## 1. 不变量与启动顺序

- `AI_GATEWAY_ENABLED=false`、`AI_SECRET_BROKER_ENABLED=false`、`STRATEGY_RESEARCH_ENABLED=false` 和
  `STRATEGY_RUNTIME_ENABLED=false` 是模板默认值。
- Maintenance/Client Web 与普通 Worker 不配置 `LLM_PROFILE_ENCRYPTION_KEY`，也不能读取 Broker 私钥目录。
- Gateway 只监听 `127.0.0.1`，不得增加 Nginx location；Provider 端点只允许公共 HTTPS。
- Secret Broker 独占私钥；Gateway 只读受管 Key 文件。受管目录必须为 `0700`，文件必须为 `0600`。
- 配置、Probe 和 Fake Provider 测试不能证明真实 Provider 就绪。真实 Provider 验收必须另行授权。

首次启用顺序：迁移与数据库角色 → Broker 公钥/私钥 → Secret Broker → 迁移或录入 Provider Key → AI
Gateway → Maintenance/Client 的 Gateway 开关。Research 与 Runtime 必须保持关闭，除非另有独立运行授权。

## 2. 安装前 Gate

在候选源码和目标 Node 版本执行：

```bash
npm ci
npm run build:packages
npm run test:packages
npm run pack:packages
npm test
npx tsc --noEmit --incremental false
npm run lint
npm run quality:boundaries
npm run quality:key-custody
npm run quality:secret-scan
npm run test:apps
npm run test:e2e
git diff --check
```

`quality:key-custody` 必须在三端 production build 已生成后执行。失败不得通过复制 Key、恢复 Web 解密或开放
Gateway 公网入口绕过。

## 3. PostgreSQL 迁移与角色

1. 使用现有专用 migrator 和备份 Gate 创建、验证可恢复备份。
2. 执行迁移到 `0094_ai_secret_custody.sql`。`0093`/`0094` 都是可重跑的加法迁移。
3. 应用 `deploy/postgres/least-privilege-roles.sql`，运行 PostgreSQL role-policy Gate。
4. 验证以下边界：
   - `agentnovas_maint_web` 只读安全视图并执行 Maintenance mutation 函数；
   - `agentnovas_ai_secret_broker` 能 claim/complete secret command，不能调用 Provider；
   - `agentnovas_ai_gateway` 能读取固定调用修订、受管引用和统一用量表；
   - `agentnovas_client_web` 只读显式 Client binding 并结算自身 invocation Credits；
   - `agentnovas_research_worker` 保持 `NOLOGIN` 且无 AI 控制面 grant。

旧 `llm_profiles`、`llm_profile_revisions` 和旧 binding 表不得删除。它们是兼容窗口和旧版本回滚快照，不再是
新运行路径的密钥真源。

## 4. 初始化 Secret Broker Key

在 Broker 主机的受限会话生成 RSA-3072 私钥。不要把私钥、数据库密码或命令输出写入 Git、工单或日志。

```bash
install -d -m 0700 /etc/agentnovas/secrets/ai-broker-keyring
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /run/ai-broker-next.pem
chmod 0600 /run/ai-broker-next.pem
openssl pkey -in /run/ai-broker-next.pem -pubout -outform DER -out /run/ai-broker-next.spki
```

为本次 key generation 生成不含秘密的 `brokerKeyId`，计算公钥 SPKI Base64 和 SHA-256 指纹，将它们通过
migrator 事务写入 `ai_secret_broker_keys`。同一时刻最多一个 `status='active'`。注册完成后，将私钥移动为：

```text
/etc/agentnovas/secrets/ai-broker-keyring/<sha256(brokerKeyId)>.pem
```

配置 `AI_SECRET_BROKER_PRIVATE_KEY_DIRECTORY` 指向该 `0700` 目录；keyring 中每个 PEM 必须是普通、非符号链接
的 `0600` 文件。单一 `AI_SECRET_BROKER_PRIVATE_KEY_FILE` 仅用于未轮换的兼容部署，两项同时配置时使用 keyring。
删除 `/run` 中的临时公私钥文件，并单独验证 DB 指纹与本地 SPKI 指纹一致。

## 5. Broker Key 轮换

1. 先生成、落盘并验证新 generation；旧私钥仍留在 keyring。
2. 在一个数据库事务中把旧 active key 改为 `retiring`，再插入新 active key。
3. Maintenance 从安全视图只会得到新公钥；已经排队的旧 envelope 仍由 `brokerKeyId` 命中旧私钥。
4. 等待旧 key 的 `requested/processing/failed` 命令数为零，并核对所有成功命令已有 custody receipt。
5. 给旧 key 设置 `not_after` 并改为 `retired`。历史调用或未完成任务仍引用的 Provider secret 文件不得随
   Broker key 一并删除。
6. 经过约定回滚窗口和双人证据复核后，才可从 keyring 移除旧私钥。

Broker command 使用租约和 fencing。进程崩溃后新实例只能在租约过期后接管；旧实例的 completion 必须以
`AI_SECRET_COMMAND_FENCE_MISMATCH` 失败。

## 6. 迁移旧模型 Key

只在隔离、无 Web/普通 Worker 的一次性进程执行：

将 `ALLOW_LEGACY_LLM_SECRET_MIGRATION=true`、专用 migrator `DATABASE_URL` 和 legacy master key 写入宿主 secret
管理器生成的单次 `0600` env 文件（例如 `/run/credentials/ai-legacy-migration.env`），值不要进入命令行或 shell
history，然后执行：

```bash
NODE_USE_ENV_PROXY=1 node --env-file=/run/credentials/ai-legacy-migration.env \
  scripts/migrate-legacy-llm-secrets.mjs
```

该工具只排队浏览器同构 envelope，不写明文。随后启动 Broker 处理队列，记录输出中的 `queued`、`skipped` 和
`evidence` 计数，再以 SQL 核对：

- 每个含旧密文的 revision 都有 succeeded migration receipt 或稳定失败码；
- succeeded command 的 `wrapped_data_key/iv/ciphertext/auth_tag` 已清空；
- Connection revision 只保留 `secretRef` 和指纹；
- 受管目录/文件权限分别为 `0700`/`0600`。

核对完成后，从 Maintenance、Client、Research、Runtime 和普通 Worker 环境彻底移除
`LLM_PROFILE_ENCRYPTION_KEY`。在旧版本回滚窗口结束前，可将 legacy master key 离线封存；不得放回 Web 环境。

## 7. 日常配置旅程

Maintenance `/ai-strategy?tab=models` 的顺序固定为：

1. 新建 Connection 与 Deployment revision；可选填 Rate Card，留空即 `unpriced`。
2. 浏览器取得 Broker 公钥，在浏览器内 AES-256-GCM 加密 Provider Key，并以 RSA-OAEP-SHA256 包装数据密钥。
3. 等待 Broker receipt；失败时只显示安全错误码，不重新提交另一 payload 到同一 idempotency key。
4. 对当前 Deployment revision 执行 Probe。Probe 依次验证 endpoint、认证、模型发现和最小 invocation。
5. 检查配置指纹、发现的模型、安全错误码和延迟。只有最近一次、匹配当前指纹且 24 小时内成功的 Probe 才能激活。
6. 为 12 个显式角色分别配置一个 primary 与至多两个 fallback，再激活 Binding revision。
7. 检查消费者状态：`active`、`gated`、`disabled` 或 `retired`。有 Binding 不代表对应 Worker 已运行。

Connection/Deployment 变更总是创建新 revision。历史修订不能覆盖或删除；回滚动作复制历史配置形成一个新的
current revision，并先禁用 Deployment，重新 Probe 后才能激活。

## 8. Gateway 与用量

`deploy/env/ai-gateway.env.example` 中的共享密钥必须通过宿主 secret 管理分发给获准调用方，长度至少 32 字符，
不得进入源码或 argv。Gateway 服务单元没有 Nginx 暴露，且对 `/v1/invoke`、`/v1/probe` 执行鉴权、1 MiB
请求上限、并发/分钟速率限制、超时、取消和幂等检查。

同一 `invocationId + requestHash` 重试返回已保存终态，不重复调用 Provider；同 ID 不同 hash 返回冲突。只对
network、timeout、429 和 Provider 5xx 使用下一 fallback。流式调用以标准化 SSE content 与 terminal receipt
结束；调用方永远得不到 Provider Key。

Maintenance `/ai-strategy?tab=usage` 默认排除 Probe，按需切换。核对项目：

- requested/attempted/processing/succeeded/failed/cancelled；
- input/output/cached/reasoning Token；
- queue/Provider/total latency p50/p95；
- 实际 Deployment/Connection revision、fallback rank 和安全错误分类；
- Provider 成本与 settled Credits 分栏；无 Rate Card 时为 `unpriced`，不得估算；
- 80%/100% 预算只生成告警事实，不自动关闭业务。

安全视图和日志不得包含 Prompt、结果、原始用户 ID、完整端点、Provider request ID 或任何 secret。Provider
request ID 在原始 receipt 中也只允许保存 SHA-256 摘要。

## 9. 故障与回滚

### Broker 故障

- 保持 Gateway/真实调用关闭；检查稳定错误码、key generation、租约和文件权限，不打印 envelope。
- 不手工清空 processing；等待租约过期，由新实例用新 fencing 接管。
- 原子文件写成功但 DB completion 失败时，可安全重试同一 command；确定性文件名和 fencing 防止错误终态。

### Gateway 故障

- 将所有调用方 `AI_GATEWAY_ENABLED=false`，停止 Gateway；已运行确定性业务继续走关闭态/降级态。
- 不把 Provider Key 临时复制给 Web/Worker。检查 loopback、专用 DB role、受管目录和共享鉴权。
- 相同 invocation 只用相同 request hash 重放；冲突不得换 ID 掩盖。

### 配置回滚

- 选择历史 Deployment revision，创建新的回滚 revision；不得更新或删除历史行。
- 重新 Probe、重新 Binding；已有任务继续使用其固定 revision snapshot。

### 应用版本回滚

- 先关闭 Gateway、Broker 和所有外部 AI Worker 开关。
- 数据库迁移是加法迁移，不执行 destructive down migration。
- 回滚旧应用代码时，旧表仍在；如旧版本确实需要 legacy master key，只能按旧版本隔离流程临时恢复，完成后再次移除。
- 任何失败验收都保留候选分支/工作树和数据库证据，不强制删除。

## 10. 验收证据与停止条件

必须保留：迁移前备份/恢复验证、迁移可重跑结果、角色策略结果、Broker migration counts、文件权限、Fake Provider
调用/幂等/fallback/统一用量、tarball 临时安装、三端 build、浏览器四断点/键盘/axe、secret scan 和每项日志
SHA-256。Fake Provider 证据必须明确标为本地模拟，不能写成真实 Provider 验收。

出现以下任一情况立即停止启用并回滚开关：Web build/响应/日志出现 Key；Gateway 非 loopback；安全视图包含秘密
或原始内容；同一 invocation 重复调用 Provider；非瞬态错误触发 fallback；确定性风控/订单边界被 LLM 改写；
Research/Runtime/真实交易被意外启用。
