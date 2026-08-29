# Phase 9 运营与事故演练 Runbook

> 适用状态：`CURRENT_BASELINE`。本手册只允许在隔离 preview 或经过发布负责人明确授权的 staging 使用；它不授权生产变更、真实 provider 调用、真实资金动作、真实通知、Git 推送或能力开放。

## 1. 目的与完成标准

T9.5 必须由真实人员完成客服、风控、财务、综合事故、provider 故障和密钥泄露六场桌面/preview 演练。自动测试只能证明技术控制存在，不能替代人员分工、响应时长、沟通、停止/恢复决定和主持人签字。

一轮演练只有同时满足以下条件才算通过：

1. 六场均在同一发布候选上执行，记录 UTC 起止时间、参与人、注入、动作、requestId/traceId、安全审计引用和结果。
2. 首次确认不超过 5 分钟，停止或隔离决定不超过 10 分钟，15 分钟内形成第一版影响范围；任何未达标项必须有负责人和复测日期。
3. 不记录 secret、数据库连接串、完整 provider endpoint、Webhook body、客户明文 PII、Cookie、Authorization 或 recovery code。
4. 所有副作用保持 synthetic/preview；不得把“技术 fixture 通过”写成真实人员演练通过。
5. 恢复必须由与执行者不同的授权人员确认。Finance maker/checker 必须是不同人员；演练主持人不能代替两者签字。

## 2. 角色与准备

每轮至少指定：Exercise Director、Incident Commander、记录员，以及客服、风控、财务 maker、财务 checker、Maintenance/Security 负责人。除 maker/checker 必须分离外，小团队可以兼任，但记录中必须写清每个角色。

开始前：

- 固定 release tag、commit、artifact/source hash、preview 三域和证据目录。
- 确认真实邮件、支付、Demo、Runtime、Research 和其他 provider 外部写入关闭；只使用合成客户、订单、requestId 和 canary secret ID。
- 确认 `current`/`previous`、数据库备份、三端健康、审计查询与沟通频道可用。
- 记录演练开始时的容器 image ID、migration 数、外部写入开关和健康摘要。
- 任何参与者可喊停；出现绝对否决项时立即停止整轮，不继续“为了跑完脚本”。

## 3. 六场演练

### D1 客服：客户称付款成功但权益未开通

注入：合成客户提供订单号和 requestId，声称已付款，并要求客服直接改成 paid。

必须完成：客服只收集最小必要信息；不索取截图 base64、PAN、私钥或完整账户；区分外部付款证据、平台订单状态与权益状态；创建安全升级记录；在未完成 maker/checker 前不承诺收款成功或手改会员。

通过：5 分钟内确认，15 分钟内把订单、证据、账本和权益四个状态分开说明；记录中无明文 PII/secret，未产生虚假成功。

### D2 风控：provider 拒单激增且出现重复 clientOrderId 告警

注入：合成监控同时报告拒单激增和一个重复 clientOrderId；当前真实外部写入仍关闭。

必须完成：风控宣布停止新开仓；Maintenance 先说明全局/provider/card kill 的选择，再在 fixture 或 preview 安全控制面执行；保留队列和未知回执；确认平仓不被开仓熔断错误阻止；解除必须发起申请并由另一人员批准。

通过：10 分钟内形成停控决定；不重放未知订单，不删除对账记录；解除前完成 fixture 回归与不同人员批准。

### D3 财务：重复付款 reference 与 maker 自审

注入：同一脱敏付款 reference 被用于第二张订单，同时原 maker 尝试批准自己的 credits/会员调整。

必须完成：拒绝重复 reference 与自审；保持订单、账本、余额版本、高水位和审计原状；checker 独立核对；如需修正只创建 reversal/adjustment，不覆盖历史。

通过：重复和自审均失败关闭；没有第二次扣款/入账/权益；记录 exactly-once 证据与不同 maker/checker 身份。

### D4 综合事故：跨 audience 读取或响应中出现 secret/完整 PII

注入：观察员给出合成 404/401 异常和一段带 canary 标识、但不含真实秘密的响应摘要。

必须完成：Incident Commander 按 SEV0 宣布停止新邀请及对应队列；隔离入口/会话，保存最小 requestId/traceId/版本/时间；Security 判断是否需扩大到全局停控；客服准备不含推测的客户沟通；禁止把 canary/响应正文复制进工单。

通过：10 分钟内完成分级与停止决定；15 分钟内列出可能受影响 audience/scope/时间窗；证据无敏感正文，恢复有独立批准。

### D5 provider 故障：充值建址超时与回调乱序/重放

注入：合成优盾建址超时，随后给出旧时间戳和重复 event ID 的签名 fixture；不得访问真实商户端点。

必须完成：保持 provider disabled 或立即停用；不生成静态地址，不把未知结果当失败后重试建址，不把已验签回调当已入账；核对 event/order/ledger/balance 四层，不手工改 CREDITED。

通过：没有新真实地址、回调推进、账本分录或余额变化；重放/乱序失败关闭；恢复计划要求重新测试、内部小额 staging 和 maker/checker。

### D6 密钥泄露：合成 canary secret ID 出现在非授权位置

注入：只使用形如 `CANARY-T9-<random-id>` 的标识，不能使用可工作的 token 或真实值。

必须完成：Security 判断 secret 类型、消费者和撤销范围；先 disable/kill，再建立新版本、验证最小权限、切换引用并撤销旧版本；检查日志、证据、工单和 Git；KEK 场景必须说明数据 rekey/客户凭证轮换，不能只重启服务。

通过：10 分钟内停控，旧 canary 被标记撤销且不能恢复使用；任何记录只保留 secret ID/hash 后缀；恢复有独立批准和复测证据。

## 4. 统一记录模板

每场记录以下字段：

| 字段 | 内容 |
| --- | --- |
| 场次/候选 | D1–D6；release/commit/artifact |
| 人员 | director、commander、recorder、业务与审批角色 |
| 时间线 | inject、ack、contain、impact、recover、close（UTC） |
| 安全证据 | requestId/traceId/audit ID/hash 后缀；不得粘贴正文秘密 |
| 决策 | 分级、停止范围、客户影响、恢复条件 |
| 技术结果 | fixture/test、preview 健康、数据副作用计数 |
| 偏差 | 未达 SLA、误操作、手册缺口、owner、截止日 |
| 结论 | PASS/FAIL/ABORTED；director 与 recorder 签字 |

## 5. 整轮停止与恢复

任一绝对否决项、真实外部调用、真实资金/通知副作用、未知订单被错误归类、证据含 secret/PII、maker/checker 未分离、审计无法查询或 preview/production 边界不清晰，都必须标记 `ABORTED` 并停止。

整轮恢复前必须确认：外部写入仍关闭、被注入的 synthetic 状态已清理、审计保留、三端健康、数据库/角色未漂移、所有偏差有 owner。T9.5 只有六场真实人员记录全部 PASS 后才能勾选；否则保持未完成并把缺口带入发布停止条件。
