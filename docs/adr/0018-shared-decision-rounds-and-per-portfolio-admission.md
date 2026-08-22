# ADR-0018: 决策轮共享化，准入按组合分离

状态：Proposed

日期：2026-08-22

## 背景

官方现货的运行粒度是「每个 (客户, 策略卡) 一个部署」：`strategy_deployments`
带 `owner_user_id` 与 `paper_portfolio_id`，每个部署独立跑决策周期。

按目标规模（500–5000 会员）实测推算：

| 项 | 数量 |
| --- | --- |
| 部署数（5,000 会员 × 3 张卡） | **15,000** |
| 三张卡合计的不同 (品种, 周期) 组合 | **6** |
| 每根 K 线的决策周期数 | 15,000 |
| 其中不同的判断 | 6 |

也就是说同一份判断被重复计算 2,500 次。每一次重复都带着：

- **一次外部行情请求**——已在 §41 用进程内复用缓存收敛（6 次），这部分已解决；
- **一行 `strategy_runtime_cycles` + 7 行 `strategy_runtime_events`**；
- **最多 2 个 `strategy_runtime_explanation_jobs`**，每个都是一次真实 LLM 调用。

最后一项是最贵的：解释任务按 `cycle_id` 建（`lib/strategy-runtime-repository.ts`），
触发条件是「动作不是 hold，或风控拒绝」。一旦某张卡产生信号，
**15,000 个周期会各自发起解释，把同一段解释生成上万次**。这不是性能问题，
是直接的 AI 成本问题。

### 与文档的不一致

根 `CLAUDE.md` 的术语表写的是：

> **决策轮 decision round**：七阶段一次完整执行……
> 每张策略卡一轮，扇出到所有订阅该卡的客户组合——不是每个客户一轮。

实现是「每个客户一轮」。文档写的是目标形态，代码是另一种。本 ADR 让两者一致。

## 决策

**把「决策」与「准入」分开：决策共享，准入按组合。**

### 什么可以共享

同一张卡、同一品种、同一根已收盘 K 线上，以下内容对所有订阅者完全相同，
因此只算一次：

- 行情与数据质量（阶段 1）
- 技术信号（阶段 2）
- 策略方案（阶段 3）
- 反方审查（阶段 4）
- 卡级风控阈值判定（阶段 5 的一半）
- 最终决策叙述（阶段 6）
- 三类 LLM 解释

共享单元的身份是 **(strategy_code, symbol, timeframe, candle_close_time)**。
这同时满足 INV-8 的幂等要求：相同 card/candle/contract 的重试落在同一行。

### 什么必须按组合

以下逐个客户不同，不能共享：

- 组合权益、回撤、当日亏损、连续亏损（`refreshOfficialPaperRiskState`）
- 熔断状态与访问状态（`resolveOfficialPaperRuntimeAccess`：active / close_only / read_only）
- 当前持仓
- 下单量换算与仓位上限
- 成交回执、账本分录、绩效结算依据

因此**阶段 5 有两半**：卡级阈值判定共享，组合级准入逐个执行。

这正好落在 P1 已经建好的执行缝上：域层产出一条 `OrderIntent`（带
`targetPositionRatio`，不带绝对数量），`resolveOrderQuantity` 在扇出时按各组合的
可用资金与 `capitalCapRatio` 取更严格者换算。**域层不需要改。**

### 数据模型

新增 `strategy_decision_rounds`（共享）：

```
id                    text PRIMARY KEY
strategy_code         text
symbol                text
timeframe             text
candle_open_time      timestamptz
candle_close_time     timestamptz
market_data_snapshot_id text
decision_json         jsonb   -- 卡级结论：action / reason / 卡级 rejectionReasons
order_intent_json     jsonb   -- 目标仓位比例，不含数量
trace_id              text
UNIQUE (strategy_code, symbol, timeframe, candle_close_time)
```

`strategy_runtime_events` 与 `strategy_runtime_explanation_jobs` 的外键从
`cycle_id` 改为 `decision_round_id`——七阶段叙述与解释都属于共享单元。

`strategy_runtime_cycles` 保留，含义变为**该部署在该决策轮上的准入结果**：
增加 `decision_round_id` 外键，`decision_json` 只存组合级的准入结论
（是否放行、组合级拒绝理由）。

`official_paper_order_intents` 不变——它本来就同时带 `portfolio_id` 与
`runtime_cycle_id`，形状已经是扇出的。

### 只在有事发生时写准入行

多数 K 线的结论是 hold。若为每个部署都写一行准入结果，15m 周期下每天约
144 万行，需要分区维护。

**准入行只在下列情况写入**：产生订单意图、组合级风控拒绝、或访问状态导致降级。
纯 hold 的组合不写行——客户视图从共享决策轮读到「本轮无动作」即可，
这不是信息缺失：卡级结论就是本轮不动作。

### 调度

`leaseNextStrategyDeployment` 改为 `leaseNextDecisionTarget`，租约单元从部署变为
**(strategy_code, symbol, timeframe)**。worker 一轮的动作是：

1. 租下一个决策目标，判断是否有新的已收盘 K 线；
2. 取行情（已有复用缓存）→ 跑引擎 → 写共享决策轮与七阶段事件；
3. 按批扇出到订阅该卡的组合：逐个刷新风控状态、判定准入、写意图；
4. 完成租约。

第 3 步是唯一与订阅规模成正比的部分，且它是数据库批处理，不是外部调用。
真实交易 GA 后这一步会变成 N 次交易所 API 调用，届时需要限流池与部分失败对账
（见 CLAUDE.md「目标形态」），本 ADR 先把结构摆正。

## 结果

### 收益

| 项 | 现在 | 之后 |
| --- | --- | --- |
| 每根 K 线的引擎评估 | 15,000 | 6 |
| 七阶段事件行 | 105,000 | 42 |
| LLM 解释调用（信号触发时） | 最多 30,000 | 最多 12 |
| 租约/心跳/完成事务 | 15,000 | 6 |
| 准入行 | 15,000 | 仅有动作的组合 |

### 代价与风险

- **INV-8 的决策轮身份变了。** 幂等键从 `runtime:{deploymentId}:{candleClose}`
  变为 `round:{strategyCode}:{symbol}:{timeframe}:{candleClose}`。
  `deterministicCycleId` 与其断言需同步修改。
- **`/api/trading-hall` 的读取路径要改。** 现在按部署取最新 cycle；之后要取共享
  决策轮 + 该客户的准入结果。客户看到的七阶段内容会与其他客户完全相同——
  这是正确的（同一张卡本来就是同一个判断），但需要产品确认措辞不误导为「为你单独运行」。
- **历史数据。** 已有 `strategy_runtime_cycles` 是按部署的。建议不回填：新表从启用
  之日起写入，旧数据保持原样可读。绩效结算依据是 `official_paper_fill_receipts`，
  不依赖 cycle 结构，**不受影响**。
- **`strategy_runtime_cycles` 不在审计哈希链里**（迁移 0044 只覆盖 `audit_logs`
  与 8 张 `*_decisions` 表），因此这次改动不触碰防篡改边界。

### 需要产品决定的两点

1. **客户视图措辞。** 七阶段内容对同卡客户完全相同。是明说「本卡的公共决策轮」，
   还是保持现有措辞？前者更诚实，也符合「可解释、可审计」的定位。
2. **纯 hold 是否留痕。** 本 ADR 提议不为 hold 写准入行。若合规上要求「每个客户
   每根 K 线都有一条可查记录」，则需要写，代价是每天百万行级别与分区维护。

## 实施顺序

1. 新增 `strategy_decision_rounds` 表与写入路径，与现有 cycle 并行写（双写，不改读）；
2. 迁移 `strategy_runtime_events` 与解释任务的外键到决策轮；
3. 改调度：租约单元换成决策目标，扇出写准入行；
4. 改 `/api/trading-hall` 读取路径；
5. 停止写旧的 per-deployment cycle 的共享字段，只保留准入语义。

每一步都可独立验证并回滚；第 3 步之前系统行为不变。
