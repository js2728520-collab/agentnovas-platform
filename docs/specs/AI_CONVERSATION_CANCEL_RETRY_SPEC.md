# AI 对话取消、重试与幂等合同

状态：`TARGET_TRUTH / PARTIAL_CURRENT`

日期：2026-08-24

关联：PRD V3.0 6.3、`V3_CLIENT_APP_TARGET_SPEC.md`、ADR-0021、迁移 0038

## 1. 目标与边界

本切片完成 AI 普通对话的用户取消、结果不确定时的原请求重放、Credits 安全终态和浏览器错误恢复。
现有可信 provider usage、reservation/settle/release 与不可变流水继续作为计费真源。

本切片不决定每次对话的固定 Credits 数值或模型/功能分档；该数值仍由 P-08 阻断。现有
`token-cost-v1` 只能作为当前按可信用量结算机制，不能冒充需求方确认的固定价格。

实现状态（2026-08-24）：本规格除固定 Credits 数值/分档外已由提交 `b8b1bda` 实现；AI 页眉
可访问对比度修复提交为 `2faf8d8`。全量 1418/1418、云端三端 production build 与真实 Chromium
19/19 通过。

## 2. 信任与威胁边界

- 浏览器只能取消当前账号拥有的 inference request，不能提交 user ID、reservation ID 或 Credits 数值。
- inference ID 不构成授权；服务端必须同时按当前 session user 过滤，跨租户与不存在返回同一 404。
- cancel 是同源、权限保护、带 `Idempotency-Key` 的写操作；请求体为空，不接受任意状态或原因。
- 浏览器断流、显式取消、provider 返回、结算与持久化可能并发。数据库行锁与 reservation 行锁决定唯一终态。
- 取消不得删除已保存的用户问题、已有回复或流水，不得泄露 provider request ID、usage、模型端点或密钥。
- LLM 调用仍受 45 秒超时、输入/输出上限、请求限额和确定性输出校验约束。

主要滥用场景：猜测他人 inference ID、重复取消、取消与完成竞态、断网后重复调用模型、结算后伪装退款、
取消按钮只停止 UI 但后台继续扣费。上述路径必须由所有权查询、幂等终态和事务测试失败关闭。

## 3. 状态合同

`client_ai_inference_requests` 继续使用既有 `processing | succeeded | failed` schema，不新增破坏性迁移。
取消用失败终态的稳定错误码表达：

- `processing + reserved/released → failed(AI_REQUEST_CANCELLED)`：若仍为 reserved，在同一事务释放；返回
  `cancelled / released`。
- `succeeded → succeeded / settled`：完成先赢得行锁，取消不能删除结果或退款；Client 重新读取对话。
- `failed(AI_REQUEST_CANCELLED) → cancelled / released`：重复调用幂等返回，不新增 release 分录。
- 其他已失败且 reservation 已释放 → `failed / released`：不重开旧请求。
- `processing + settled` 异常窗口 → `AI_RECONCILIATION_REQUIRED`：不得声称取消成功或自动退款。

迟到的 provider 成功不能把 cancelled/failed 请求重新置为 succeeded，也不能新增 settle 分录。

## 4. REST 与 SSE 合同

### 4.1 消息 SSE

`POST /api/ai/conversations/:id/messages` 的 `meta` 事件加法式增加：

```json
{"inferenceRequestId":"server-owned-uuid"}
```

旧字段与旧已持久化 replay 继续兼容。只有收到该 ID 后，Client 才显示可执行的“取消生成”。

### 4.2 取消资源

`POST /api/ai/inferences/:id/cancel`

- Header：`Idempotency-Key` 必填，8–128 字符。
- Body：无。
- 权限：Client session + `client.paper.view`；same-origin。
- 成功：HTTP 200，返回以下判别联合之一，不返回原结果或 provider 细节：

```json
{"inference":{"id":"...","state":"cancelled","creditsDisposition":"released"}}
{"inference":{"id":"...","state":"succeeded","creditsDisposition":"settled"}}
{"inference":{"id":"...","state":"failed","creditsDisposition":"released"}}
```

- 不存在/跨租户：404 `AI_REQUEST_NOT_FOUND`。
- 已结算但结果不完整：409 `AI_RECONCILIATION_REQUIRED`。

## 5. Client 交互

- 生成开始后显示真实状态；收到 server-owned inference ID 后显示“取消生成”。
- 点击取消先中止当前浏览器 stream，再调用取消 API 确认数据库终态；按钮进入 busy，禁止重复提交。
- `cancelled`：清空临时生成文本，保留已持久化用户问题，显示“已取消且未结算 Credits”。
- `succeeded`：说明回复已在竞态中完成并重新加载对话，不伪报取消成功。
- 网络结果不确定：继续保留现有“重试原请求”，必须复用原 Idempotency-Key，只查询同一结果，不重复
  调用模型、写入用户消息或扣费。
- terminal provider failure/cancel 不允许用旧 key 重开；可把原问题放回编辑框，由用户明确发起新请求。
- 页面切换、归档和新建对话在生成期间继续禁用，防止把取消目标错绑到其他会话。

## 6. Provider abort 合同

`requestAiText` 接受可选外部 `AbortSignal`，并与既有 45 秒 timeout 组合。消息 route 把当前请求 signal
传入首次生成和 DSL 修复调用。Abort 进入 `AI_REQUEST_CANCELLED` 失败终态并释放未结算 reservation；
原始 AbortError、端点和密钥不得返回浏览器或日志。

## 7. 验收证据

- 纯函数/provider 合同：外部 abort 与 timeout 均生效，未传 signal 保持兼容。
- PostgreSQL：所有权、重复取消、cancel-vs-complete 两种行锁顺序、迟到成功、单次 release、settled
  anomaly 与余额不变。
- Route/inventory：精确 permission、same-origin、idempotency、统一错误结构、无请求体状态注入。
- UI 合同与 production Chromium：真实显示/点击取消，无 dialog；取消请求只发一次；保留用户问题；
  不出现回复、外部请求、console error 或重复扣费文案。
- 全量测试、TypeScript、ESLint、架构边界、secret scan、production audit、云端三端 build 与三端登录。
