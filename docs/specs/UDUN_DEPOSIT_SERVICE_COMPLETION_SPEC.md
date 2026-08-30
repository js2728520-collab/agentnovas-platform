# 优盾充值服务完成规格

状态：Implementation
日期：2026-08-29
产品边界：USDT/TRC20 deposit-only
架构决定：[ADR-0027](../adr/0027-udun-deposit-service-completion.md)

## 1. 完成定义

“充值可用”必须是以下闭环同时成立，而不是某一个环境变量或进程存在：

1. Maintenance 能以只写方式安装/轮换配置并看到确定结果。
2. Provider 支持币种测试证明目标映射真实存在。
3. 公网回调从官方信封格式到应用验签、幂等事件和订单状态机可达。
4. Client 只展示服务端确认可用的网络，并能创建、复制地址和跟踪状态。
5. Provider 到账不会自动入账；Operations maker/checker 原子入账保持有效。
6. 所有秘密、失败、重复、并发、超时和回滚路径有自动化证据。

缺少真实优盾测试商户参数或小额链上交易时，代码可达到 `ready_for_live_test`，但不得宣称真实充值闭环已通过。

## 2. 官方协议合同

### 2.1 出站请求

- Endpoint 只允许：`POST /mch/address/create`、`POST /mch/support-coins`。
- 信封字段严格为 `timestamp`、`nonce`、`sign`、`body`。
- `sign = lower(md5(body + apiKey + nonce + timestamp))`。
- Provider 请求使用 JSON；8 秒超时、禁止重定向、响应体限额并进行 schema 校验。
- 地址请求字段版本为 `mainCoinType | coinType`，由配置显式选择，默认当前文档的 `mainCoinType`；失败后不得自动切换字段并重试。
- Alias 只使用平台随机订单 id，不包含邮箱、手机号、姓名或其他 PII。

### 2.2 回调请求

- 首选并按官方调试工具接收 `application/x-www-form-urlencoded`；兼容 `application/json` 只用于旧商户配置迁移。
- Form 必须每个键恰好一次，且只能出现 `timestamp`、`nonce`、`sign`、`body`；保留 `body` 原始字符串。
- 最大请求体 64 KiB；时间戳允许秒或毫秒，最大偏差 5 分钟。
- 只接受 `tradeType=1`；状态 0–4。状态 3 才进入人工复核，状态 2/4 失败，其余仅更新确认过程。
- 唯一键：`provider + eventId`、`provider + nonceHash`、`network + txId + txIndex`、`provider + network + depositAddress`。

## 3. 配置与密钥托管

### 3.1 可写配置

| 字段 | 验证 | 页面投影 |
| --- | --- | --- |
| Gateway base URL | HTTPS、无认证信息/查询/片段、严格优盾域名 | 仅“已配置” |
| Merchant ID | 数字 1–32 位 | 仅“已配置” |
| API Key | 8–256 字符、无空白和换行 | 仅“已配置” |
| Callback URL | 精确允许 Host 与固定 webhook path | 仅“已配置” |
| Address coin field | `mainCoinType` 或 `coinType` | 可显示枚举值 |

浏览器产生 `RSA-OAEP(SHA-256) + AES-256-GCM` 信封。配置请求包含 `install | rotate`、key id、密文、理由、操作者、幂等键、状态、受限错误码和时间；不保存明文。

### 3.2 进程边界

- Maintenance Web：可读取 Broker 公钥和受管配置的安全状态；不可读取私钥或 API Key。
- Client Web：可读取 Client 专用受管文件以调用地址接口；不可读取 Broker 私钥。
- Maintenance Webhook/Test：可读取 Maintenance 专用受管文件以验签和测试。
- Payment Secret Broker：可读取自己的私钥和专用数据库队列，可写两个消费文件；不能读取其他密钥。
- PostgreSQL：只保存配置请求密文、状态、指纹、测试证据和业务事实。

### 3.3 Broker 状态机

`pending → applying → applied | failed`

- 同一 key id 和幂等键只能产生一个请求。
- 更新必须写临时目录、校验 owner/mode、`fsync`、原子 rename，再写 manifest。
- 任一步失败保留上一个 manifest，不产生部分版本。
- 心跳超过 90 秒视为不可用。

## 4. Provider 配置与启用 Gate

币种映射包含 `network=TRC20`、`asset=USDT`、`mainCoinType`、`tokenCoinType`、可选 `walletId`。映射和商户配置任一变更都会清空测试有效性。

Provider 测试结果：

- `passed`：HTTP/Provider code 正常，响应 schema 有效，且目标主币/代币组合存在。
- `failed`：仅记录稳定错误码，不保存 Provider 原文、URL、商户号或密钥。

回调探测结果：

- 仅向配置中经过精确 allowlist 的回调 URL 发送无效签名的结构化请求。
- 预期收到应用的 `WEBHOOK_SIGNATURE_INVALID`，证明 DNS/TLS/Nginx/路由可达且不会写业务事实。
- 404、网络错误、重定向、非目标错误均失败。

激活同时要求：配置已应用、Broker 新鲜、映射完整、外发授权开启、两项测试均通过且不超过 24 小时。停用始终允许。

## 5. 充值订单状态机

```text
ADDRESS_PROVISIONING
  ├─ provider success ─> PENDING_CONFIRMATION ─> CONFIRMING ─> MANUAL_REVIEW ─> CREDITED
  ├─ deterministic failure ─> ADDRESS_FAILED
  └─ timeout/unknown result ─> ADDRESS_UNKNOWN

PENDING_CONFIRMATION / CONFIRMING
  └─ provider rejected/failed ─> FAILED
```

- 订单预留必须先于外部调用，并受幂等键与开放订单唯一索引保护。
- `ADDRESS_UNKNOWN` 不允许自动重试，也不向客户展示地址。
- 地址更新使用 `WHERE order_status='ADDRESS_PROVISIONING'` 条件写；异常并发不得覆盖最终状态。
- 开放订单集合包含 provisioning、pending、confirming、manual review 与 unknown。
- 客户 API 不返回 Provider 配置、错误正文、事件 payload 或内部风险细节。

## 6. API

### Maintenance

- `GET /api/maintenance/payment-secrets/status`
- `GET /api/maintenance/payment-secrets/public-key`
- `POST /api/maintenance/payment-secrets/requests`
- `GET /api/maintenance/payment-secrets/requests/:id`
- `PATCH /api/maintenance/payment-providers/:id/configuration`
- `POST /api/maintenance/payment-providers/:id/test`
- `POST /api/maintenance/payment-providers/:id/callback-test`
- `PATCH /api/maintenance/payment-providers/:id/status`

所有写请求要求 Maintenance 权限、近期 MFA、同源、Idempotency-Key 和 3–500 字审计原因。

### Client

`GET /api/wallet/deposit-orders` 返回：

- `orders`：客户自己的安全订单 DTO；
- `options.currency = USDT`；
- `options.networks`：仅当前有效且启用的网络；
- `options.availability`：`available | unavailable | temporarily_unavailable` 与安全原因码。

`POST /api/wallet/deposit-orders` 只接受 API 返回的可用网络，并使用订单预留状态机。

## 7. Maintenance UI

页面分为“概况、配置、测试与记录”：

- 概况：有效状态、配置版本、Provider/回调测试时间、外发授权、Broker 心跳。
- 配置：只写商户配置与币种映射；明确“无法回显，轮换需填写全部字段”。
- 测试与记录：显示测试目标、开始/结束时间、结果、稳定错误码和操作者；按钮旁明确不会创建地址或转账。
- 启用按钮只有视觉上的 readiness 提示；服务端仍重新计算全部 Gate。

## 8. Client UI

- 无可用网络时隐藏创建表单并显示可恢复说明。
- 有可用网络时仅显示服务端网络列表，默认第一项。
- 进行中订单每 8 秒自动刷新；页面隐藏时暂停，组件卸载时清理定时器。
- 地址提供复制按钮及 `aria-live` 反馈；不显示二维码。
- `ADDRESS_PROVISIONING`、`ADDRESS_UNKNOWN`、`ADDRESS_FAILED` 有不同客户文案，不展示秘密或 Provider 原始错误。

## 9. 测试与发布

1. 单元：签名、form/JSON 信封、重复/额外字段、时间、地址字段版本、响应 schema、支持币种匹配。
2. PostgreSQL：迁移 fresh/rerun、配置队列最小权限、预留并发、回调幂等、入账 exactly-once。
3. API：权限、同源、MFA、幂等、激活 Gate、动态网络和安全 DTO。
4. 浏览器：Maintenance 配置/测试/启停，Client 无配置/生成中/地址/链上状态，320–1440 px 与键盘操作。
5. 在 `an-saas` 运行 Node 22.21+ 测试、TypeScript、lint 和相关生产构建。
6. 只部署 `test.agentnovas.com` 与 `main-test.agentnovas.com` 的受影响服务；不修改 production。
7. 无真实商户参数时停在 `ready_for_live_test`。有参数后由操作者在测试站完成 1 USDT 小额链上闭环，核对 Provider event、人工双审、账本平衡、钱包版本和通知，再决定是否进入生产评审。
