# 优盾充值通道运行手册

> 适用状态：`CURRENT_BASELINE`。只覆盖 USDT/TRC20 deposit-only。提现、代付、划转、自动退款、自动入账和通用支付均不在本手册范围内。

## 1. 完成口径

充值通道只有同时满足以下事实，才可对 Client 显示：

1. Payment Secret Broker 已把完整商户配置原子应用到 Client 与 Maintenance 的同一版本；
2. 数据库币种映射与受管配置版本一致；
3. Provider 支持币种测试在 24 小时内通过；
4. 公网回调测试在 24 小时内通过；
5. Broker 心跳不超过 90 秒；
6. Client 与 Maintenance 的 `PAYMENT_PROVIDER_OUTBOUND_ENABLED=true`；
7. Provider 数据库状态为 `active`。

任一条件失效，Client 会立即隐藏可创建地址的网络。页面显示 `configured`、HTTP 200 或地址已生成都不等于资金已入账；到账回调只能推进到 `MANUAL_REVIEW`，Operations 双人复核后才写账本。

没有真实测试商户配置和 1 USDT 链上证据时，发布结论只能写 `ready_for_live_test`。

## 2. 官方协议基线

取值以当前商户后台和优盾开发中心为准：

- 专属 Gateway：`https://*.udun.io` 的根地址，不得使用管理后台地址或追加 API path；
- Merchant ID：1–32 位数字；
- API Key：只写，禁止进入 Git、聊天、截图、日志或数据库明文；
- Callback URL：测试站固定为 `https://main-test.agentnovas.com/api/integrations/payments/udun/webhook`；
- `mainCoinType` 与 `tokenCoinType`：必须通过当前商户的 `/mch/support-coins` 响应确认，不能复制文档示例；
- Address coin field：当前中文文档使用 `mainCoinType`，旧英文协议示例使用 `coinType`。必须显式选择，失败后禁止自动换字段重试。

请求和回调信封均为 `timestamp`、`nonce`、`sign`、`body`，签名为小写 `md5(body + key + nonce + timestamp)`。公网回调首选官方调试工具使用的 `application/x-www-form-urlencoded`，JSON 只用于兼容旧配置。应用兼容回调正文中的 `txid` 与 `txId`，两者同时出现且不一致时拒绝。

## 3. 首次部署 Payment Secret Broker

先迁移 `0092_udun_deposit_service_completion.sql`，再重新应用最小权限角色。迁移前必须备份测试数据库并验证备份 TOC。

在服务器仓库外复制答案模板，填写专用 Broker 数据库角色和受控回调 Host；文件权限必须为 0400 或 0600：

```bash
sudo install -d -m 0700 /root/agentnovas-config
sudo cp deploy/env/payment-secret-broker-bootstrap.answers.example \
  /root/agentnovas-config/payment-secret-broker-bootstrap.answers
sudo chmod 0600 /root/agentnovas-config/payment-secret-broker-bootstrap.answers
sudoedit /root/agentnovas-config/payment-secret-broker-bootstrap.answers

sudo scripts/install-payment-secret-broker.sh --check \
  /root/agentnovas-config/payment-secret-broker-bootstrap.answers
sudo scripts/install-payment-secret-broker.sh --apply \
  /root/agentnovas-config/payment-secret-broker-bootstrap.answers
```

安装器只生成 Broker RSA 密钥、受管目录与最小环境配置，不接收 Provider API Key，不调用优盾，也不会启用外发。随后启动 Broker，并保持两个外发开关为 false：

```bash
docker compose --profile payment-secret-broker up -d payment-secret-broker
bash scripts/audit-production-config.sh /etc/agentnovas-riverton
```

预期看到：

- `payment_secret_broker_configuration=ready`
- `payment_provider_outbound=disabled`
- 在尚未通过 UI 安装商户配置时，`udun_configuration=incomplete`

## 4. Maintenance 页面配置

使用具备 `maint.payment_integrations.manage`、recent MFA 和正确 Maintenance audience 的账号打开“外部集成 → 支付”。

### 4.1 安装或轮换商户配置

1. 保持通道为 `disabled`；
2. 打开“配置”，填写 Gateway、Merchant ID、API Key、固定公网 Callback URL 与地址字段版本；
3. 填写 3–500 字变更原因；
4. 点击“安装商户配置”或“轮换完整商户配置”；
5. 等待请求进入 `applied`，核对配置版本和 16 位指纹。字段不会回显，轮换必须重新填写全部字段。

浏览器先以 AES-256-GCM 加密配置，再用 Broker RSA-OAEP/SHA-256 公钥包装数据密钥。数据库只保存密文信封；Broker 私钥不进入 Web 容器。Broker 写入失败时保留上一版本并返回稳定错误码。

### 4.2 保存币种映射

1. 从当前商户 `/mch/support-coins` 结果取得 USDT/TRC20 的 `mainCoinType`、`tokenCoinType` 和可选 `walletId`；
2. 在通道仍为 `disabled` 时保存；
3. 核对保存后旧 Provider/回调测试均被清空。

任何配置或映射变更都会使旧测试证据失效。

## 5. 测试和启用

测试环境可将 Maintenance 的 `PAYMENT_PROVIDER_TESTS_ENABLED=true`。Provider 外发授权 `PAYMENT_PROVIDER_OUTBOUND_ENABLED` 必须在 Client 与 Maintenance 保持同值，且变更需重建对应容器。

在“测试与记录”填写本次测试原因：

1. “Provider 连通测试与币种校验”只调用 `/mch/support-coins`，要求目标主币/代币组合、symbol 和 decimals 有效；不会创建地址或转账；
2. “测试公网回调”向精确 allowlist URL 发送无效签名，必须收到应用的 401 `WEBHOOK_SIGNATURE_INVALID`；它证明 DNS、TLS、Nginx 和验签路由可达，不写订单或资金事实；
3. 核对追加式测试历史中的目标、开始/结束时间、配置版本、结果、稳定错误码、脱敏操作者与原因。

启用前将 Client 和 Maintenance 的 `PAYMENT_PROVIDER_OUTBOUND_ENABLED=true`，重新部署并刷新页面。只有服务端 Gate 全绿时“启用充值”才可执行。Gate 不通过时不得直接更新数据库状态。

## 6. 测试站真实 1 USDT 闭环

真实闭环必须得到当次明确授权，并使用测试商户和内部 Client 账户：

1. Client 选择服务端返回的 TRC20，创建 1 USDT 订单；
2. 核对订单先为 `ADDRESS_PROVISIONING`，成功后才显示真实地址并进入 `PENDING_CONFIRMATION`；
3. 向该地址发送 1 USDT，不重复点击或重新创建地址；
4. 对齐优盾 `tradeId`、`txid/txId`、本地 provider event 和订单；
5. 等待有效回调推进 `CONFIRMING` / `MANUAL_REVIEW`；
6. Operations maker 提交入账，使用不同 checker 批准；
7. 核对 `CREDITED`、ledger transaction/postings、wallet balance version、审计和通知完全一致；
8. 保存不含密钥、完整回调正文和客户 PII 的证据。

HTTP 202/200、Provider `status=3` 或 `MANUAL_REVIEW` 都不能替代第 6–7 步。

## 7. 超时、对账与事故处理

- `ADDRESS_FAILED`：Provider 返回确定拒绝，可在修复配置后由客户发起新的业务意图；
- `ADDRESS_UNKNOWN`：调用超时、断连或本地地址映射失败。Provider 可能已经创建地址，禁止自动重试。Operations 必须核对 Provider 后台与审计，再形成新的人工处置记录；
- `PENDING_CONFIRMATION` 长时间无回调：检查 Provider 交易、固定回调 URL、证书、Nginx exact location、时间同步和 webhook 数据库角色；
- 测试过期、Broker 心跳过期或配置版本不一致：Client 自动关闭新建址入口，已有订单和证据保留；
- 同一 tx 多订单、Provider 成功无订单、`CREDITED` 无账本、账本无余额版本：按 P0 处理并立即停用。

每日对账：`deposit_provider_events`、`deposit_orders`、`ledger_transactions`、`ledger_postings`、`wallet_balance_versions`。不得通过删除事件、修改测试历史或手改账本恢复。

## 8. 紧急停用与回滚

1. Maintenance 填写原因并停用 Provider；停用始终允许；
2. 将 Client 与 Maintenance 的 `PAYMENT_PROVIDER_OUTBOUND_ENABLED=false` 并重建；
3. 保留 Webhook exact path，使已经给出的地址仍能接收和记录合法回调；
4. API Key 泄漏时在 Provider 侧撤销旧 Key，通过只写页面轮换完整配置；
5. 重新保存映射后执行两项测试，再完成内部小额闭环；
6. 代码回滚不得回滚数据库事实、删除新状态或恢复环境变量中的旧密钥。

## 9. 明确禁止

- 不实现或调用提现、代付、划转、自动退款、自动入账或任意资金出站接口；
- 不在源码、环境模板、工单、聊天、日志和截图中保存 API Key、商户号组合或完整回调正文；
- 不把示例币种编号、假地址、二维码、模拟回执或 HTTP 成功冒充真实充值证据；
- 不对未知结果自动重试地址创建；
- 不让同一 Operations 人员完成 maker 与 checker；
- 不在未完成测试站小额闭环前启用生产。
