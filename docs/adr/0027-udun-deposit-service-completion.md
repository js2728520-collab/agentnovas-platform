# ADR-0027：优盾充值服务完整配置与安全启用

状态：Accepted
日期：2026-08-29
替代范围：ADR-0015 中“商户配置只能来自部署时环境变量”和“回调只接收 JSON 外层信封”两项实现决定；deposit-only、人工双审入账和所有资金出站硬关闭决定继续有效。

## 背景

现有优盾充值基础已经包含签名、地址创建、回调幂等和 Operations 双人入账，但仍不能形成可运营闭环：Maintenance 只能看到配置存在状态，不能安全安装或轮换商户配置；连通测试没有验证目标币种；公网回调被 Nginx 返回 404；Client 网络选项硬编码；并发创建在地址生成后才写订单，可能留下没有订单映射的 Provider 地址。

优盾当前官方文档要求请求与回调信封包含 `timestamp`、`nonce`、`sign` 和原始 `body`，签名为小写 MD5 `body + key + nonce + timestamp`。官方调试工具明确使用 `application/x-www-form-urlencoded`；不同语言版本的地址创建示例分别出现 `mainCoinType` 与 `coinType`。协议差异必须成为显式版本配置，不能用失败后自动重试掩盖，否则可能重复创建充值地址。

## 决策

1. 优盾只接入 USDT/TRC20 充值地址创建、支持币种查询和充值回调。提现、代付、划转、自动扣款、自动退款、自动入账及 QR 生成继续不实现。
2. 新增独立 Payment Secret Broker。Maintenance 浏览器使用 AES-256-GCM 加密完整配置，再以 Broker RSA-OAEP/SHA-256 公钥包装数据密钥；浏览器、PostgreSQL、审计和日志只能接触密文信封或安全投影。只有消费受管文件的 Client/Maintenance 服务端进程可在内存中读取调用所需明文，且不得输出到响应或日志。
3. Broker 使用独立进程、私钥、数据库角色和受管目录，原子写入 Client 与 Maintenance 消费文件及 manifest。它不能读取 Email Broker、交易凭证或通用应用密钥。消费者只接受同一 manifest 版本的完整文件；manifest 存在后禁止回退旧环境变量。
4. 可写配置固定为：HTTPS 优盾专属网关、数字商户号、API Key、精确回调 URL 和地址请求字段版本 `mainCoinType | coinType`。页面永不回显值，只显示已配置、版本指纹、更新时间、操作者和请求结果。
5. 回调只开放精确路径 `/api/integrations/payments/udun/webhook`。应用同时接受官方 form-urlencoded 与兼容 JSON 信封，保留原始 `body` 字符串验签；拒绝重复字段、额外字段、超限体积、错误 Content-Type、过期时间戳和重复 nonce/event。
6. 连通测试必须同时证明签名接口可用且已配置的主币/代币组合存在于官方支持币种响应。回调测试必须通过受限 URL 规则探测目标 DNS、TLS、Nginx 和应用路由，不产生订单或资金事实。
7. 启用 Gate 必须全部满足：受管商户配置有效、Broker 心跳新鲜、币种映射完整、Provider 测试和回调测试均在 24 小时内通过、外发授权开启。配置或映射变更会使旧测试立即失效。服务端是 Gate 唯一真源，按钮禁用不是安全控制。
8. 创建充值订单先在数据库原子预留 `ADDRESS_PROVISIONING` 记录与“每用户/网络一个开放订单”约束，再调用 Provider。成功后条件更新地址并进入 `PENDING_CONFIRMATION`；明确失败进入 `ADDRESS_FAILED`；超时或结果不确定进入 `ADDRESS_UNKNOWN`，禁止自动重试，避免同一业务意图生成多个地址。
9. Client 只从安全 API 获取已启用网络，不硬编码展示不可用网络。进行中订单自动刷新，地址支持显式复制；未配置、测试过期、地址生成失败与待人工排查使用不同状态和文案。
10. Provider 成功回调继续只推进 `MANUAL_REVIEW`。Operations 不同人员双审后才在单一 PostgreSQL 事务写入账本、钱包、订单、审计和通知。
11. 自动化与普通部署不得向 Provider 创建真实地址或模拟成功回调。真实闭环只能在测试域名、由操作者明确安装测试商户配置并执行小额 USDT/TRC20 试投；不得修改生产配置。

## 失败与回滚

- Broker 不可用、公钥不匹配、密文无效、文件权限或 manifest 校验失败时，保留上一有效版本并失败关闭。
- Provider 请求在获得确定响应前中断时，订单进入 `ADDRESS_UNKNOWN`，不自动再次调用地址接口；维护人员只能查看安全错误码并创建新的人工处置记录。
- Provider 或回调测试失败/过期、配置版本变化、Nginx 未到达应用或币种响应不包含目标组合时，激活必须返回明确的 409 Gate 失败。
- 应用回滚时保留新表、新状态和受管配置；旧版本只能读取最终状态，不能删除配置请求、Provider 事件或审计事实。

## 后果

Maintenance 能完成配置、轮换、连通、回调探测和启停，但任何 Web 进程或数据库都拿不到商户密钥明文。Client 只展示真实可用网络和订单状态。系统仍然是受控充值通道，不是通用支付、托管或资金出站系统。
