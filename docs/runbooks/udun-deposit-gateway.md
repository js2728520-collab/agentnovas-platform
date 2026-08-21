# 优盾充值通道运行手册

## 1. 发布前配置

1. 在优盾商户后台确认当前账户使用 legacy MD5 商户协议、专属 HTTPS 节点、商户号、API Key、钱包编号（如需）及 USDT/TRC20 的 `mainCoinType`/`coinType`。不要从示例或其他商户复制 token 编号。
2. Client 与 Maintenance 运行时 secret 注入 `UDUN_GATEWAY_BASE_URL`、`UDUN_MERCHANT_ID`、`UDUN_API_KEY`、`UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook`；Maintenance 另配独立的 `PAYMENT_WEBHOOK_DATABASE_URL`。
3. 应用迁移 `0042_udun_deposit_gateway.sql`，重新执行最小权限角色脚本。不得把上述值写入 `.env.example` 之外的仓库文件。
4. 在 Maintenance `/integrations/payments` 保持 disabled，录入当前商户币种映射，设置 `PAYMENT_PROVIDER_TESTS_ENABLED=true`，执行连通测试。测试只调用支持币种查询，不创建地址或交易。
5. 测试通过后由有 recent MFA 的 Maintenance 管理员填写原因启用。先用内部 Client 账户创建 1 USDT 订单并在 staging 完成回调、maker/checker 和账本核对。

## 2. 正常流程

Client POST 使用 `Idempotency-Key` 创建订单；服务调用优盾生成专属地址。优盾回调必须验签、在五分钟内且未重放。`status=3` 只推进人工复核，不自动入账。Ops maker 在订单详情提交 `APPROVE_CREDIT`，不同 checker 批准后核对响应 `fundsExecuted=true` 与 `ledgerTransactionId`。

## 3. 对账

每日核对 `deposit_provider_events`、`deposit_orders`、`ledger_transactions`、`ledger_postings`、`wallet_balance_versions`。任何 provider 成功事件无订单、token 映射不一致、同一 tx 多订单、CREDITED 无账本或账本无余额版本均升级为 P0 并停用通道。

## 4. 紧急停用

Maintenance 立即把 provider 切到 disabled；这会阻止新地址和新回调推进订单，但保留全部证据。轮换 API Key、排查专属节点/TLS/DNS/时间同步和数据库角色；不得通过删除事件或手改账本“修复”。恢复必须重新测试和内部小额验收。

## 5. 明确禁止

- 不调用或实现 `/mch/withdraw`、代付、划转或自动退款。
- 不在聊天、工单、日志、截图或 Git 中粘贴 API Key/完整回调 payload。
- 不手工把订单改成 CREDITED，不删除/更新 provider event 或账本分录。
- 不把“地址已生成”“回调已验签”描述为“资金已入账”。
