# 策略工作记录与受控导出规格

状态：`CURRENT`。Client 历史列表/详情、Maintenance 脱敏导出和 T4.13c 最终三端浏览器总 Gate 均已完成；真实订单路由继续关闭。

## 1. 目标

工作记录把一轮策略判断从“大厅里的最新摘要”扩展成可长期追溯的产品记录：

- Client 查看自己订阅期间的历史决策轮；
- 详情同时展示公共七阶段判断和该客户组合独有的准入、模拟订单意图与成交回执；
- Maintenance 在独立权限和审计原因约束下导出脱敏安全投影；
- 决策、行情摘要、准入、意图和回执至少保留六个月。

工作记录只解释已经发生并持久化的事实，不生成新的 LLM 结论，不触发策略、订单、支付、通知或外部写入。

## 2. 决策轮与客户准入边界

沿用 ADR-0018：

- `strategy_decision_rounds` 和七阶段 `strategy_runtime_events` 是同策略卡、品种、周期和已收盘 K 线的公共判断，不含客户数据；
- `strategy_runtime_cycles` 是单个客户部署在该轮的组合准入事实；纯 `hold` 可以没有客户周期行；
- `official_paper_order_intents`、`official_paper_fill_receipts` 只属于具体客户的模拟组合；
- 页面必须同时说明“公共决策”和“你的组合准入”，不能让客户误解为每位客户独立运行七次 Agent，也不能让客户误解为所有客户仓位相同。

外部 `recordId` 使用共享决策轮 ID；过渡期没有共享轮的历史记录使用客户周期 ID。两类 ID 都是最多 128 字符的不可解释标识，调用方不得从格式推断类型。

## 3. 历史所有权

共享轮本身没有客户 ID，因此不能只凭 `recordId` 查询。新增不可变订阅期间 `strategy_subscription_periods`：

- 每次实际启动或重新启动平台策略时创建一段，固定客户、订阅、部署、策略代码、策略版本、品种、模式和开始时间；
- 停止或模式切换时关闭当前段；暂停不关闭；同一订阅最多一段未结束期间；
- 迁移从现有订阅、部署和映射回填，不虚构不存在的客户；
- Client 只有在 `round.candle_close_time` 落入自己的 `[startedAt, endedAt]` 期间时才能看到公共轮；
- 客户周期、意图和回执还必须通过同一期间固定的 `deploymentId` 与 `owner_user_id` 二次约束。

不存在、非法、其他客户或订阅期间之外的详情 ID 统一返回 404，避免资源枚举。

## 4. Client API

### 4.1 列表

`GET /api/work-records?limit=20&cursor=...`

- 权限：`client.paper.view`；
- `limit` 默认 20、最小 1、最大 50；
- 按 `occurredAt DESC, recordId DESC` 排序；游标为服务端编码的不透明位置；
- 返回 `{data, page:{limit,nextCursor}}`；
- 列表项只含记录 ID、策略名称/代码/固定版本、品种、周期、决策状态、完整性、执行模式、客户准入状态、是否有意图/成交、发生时间和公共轮标志；
- 不返回原始证据 JSON、模型名、错误原文、客户标识或数据库内部映射。

### 4.2 详情

`GET /api/work-records/:id`

返回：

- 公共事实：固定策略名称/版本、品种/周期、K 线开闭时间、决策状态、完整性、trace 审计标识；
- 行情摘要：来源名、数据起止、K 线数、数据集摘要和 allowlist 数据质量；不返回交易所账户 ID、完整规则或费用配置；
- 七阶段：角色、顺序、结论、allowlist 证据、是否使用 LLM、解释状态和公开解释；
- 客户事实：组合准入状态与 allowlist 风险摘要、模拟意图状态/动作/时机/请求价、模拟成交数量/价格/名义金额/费用/损益和时间；
- 只有公共结论为 `hold` 且没有客户周期时才标记“无需准入”；其他无客户周期的公共轮标记“未记录”，不得推断为无需准入或已经执行；
- 明确 `realOrderRoutingEnabled=false`。

所有响应 `cache-control: private, no-store, max-age=0`。查询参数和路径参数在边界验证，SQL 全部参数化。

## 5. Maintenance 脱敏导出

`POST /api/maintenance/work-records/export`

- 独立敏感权限 `maint.work_records.export`；MFA 全局开关关闭时不增加弹窗，正式重新开启后要求 recent MFA；
- same-origin、`Idempotency-Key`、最多 8 KiB 请求体；
- body 仅允许 `from`、`to`、`reason`；UTC 日期两端包含，最大 31 天，`reason` 为 3–500 字；
- 每次最多 1,000 条，超过时返回 `truncated=true`，不静默声称完整；
- 导出 JSON，响应设置 `content-disposition: attachment`、`no-store` 和 `x-export-retention: idempotency-record-only`；服务端不向文件系统或对象存储落导出文件，脱敏响应仅保存在不可变幂等终态记录中以支持安全重放；
- 相同 actor + Idempotency-Key + 请求摘要只返回相同结果并只写一条审计；键冲突返回 409；
- 审计只记录日期、条数、截断状态、查询摘要和原因，不记录导出正文。

Maintenance 数据库角色只能读取 `maintenance_strategy_work_records_safe` security-barrier 视图。安全投影使用稳定伪名用户，不包含原始用户 ID、邮箱、手机号、客户名称、交易所账户、原始 evidence/payload、模型名、错误原文、provider 标识或任何密钥。

## 6. 六个月最低保留

数据库迁移对以下工作记录真源增加删除保护：

- `strategy_subscription_periods`；
- `strategy_decision_rounds`；
- `strategy_runtime_events`；
- `strategy_runtime_cycles`；
- `market_data_snapshots`；
- `official_paper_order_intents`。

创建或完成时间不足六个月时拒绝 `DELETE`；`official_paper_fill_receipts` 和审计链已有更强的永久追加式保护。业务状态更新、解释完成和意图终态更新继续允许。任何后续清理器必须先证明记录超过六个月，并保持外键与审计链完整。

## 7. UI 与无障碍

- Client 主导航增加“工作记录”；列表和详情使用稳定 `/work-records` 路由；
- 加载、错误、空态和“加载更多”使用可感知状态，不依赖颜色；
- 详情按“公共决策 → 行情摘要 → 七阶段 → 你的组合准入 → 模拟意图/成交 → 审计边界”排序；
- 主要信息使用标题、定义列表和原生表格；可滚动区域可键盘访问；
- 320、768、1024、1440 像素和 axe-core 通过；页面无控制台错误或警告；
- 导出原因常驻页面，不使用二次确认弹窗。

## 8. 验收与安全滥用用例

1. 客户 A 的记录列表和详情永远不返回客户 B 的期间、准入、意图或成交；猜测 B 的 ID 得到与不存在相同的 404。
2. 纯 hold 公共轮存在于列表且详情显示“本轮无需客户准入记录”；不能因没有 cycle 行而消失。
3. 同一客户停止后、重新启动前的公共轮不可见；重新启动产生新期间，不改写旧期间。
4. 列表游标非法返回 422；连续分页无重复、无跳项，最大 50。
5. 所有公开 evidence 使用字段 allowlist 和长度上限；trace 仅为审计关联标识，不暴露请求体或错误原文。
6. Maintenance 无权限返回 403；跨 audience 返回 401/404；导出重放不重复审计，冲突键返回 409。
7. Maintenance Web 角色不能直接读取 Client 工作记录原表，只能读安全视图。
8. 对六个月内任何受保护真源执行删除均失败；超过六个月的清理仍必须按外键顺序且不得删除永久追加式回执/审计。
9. 三端 production build、三端空浏览器登录、Client 列表/详情、Maintenance 导出、四断点和 axe Gate 全部通过。

## 9. 明确不做

- 不启用真实订单、客户交易所连接、提现或划转；
- 不在工作记录中重新调用 LLM 或生成缺失历史；
- 不导出客户 PII、原始模型内容、错误原文或凭证；
- 不把共享决策轮描述成客户独享计算；
- 不把模拟意图、模拟成交或平台 Demo 结果描述成真实交易所成交。
