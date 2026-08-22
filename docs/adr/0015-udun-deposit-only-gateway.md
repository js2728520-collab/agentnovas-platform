# ADR-0015：优盾充值专用通道

状态：Accepted（2026-08-21）

## 决策

Client 可通过优盾创建 USDT 充值地址，但平台只接入 `/mch/address/create`、`/mch/support-coins` 和充值回调。任何提现、代付、划转、自动扣款或退款 endpoint 均不实现、不加入 allowlist，也不出现在 UI。

优盾旧版商户协议以 `md5(body + key + nonce + timestamp)` 签名。MD5 仅作为外部协议兼容层使用：签名按常量时间比较，原始 body 不重序列化，回调限制五分钟时效，nonce、provider event、txId 和充值地址均做持久幂等/唯一映射。服务只允许 HTTPS `*.udun.io` 专属节点，不接收请求参数提供的 URL。

成功回调只把订单推进 `MANUAL_REVIEW`。Operations maker 发起 `APPROVE_CREDIT`，不同 checker 批准后在同一 PostgreSQL 事务写入平衡账本、钱包版本、充值订单、审计和通知。失败整体回滚。优盾回调使用 `agentnovas_payment_webhook` 独立数据库角色；Client 只读取无密钥安全视图。

## 配置与失败语义

API Key、商户号、专属节点和回调地址来自运行时 secret/env，不进入数据库投影、浏览器、日志或 Git。币种映射可在 Maintenance 停用状态下配置，修改后必须重新测试。任何配置缺失、测试未通过或 provider 未启用均返回 503/409，不生成静态地址、二维码或假成功。

## 后果

该决定改变原“客户充值关闭”的产品边界，但不改变客户交易所密钥、真实交易、提现和自动支付的硬关闭边界。生产启用仍需要目标商户真实参数、数据库迁移/角色、外网回调、TLS 和 staging 小额验证证据。
