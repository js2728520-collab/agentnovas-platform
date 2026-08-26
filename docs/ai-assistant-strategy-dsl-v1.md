# AgentNovas AI 对话与策略 DSL V1 规格

> 文档状态：`FOUNDATION`。受限 DSL 和确定性校验继续用于 V3；P-04 已确认不做 QuantDinger 移植参考，固定 Credits、策略市场和实盘确认以 PRD V3 与 `specs/V3_CLIENT_APP_TARGET_SPEC.md` 为准。

状态：已批准实施

批准依据：用户于 2026-08-16 确认“按照建议进行代码实现”

实现分支：`codex/ai-assistant-strategy-dsl`

## 1. 目标

- **AI-001**：客户可以创建、切换并继续自己的 AI 对话，刷新页面后历史仍然存在。
- **AI-002**：服务端只使用当前登录客户自己的历史、持仓摘要和跟随策略摘要构建上下文；客户端不得提交或覆盖完整历史。
- **AI-003**：AI 可以把用户意图生成为受限、可校验、可解释的 JSON 策略 DSL。
- **AI-004**：历史回测必须执行 DSL 中的规则，不得继续用与用户输入无关的固定策略代替。
- **AI-005**：对话和生成接口必须具备身份校验、资源所有权检查、输入上限、敏感信息拦截、限流和审计记录。
- **AI-006**：AI 输出只能创建研究草稿，不得直接下单、启用跟单、开启实盘或修改资金权限。

## 2. V1 范围

### 2.1 对话

- 仅 `customer` 角色可以使用。
- 支持新建对话、对话列表、读取消息、发送消息和归档对话。
- 对话与消息永久保存在 PostgreSQL；所有查询同时包含 `user_id` 所有权条件。
- 单条用户消息最多 2,000 个字符；标题最多 80 个字符。
- 每个客户每分钟最多 10 次 AI 请求、每日最多 100 次。
- 回复使用 `text/event-stream` 事件：`meta`、`delta`、`done`、`error`。
- 当没有可用 LLM 配置时，使用明确标注的规则引导模式，不伪造实时行情或收益。
- 服务端上下文只包含必要摘要，不包含邮箱、密码、API Key、交易所密钥或其他租户数据。

### 2.2 策略 DSL

DSL V1 支持：

- 市场：平台白名单中的主流 USDT 现货交易对。
- 周期：`5m`、`15m`、`1h`、`4h`、`1d`。
- 方向：`long_only`。
- 入场/信号：EMA 金叉/死叉、RSI 阈值、Donchian 通道突破、成交量均值倍数。
- 退出：允许的反向信号、固定止损、固定止盈。
- 风控：单次资金占比、最大回撤、单日亏损限制、连续亏损暂停次数。
- 组合逻辑：入场为 `all`，退出信号为 `any`；V1 不接受任意嵌套表达式。

示例：

```json
{
  "schemaVersion": 1,
  "name": "BTC 趋势与成交量确认",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "side": "long_only",
  "entry": {
    "all": [
      { "type": "ema_cross", "fastPeriod": 20, "slowPeriod": 60, "direction": "bullish" },
      { "type": "volume_ratio", "period": 20, "operator": "gte", "value": 1.2 }
    ]
  },
  "exit": {
    "any": [
      { "type": "ema_cross", "fastPeriod": 20, "slowPeriod": 60, "direction": "bearish" }
    ],
    "stopLossPct": 2,
    "takeProfitPct": 4
  },
  "risk": {
    "positionPct": 3,
    "maxDrawdownPct": 10,
    "dailyLossLimitPct": 2,
    "consecutiveLossLimit": 3
  }
}
```

### 2.3 策略生成

- `POST /api/strategy-studio/generate` 接收对话 ID 和有限的策略问卷字段。
- 服务端读取所属对话的最近消息，调用当前用户或系统 LLM 配置。
- LLM 返回值视为不可信文本：先提取 JSON，再由确定性校验器验证并标准化。
- 校验失败时不得保存策略；接口返回结构化错误和可修改建议。
- 无 LLM 配置时生成确定性的保守模板，并标记 `guided_rules`。
- 策略保存仍走现有草稿 API；保存的每个版本必须有不可变快照。

### 2.4 回测

- 回测引擎使用同一个 DSL 校验器。
- 每条规则由白名单解释器执行；禁止 `eval`、动态导入、脚本执行、SQL 拼接或用户自定义代码。
- 回测继续计入手续费、滑点、止损、止盈、最大回撤和证据哈希。
- 证据记录包含规范化 DSL 和引擎版本，便于复现。

## 3. API 契约

| 方法与路径 | 成功结果 | 主要错误 |
|---|---|---|
| `GET /api/ai/conversations` | `{ conversations: ConversationSummary[] }` | `401/403` |
| `POST /api/ai/conversations` | `201 { conversation }` | `400/401/403/429` |
| `GET /api/ai/conversations/:id` | `{ conversation, messages }` | `401/403/404` |
| `PATCH /api/ai/conversations/:id` | `{ conversation }` | `400/401/403/404` |
| `POST /api/ai/conversations/:id/messages` | SSE `meta/delta/done/error` | JSON `400/401/403/404/429`（流建立前） |
| `POST /api/strategy-studio/generate` | `{ specification, explanation, mode, generationId, disclaimer }` | `400/401/403/404/422/429` |

所有 JSON 错误使用：

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "可读说明", "details": [] } }
```

为兼容现有页面，未改造的旧接口继续保留原错误格式。

## 4. 数据模型

- `ai_conversations`：归属客户、标题、用途、状态、最后消息时间、时间戳。
- `ai_messages`：归属对话与客户、角色、内容、生成模式、模型元数据、时间戳。
- `ai_usage_daily`：客户每日请求次数、输入/输出字符数；用于配额和审计。
- `strategy_versions`：策略 ID + 版本唯一，不可变保存名称、摘要、DSL 和创建来源。
- `generationId` 仅引用服务端审计记录；保存策略时重新计算 DSL 哈希并匹配该记录，客户端不能自行声明 `ai_provider` 或 `guided_rules` 来源。

## 5. 威胁模型与控制

| 威胁 | 控制 |
|---|---|
| 越权读取其他客户对话 | 每次读取/写入同时按对话 ID 与当前 `user_id` 查询；不存在与越权统一返回 404。 |
| Prompt 注入要求执行命令或绕过风控 | 系统提示声明工具边界；输出只能通过 DSL 白名单校验；无任何交易工具连接。 |
| LLM 输出代码、SQL 或超大 JSON | 仅解析首个 JSON 对象；响应长度上限；严格字段白名单；禁止额外字段和任意表达式。 |
| 用户误交密钥或密码 | 服务端敏感信息模式检测并拒绝保存；界面持续提示。 |
| 滥用导致费用或资源耗尽 | 消息长度、历史窗口、并发/分钟/每日限额、上游超时。 |
| 生成策略直接造成资金影响 | 仅保存草稿；必须人工确认与历史回测；生成和回测 API 不连接订单路由。 |
| 跨租户数据进入提示词 | 上下文查询只使用当前用户 ID，且只传必要聚合字段。 |

## 6. 非目标

- 图片、文件、语音输入和长期向量记忆。
- 做空、杠杆、期货、跨资产组合、配对交易和市场中性执行。
- 任意 Python/JavaScript 策略、插件代码或 QuantDinger 前端代码复用。
- 自动模拟盘、自动跟单或自动实盘启用。
- 真实收益承诺、个性化投资建议或合规结论。

## 7. 验收标准

- **AC-001**：客户 A 无法读取、修改或向客户 B 的对话发送消息。
- **AC-002**：刷新页面后可以恢复对话列表和完整消息。
- **AC-003**：客户端请求中不再包含完整历史，服务端使用已保存历史。
- **AC-004**：危险密钥样式、空消息、超长消息和超额请求被拒绝且不入库。
- **AC-005**：有效 DSL 能通过校验；未知字段、未知规则、非法周期和超风险参数被拒绝。
- **AC-006**：相同 K 线与相同 DSL 产生相同交易信号和证据输入。
- **AC-007**：修改 EMA/RSI/通道/成交量规则会真实改变回测行为，而非只改变展示文本。
- **AC-008**：AI 生成结果不能直接触发任何订单 API。
- **AC-009**：页面具备加载、空状态、错误、流式回复和键盘可用性。
- **AC-010**：构建、类型检查、Lint、单元测试和现有渲染测试通过。
