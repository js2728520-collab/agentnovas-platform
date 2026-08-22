# ADR-0009: 客户 paper 与平台交易所 Demo 证据分离

状态：Accepted  
日期：2026-08-20

## 决策

每位有效会员、每张官方策略建立独立 10,000 USDT paper 组合。平台可使用自有 OKX Demo、Binance Spot Testnet、Bybit Demo 账户验证相同策略意图，但 `paper trade`、`demo intent`、`demo receipt` 使用不同表、状态和 UI 区域。Demo 成败永不改变客户 paper 成交、余额、收益或结算。

## 安全约束

- 客户不上传交易所密钥；Client 浏览器不接触平台密钥。
- provider allowlist 排除生产、提现、划转、杠杆与衍生品 endpoint。
- 确定性 clientOrderId、单笔 10 USDT、provider 日 100 USDT 与 kill switch 默认生效。
- 未配置或 fixture 不能显示 connected/sent/filled。

## 结果

用户说明书中的客户本地真实执行保留为未来愿景；如需启用，必须新建 PRD/ADR、合规、安全与 go-live 审批。

