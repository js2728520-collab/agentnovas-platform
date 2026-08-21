# Riverton Capital 付费 Beta 运营 Runbook

## 1. 使用范围

供 Operations maker/checker 处理邀请、会员付款凭证、credits 调整、paper 周分成和争议。所有真实资金动作均发生在外部人工渠道；系统只记录凭证、权益、应收和审计。

## 2. 邀请与一次性设置密码

1. maker 核对客户邮箱、服务地区和邀请批次，确认未超过 Beta 席位。
2. 创建邀请后只记录 invitation ID/状态/过期时间；不得复制、发送或保存临时密码。
3. 客户通过一次性链接设置密码，完成邮箱验证并确认当前商业披露 bundle；确认成功后才启动试用。
4. 链接过期时作废旧邀请后新建；不要手工替客户设置密码。
5. 冻结、密码重置或撤权后核对相关 session 已撤销。

异常：如果接口响应含明文密码/token，立即停止邀请、保存 requestId、按事故流程升级，不得通过聊天转发内容。

## 3. 会员付款复核

Maker：

1. 打开订单详情，核对订单号、客户、plan snapshot、USD 金额/币种和状态。
2. 从批准的外部收款渠道核对记录，录入脱敏 reference、付款时间、金额、币种和原因。
3. 不上传银行卡/PAN、完整账户、私钥、截图 base64 或不必要 PII。
4. 提交后记录 requestId；maker 不尝试审批。

Checker：

1. 独立回到外部渠道核对，不只依据 maker 文字。
2. 检查金额/币种/订单版本/重复 reference；批准或拒绝并填写理由。
3. 批准后确认结果为 activated/renewed、credits grant 和 ledger/audit 引用；“审批已记录”不表示平台自动收款。
4. 重复点击/409 时刷新详情，禁止创建第二张订单规避冲突。

## 4. Credits 调整

- 仅纠正已证明的 entitlement/usage/运营错误；reason 引用 ticket/evidence hash。
- maker 提交方向与数量，不得让结果余额为负；different checker 复核。
- AI usage 只有 provider 可靠 token usage 才能 settle；不得手工伪造 usage 让请求通过。
- 复核后比对 account version、ledger entry、commercial ledger/audit，确认 exactly once。

## 5. 周 paper 盈利分成

生成：仅在 UTC 周一后生成上一完整周；选择产品认可的三张官方策略 ID。若有已审批未支付账单，先处理旧账单。

业务复核：核对三卡已平仓 paper realized net PnL、模拟手续费、累计 PnL、高水位、亏损结转、plan fee snapshot 和应收。批准只生成 receivable，不标 paid、不更新高水位。

付款复核：另一 maker 记录外部付款凭证，different checker 复核。只有最终结果为 paid 时核对新高水位提交。禁止自动扣钱包或暂停会员。

## 6. 争议处理

1. 将 statement 标记 dispute/hold，不修改原始计算、paper trades 或高水位。
2. 导出安全证据：周期、策略 IDs、closed trades、费用、合同 hash、计算版本、审批 requestIds；脱敏其他客户。
3. 产品与运营按客户确认的计划/披露快照共同判断；任何修正创建新决定/reversal/adjustment，不覆盖原记录。
4. 争议期间阻断重叠账单，会员处置遵循版本化产品合同。

## 7. 到期与停止服务

- 到期前通过 in-app/Email 提醒；Email 未授权时只发 in-app。
- 到期后核对新开仓被阻断；有持仓组合为 close_only、无持仓组合为 read_only。Beta 不自动退款，任何人工调整使用版本化合同、双审和 reversal/adjustment。
- 不用手工数据库更新延长期限；续期必须走会员订单双审。

## 8. 运营事故

重复权益/credits/高水位、跨客户数据、PII/secret、临时密码、假支付状态任一出现：立即停止对应 maker/checker 队列，保留 requestId/traceId/版本与时间，通知 Maintenance 和 incident commander，使用 reversal/补偿流程，不直接改账本或删除审计。
