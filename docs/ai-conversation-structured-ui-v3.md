# Spec: AI 对话结构化展示与快捷确认 V3

## Objective

为客户账号的普通 Agent 对话和策略研究对话提供一致的结构化阅读与确认体验：

- AI 回复按“结论、关键证据、失效条件、下一步、待确认问题”分区渲染，历史纯文本消息也兼容。
- 当回复包含需要客户确认的问题时，界面展示一个可访问的选择弹窗。
- 弹窗提供 2–4 个候选项，默认预选推荐项，客户可以直接确认，也可以填写自定义答案。
- 确认结果通过现有消息接口作为客户消息保存，不绕过服务端安全、配额与审计边界。

## Tech Stack

- React 19 客户端组件与 TypeScript。
- 现有 SSE 消息接口和 PostgreSQL 会话持久化。
- 无新增前端依赖；使用平台现有 CSS 设计语言。

## Commands

- 定向测试：`node --test tests/ai-message-presentation.test.mjs tests/ai-ui-contract.test.mjs`
- 完整测试：`npm test`
- 生产构建：`npm run build`
- 改动文件 lint：`npx eslint app/agent-chat.tsx app/community-strategy-center.tsx app/ai-message-content.tsx lib/ai-message-presentation.ts tests/ai-message-presentation.test.mjs`
- 本地开发：`npm run dev`

## Project Structure

- `lib/ai-message-presentation.ts`：纯函数解析历史和流式 AI 文本，生成结构化展示模型与候选问题。
- `app/ai-message-content.tsx`：共享结构化消息卡片和快捷确认弹窗。
- `app/agent-chat.tsx`：普通 Agent 会话接入共享展示和自动发送选择结果。
- `app/community-strategy-center.tsx`：策略研究会话接入相同组件。
- `app/globals.css`：复用深色蓝色设计系统的卡片、选项和移动端样式。
- `tests/ai-message-presentation.test.mjs`：解析和候选项的单元测试。

## Code Style

保持纯解析与 UI 分离，使用显式类型和语义化 HTML：

```tsx
const presentation = parseAiMessage(content);
return <AiMessageContent presentation={presentation} onAnswer={sendAnswer} />;
```

候选问题使用原生 `<dialog>`、`<fieldset>`、`<input type="radio">` 和明确的按钮文案；不使用不可聚焦的 `div` 模拟控件。

## Testing Strategy

- 小型单元测试覆盖：标题解析、Markdown 清理、编号问题、默认候选、显式候选和无问题消息。
- UI 合同测试确保普通 Agent 与策略工作室都使用共享组件，并把选择结果发送到现有消息接口。
- 浏览器端验证历史消息、弹窗默认选择、自定义输入、键盘可访问性、响应式布局和干净控制台。

## Boundaries

- Always：向后兼容现有纯文本数据库记录；选项答案按普通客户消息持久化；候选内容长度和数量受限；不渲染任意 HTML。
- Ask first：数据库 schema 变更、增加第三方 Markdown/富文本依赖、改变服务端消息接口。
- Never：从 AI 文本执行代码；自动代表客户确认；读取浏览器凭据；把对话选项直接转换成交易指令。

## Success Criteria

1. 历史和新 AI 回复均显示为清晰的结构化区块，普通文本仍可读。
2. 回复含一个或多个明确问句时显示“需要你确认”入口，并打开带默认候选的弹窗。
3. 客户可点选候选或填写自定义内容；未确认前不会发送任何消息。
4. 确认后答案出现在会话历史中，并触发下一轮 AI 回复。
5. 普通 Agent 与策略研究页行为一致；移动端弹窗不溢出；浏览器无新增错误或警告。

## Open Questions

本轮按以下已确认默认值实施：同时覆盖两类对话；客户端兼容解析历史消息；每个问题最多 4 个候选；第一项为默认推荐；自定义答案优先于候选；不改数据库和 API 合同。
