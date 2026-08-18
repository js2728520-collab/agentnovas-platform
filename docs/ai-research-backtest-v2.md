# AgentNovas 专业 AI 研究与回测闭环 V2 规格

状态：已批准实施

批准依据：用户于 2026-08-18 要求继承并优化 QuantDinger 的专业 AI 对话，以及策略生成后的保存、查看和回测能力。

实现分支：`codex/ai-assistant-strategy-dsl`

## 1. 假设与边界

1. “继承 QuantDinger”指继承业务能力与工作流，不复制其前端，也不在 AgentNovas 中执行 LLM 生成的任意 Python。
2. 继续使用 AgentNovas 已有的受限 JSON DSL、D1 租户模型、个人/系统 LLM 配置和草稿审核流程。
3. V2 只支持平台白名单中的 USDT 现货、`5m/15m/1h/4h/1d` 周期和最多 1,000 根历史 K 线。
4. 回测仍是研究工具，不会自动启用跟单、模拟盘或实盘。
5. 不新增数据库表；回测参数、交易明细和报告继续保存在现有 `strategy_validations.metrics_json` 中。

## 2. 目标

- **AI-V2-001**：AI 回答先给结论，再给可核验行情证据、失效条件和下一步，不输出泛化教材式清单。
- **AI-V2-002**：服务端识别市场分析、持仓风险、策略研究、回测帮助和一般咨询意图。
- **AI-V2-003**：对具体交易对的提问加载真实 K 线，并计算 EMA20、EMA60、RSI14、ATR14、区间支撑/阻力和数据时间。
- **AI-V2-004**：服务端从所属会话提取工作记忆，避免重复询问交易对、周期、风险目标等已提供字段。
- **BT-V2-001**：生成策略后可保存草稿、打开策略详情、选择回测预设并运行回测。
- **BT-V2-002**：回测支持“实盘对齐”和“探索研究”预设，以及受限的初始资金、手续费、滑点和 K 线数量。
- **BT-V2-003**：策略详情展示规则、版本、回测历史、核心指标和最近交易明细。
- **BT-V2-004**：所有策略和报告读取、保存与回测均按当前客户所有权隔离。

## 3. 技术栈与命令

- React 19.2.6、TypeScript 5.9.3、Vinext 1.0.0-beta.2、Vite 8.0.13。
- Drizzle ORM 0.45.2 + Cloudflare D1/SQLite。
- 测试：Node `node:test`。

```bash
npm run dev -- --hostname 127.0.0.1 --port 3000
node --test tests/ai-professional.test.mjs tests/backtest-options.test.mjs tests/strategy-backtest-ui.test.mjs
npx eslint app/strategy-backtest-detail.tsx app/community-strategy-center.tsx lib/ai-assistant.ts lib/ai-context.ts lib/ai-chat-protocol.ts lib/ai-research.ts lib/backtest-engine.ts
npm run build
```

## 4. 项目结构

- `lib/ai-chat-protocol.ts`：意图、工作记忆、回答契约与规则模式回复。
- `lib/ai-context.ts`：当前客户组合摘要和真实行情/K线技术快照。
- `lib/ai-assistant.ts`：模型系统提示词和安全输出边界。
- `lib/backtest-engine.ts`：受限 DSL 回测和参数规范化。
- `app/api/strategy-marketplace/*`：策略详情与回测 API。
- `app/community-strategy-center.tsx`：生成、保存、查看和回测 UI。
- `tests/`：纯逻辑、API 合同和 UI 合同测试。

## 5. 接口契约

### 5.1 AI 内部契约

```ts
type AssistantIntent =
  | "market_analysis"
  | "portfolio_risk"
  | "strategy_research"
  | "backtest_help"
  | "general";

type MarketResearchSnapshot = {
  symbol: string;
  timeframe: "1h";
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  ema20: number;
  ema60: number;
  rsi14: number;
  atr14: number;
  support: number;
  resistance: number;
  candleCount: number;
  latestCandleAt: string;
  source: string;
};
```

模型回答默认使用三段结构：`结论`、`关键证据与失效条件`、`下一步`。不强制 Markdown JSON，不允许模型声明已经交易。

### 5.2 策略详情

`GET /api/strategy-marketplace/:id`

- 仅作者可读取未发布策略详情。
- 返回 `{ strategy, versions, backtests }`。
- `backtests[].metrics` 为服务端解析后的对象，避免客户端解析任意 JSON 字符串。

### 5.3 回测执行

`POST /api/strategy-marketplace/:id/backtest`

请求：

```json
{
  "preset": "live_aligned",
  "initialEquityUsdt": 10000,
  "feeRate": 0.001,
  "slippageRate": 0.0005,
  "candleLimit": 1000
}
```

- `preset`：`live_aligned | exploration`。
- 实盘对齐默认手续费 `0.001`、滑点 `0.0005`；探索研究默认手续费 `0.001`、滑点 `0`。
- 明确字段覆盖预设默认值。
- 初始资金限制 `100–1,000,000 USDT`；手续费 `0–0.01`；滑点 `0–0.02`；K线 `200–1,000`。
- 返回现有 `{ reportId, result, message }`，保持向后兼容。

## 6. 代码风格

沿用项目现有的小型纯函数和显式边界校验。`normalizeBacktestOptions` 对未知预设、非数字和越界字段直接拒绝，不做字符串数字转换或静默钳制。

- 不使用 `eval`、动态导入或任意策略代码。
- 不把 API Key、邮箱、其他租户数据或完整数据库记录放入提示词。
- 模型输出只作为文本或经 DSL 校验的候选规则。

## 7. 测试策略

- 小型测试：意图分类、技术指标、工作记忆、回测参数边界。
- 中型合同测试：详情/回测路由同时包含身份和所有权条件；回测报告绑定策略版本。
- UI 合同：存在“查看策略”、回测预设、报告和交易明细入口。
- 浏览器验证：客户完成“生成/已有策略 → 查看 → 回测”流程，控制台零错误。
- 构建与安全：生产构建、定向 ESLint、`npm audit --omit=dev`、Git 密钥检查。

## 8. 安全威胁与控制

| 威胁 | 控制 |
| --- | --- |
| 跨租户读取策略/报告 | 详情和回测查询同时使用策略 ID 与当前作者 ID。 |
| LLM 编造行情 | 只传服务端真实 K 线摘要；缺失时明确不可用。 |
| Prompt 注入要求交易 | 系统提示无交易工具；DSL 生成与订单路由物理分离。 |
| 回测资源滥用 | K线、参数、输入长度和请求配额均设上限。 |
| 回测参数制造不现实结果 | 默认实盘对齐；探索预设明确标注；报告永久记录实际参数。 |
| 任意代码执行 | 继续使用白名单 DSL 解释器，拒绝 Python/JS/SQL/Shell。 |

## 9. 非目标

- 复制 QuantDinger 的 Python Strategy API V2、代码沙箱、参数寻优和实盘执行器。
- 多资产组合、期货、杠杆、做空和自动交易。
- 新闻搜索、长期向量记忆、图片识别或可写工具调用。

## 10. 验收标准

- 用户询问 BTC 行情时，AI 上下文包含真实 K 线时间、EMA/RSI/ATR、支撑和阻力。
- 相同会话已提供交易对/周期后，AI 不再重复询问。
- 规则模式与模型模式都按结论优先结构回答，且保留安全声明。
- 已生成策略可以保存并在“我的策略”打开详情。
- 详情能运行两种预设回测，并展示保存的参数、指标、警告和最近交易。
- 非作者无法读取详情或触发回测。
- 定向测试、生产构建和浏览器验收通过。
