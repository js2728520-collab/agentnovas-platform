# AgentNovas 多 Agent 策略研发与验证系统 V5

状态：已批准实施

批准依据：用户于 2026-08-18 明确要求按《多 Agent 策略研发与验证系统》计划实施。

实现分支：`codex/multi-agent-strategy-research`

## 1. 目标与不可违背的边界

- 系统生成、验证和解释受限策略 DSL；不承诺未来收益，不开放真实永续订单路由。
- LLM 只负责 Brief、市场分段、独立提案、反方审查、风险解释和报告；状态机、行情标准化、DSL 校验、参数搜索、回测、评分和准入由确定性代码完成。
- 找不到合格策略时结论必须是 `NOT_QUALIFIED`，不得用文案或分数掩盖失败。
- 不保存或展示隐藏推理过程，只保存结构化结论、引用、异议、修订建议和淘汰原因。
- 新流程由 `STRATEGY_RESEARCH_ENABLED` 功能开关控制，默认关闭；旧单 Agent 接口暂时保留。

## 2. 威胁模型

| 边界/资产 | 主要威胁 | 控制 |
| --- | --- | --- |
| 客户输入与 LLM 输出 | Prompt 注入、任意代码、超大请求 | 长度上限、严格 JSON 合同、DSL 白名单、无工具执行权限 |
| 模型 Profile | Key 泄漏、客户越权修改 | 平台管理员授权、AES-GCM 加密、只返回掩码、日志清洗 |
| 研发任务 | 跨租户读取、重复扣费、无限重试 | 所有权条件、幂等键、租约、模式预算、重试/超时上限 |
| 交易所接口 | 伪造/异常响应、分页缺失、费率遗漏 | 官方端点、响应形状校验、去重与断层检测、保守费率回退 |
| 回测与优化 | 未来数据泄漏、过拟合、结果美化 | 下一根开盘成交、留出集只运行一次、固定准入线、失败原因持久化 |
| 策略保存/广场 | 未验证策略进入实盘或发布 | 永久验证标签、模拟限制、标准验证门槛、双人审核且作者不可审核 |

## 3. 运行模式

| 模式 | 候选 | 回测预算 | 数据与切分 | 审查 | 权限 |
| --- | ---: | ---: | --- | --- | --- |
| `quick` | 3 | 12 | ≥2,000 根，70/30 | 1 次 | 探索级、仅模拟 |
| `standard` | 6 | 60 | 5,000–10,000 根，60/20/20 | 3 次走查、2 轮修订、双倍成本 | 可获得已验证资格 |
| `deep` | 10 | 200 | 10,000–30,000 根或全部 | 5 次走查、状态分段、±10% 敏感性、重采样 | 同准入线、更高置信度 |

## 4. 状态机与恢复

任务状态：`queued → requirements → data_loading → regime_analysis → proposing → validating → optimizing → adversarial_review → risk_review → ranking → reporting → completed`。

任意阶段还可进入：

- `paused_missing_role`：关键角色没有启用的模型绑定；配置完成后可恢复。
- `retry_wait`：可重试的模型/交易所错误，记录下次执行时间。
- `cancelled`：用户取消且 Worker 已确认停止。
- `failed`：预算耗尽、不可恢复错误或数据不足。

Worker 使用 PostgreSQL 行租约与 `FOR UPDATE SKIP LOCKED` 领取任务。领取、阶段提交和公开事件序号更新必须在事务内完成；租约过期后允许其他 Worker 恢复。每个阶段应幂等，完成标记先于下一阶段领取。

## 5. Agent 角色合同

角色固定为：

- `requirements`：把对话和表单转为 `StrategyBrief`，只提出会改变结果的缺失项。
- `market_regime`：输出带时间边界和数据引用的趋势/震荡/高波动/极端下跌分段。
- `proposal_a`、`proposal_b`：隔离上下文，输出不同策略家族的 DSL V2 候选。
- `adversarial_review`：输出数据泄漏、样本、敏感性、频率和修订意见。
- `risk_review`：输出风险否决意见和适用边界；不能绕过确定性门槛。
- `report`：只根据持久化结果生成交付摘要，不重新计算指标。

每个角色必须绑定启用的 `llm_profile`。客户响应仅包含 `role` 与 `modelName`，不包含供应商、地址或 Key。

## 6. DSL V2 合同

```ts
type StrategyDslV2 = {
  schemaVersion: 2;
  market: "usdt_perpetual";
  marginMode: "isolated";
  leverage: 1;
  symbol: string;
  timeframe: "5m" | "15m" | "1h" | "4h" | "1d";
  direction: "long_only" | "short_only" | "both";
  legs: {
    long?: StrategyLeg;
    short?: StrategyLeg;
  };
  risk: {
    positionSizePct: number;
    maxDrawdownPct: number;
    maxDailyLossPct: number;
    maxConsecutiveLosses: number;
  };
};

type StrategyLeg = {
  entry: { all: StrategyRule[] };
  exit: { any: StrategyRule[] };
  stopLossPct: number;
  takeProfitPct: number;
};
```

白名单指标为 EMA、RSI、通道突破、成交量比例、ADX、布林带和 ATR 百分比波动过滤。未知字段、任意脚本、超出参数范围、`both` 缺少任一腿、非 USDT 永续/逐仓/1x 均拒绝。V1 只在运行时映射到 V2 `long_only`，不批量改写旧记录。每个 `StrategyLeg` 独立定义入场、退出、止损和止盈。

## 7. 回测与准入合同

- 当前 K 线收盘确认信号，下一根 K 线开盘成交。
- 止盈止损使用 K 线高低价，同根同时触发按止损优先。
- 同一交易对同一时刻最多一个净头寸，不允许对冲。
- 计入开平手续费、滑点、按方向结算的历史资金费率和逐仓维持保证金；模拟爆仓立即失败。
- 未完成 K 线不入库；重复时间去重；资金费率缺口、K 线断层和估算费率进入数据质量结果。
- 训练集用于参数搜索，验证集用于排名，最终留出集只运行一次且其结果不得返回优化器。

`standard`/`deep` 自动通过必须同时满足：最终样本外净收益 > 0、至少 2/3 走查为正、样本外盈亏因子 ≥ 1.1、完成交易 ≥ 20、最大回撤不超过 Brief 上限、无模拟爆仓，并且极端行情未突破单日损失/连续亏损熔断。

## 8. REST 与 SSE 合同

所有错误统一为：

```json
{"error":{"code":"VALIDATION_ERROR","message":"请求参数无效","details":{}}}
```

### 创建任务

`POST /api/strategy-research/runs`

- Header：`Idempotency-Key` 必填，8–128 字符。
- Body：`conversationId`、`exchangeAccountId`、`mode`、`brief`。
- 成功：`202 { "runId": "...", "status": "queued" }`；相同用户+幂等键返回同一任务。

### 查询任务

`GET /api/strategy-research/runs/:id`

只返回当前用户任务，包含阶段、进度、公开事件、候选、验证摘要、数据质量和最终结论。

### 事件流

`GET /api/strategy-research/runs/:id/events?afterSequence=N`

SSE 事件携带单调递增 `id`；重连从 `afterSequence` 继续。服务端每 15 秒发 heartbeat，并在不支持流式响应时允许客户端轮询详情接口。

### 取消与保存

- `POST /api/strategy-research/runs/:id/cancel`：终态重复调用返回当前终态。
- `POST /api/strategy-research/runs/:id/candidates/:candidateId/save`：同一用户+候选只创建一个策略；重复请求返回原策略。

## 9. 数据与部署

- 生产目标：Linux + Node Web + PostgreSQL 16+ + 独立 Worker；不使用 Redis。
- 新表：`llm_profiles`、`agent_role_bindings`、`strategy_research_runs`、`strategy_agent_events`、`strategy_candidates`、`strategy_evaluations`、`market_candles`、`funding_rates`。
- D1 迁移先全量导出，再在 PostgreSQL 事务中导入；记录每表行数和按主键排序的关键字段 SHA-256。任一核对失败整批回滚；迁移批次号确保重复执行安全。
- 切换仅在维护窗口完成，不做长期双写。回滚保留 D1 只读快照和前一版应用制品。

## 10. 验收标准

- 关键角色缺失时任务显示暂停，而不是返回模板策略。
- Proposer A/B 隔离，系统同时加入确定性基准；Top 3 有完整淘汰/失败原因。
- 快速/失败候选保存后永久为模拟限制；只有标准/深度通过版本可申请后续实盘资格和进入广场审核。
- Worker 崩溃、租约过期、取消、重复创建和模型超时均可恢复且不重复写入结果。
- V1/V2、双向盈亏、资金费率方向、下一开盘、同 K 冲突和爆仓规则有自动化测试。
- 三家交易所分页、倒序、重复、费率缺失和资金费率断层有合同测试。
- 完成定向/全量测试、构建、ESLint、安全审计和真实浏览器验收。
