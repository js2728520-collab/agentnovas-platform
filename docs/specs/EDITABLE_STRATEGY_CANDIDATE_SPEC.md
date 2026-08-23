# T4.4a 可编辑结构化策略候选规格

状态：`TARGET / APPROVED FOR IMPLEMENTATION`

依据：PRD 6.3“策略结果包含文字建议、可编辑参数和可回测的结构化策略”；用户已授权按已确认
设计和任务清单直接推进。本文只细化既有 ADR-0001、ADR-0002、ADR-0004 和 ADR-0021，不选择
QuantDinger 移植范围、真实 provider、收费数值或实盘能力。

## 1. 目标与假设

客户在多 Agent 研发完成后，可以同时看到文字结论、验证证据和完整结构化 DSL；在首次保存前可
编辑 DSL 参数。浏览器输入永远不可信，保存接口必须重新执行服务端 DSL V1–V3 白名单校验并保存
规范化结果。

本切片采用以下已确认边界：

1. 参数编辑使用完整结构化 JSON，避免 UI 只覆盖少数风险字段却暗示“全部参数可编辑”。
2. 仅格式或字段顺序变化不算策略变化；任一规范化后的语义变化都使原回测/评分证据失效，保存
   标签固定降为 `UNVERIFIED`，不得沿用 `STANDARD_VERIFIED`。
3. 未修改的候选保留原验证标签。修改后的草稿仍可按既有 ADR 进入 shadow/paper，但必须显示未验证；
   本切片不连接真实订单，也不解锁任何 live Gate。
4. 策略版本保存后不可原地修改。相同候选、相同规范化输入的重试返回同一策略和版本；同一候选
   已保存后换另一份输入必须返回冲突，不能静默忽略修改。
5. 文字建议继续来自研发时间线、反方意见、拒绝原因、指标与最终结论；JSON 编辑器不伪装成新的
   LLM 建议或新的回测结果。

## 2. 服务端合同

`POST /api/strategy-research/runs/{runId}/candidates/{candidateId}/save`

请求：

```json
{
  "specification": {
    "schemaVersion": 3
  }
}
```

- 请求体最大 32 KiB，只允许 `specification`；为兼容旧客户端，空请求体表示保存原候选。
- route 重新校验候选所有权与 DSL，比较规范化候选和规范化请求。
- 语义未改：`source=ai_provider`，保留候选验证标签。
- 语义已改：`source=manual`，验证标签固定 `UNVERIFIED`，摘要明确“用户编辑后需重新回测”。
- 成功结果返回实际保存的规范化 `specification`、`edited`、`validationLabel`、策略和版本 ID。
- 非法 JSON/DSL 返回 `400/413/422`；已保存后更换输入返回 `409`。

策略草稿的幂等入口必须核对既有不可变版本的名称、摘要、DSL、来源和验证标签；相同 ID 但内容
不同不得被当成成功重放。

## 3. Client 交互

- 每个候选显示“结构化策略参数”区域和规范化 JSON 文本框。
- 文本框有可见标签、辅助说明、等宽字体、拼写检查关闭和合理行数；键盘可完整操作。
- 本地 JSON 解析失败时显示 `role=alert`，不发请求；服务端校验问题按字段路径显示。
- 保存期间按钮禁用并显示进行状态；成功后使用服务端返回的规范化 DSL 更新候选，编辑器锁定。
- 语义编辑成功后明确提示“验证标签已重置，必须重新回测”，不能继续显示原 verified 样式。
- 320、768、1024、1440 px 不产生水平页面溢出；结构化文本框允许自身纵向滚动和换行。

## 4. 测试策略与命令

- 纯/合同测试：规范化等价、语义修改降级、未知字段/越界值拒绝。
- PostgreSQL/服务测试：首次保存、相同输入重放、不同输入冲突、不可变版本和审计来源。
- UI 合同与真实 Chromium：打开候选、制造 JSON 错误、修改参数、保存、看到 `UNVERIFIED`，刷新后
  仍读取实际保存版本；确认没有真实订单请求。

```text
npm test
npx tsc --noEmit
npm run lint
npm run quality:boundaries
npm run quality:key-custody
npm run quality:secret-scan
npm audit --omit=dev --audit-level=high
git diff --check
```

三端 production build 固定在 `ssh an-saas` 的 Node 22.21.0+ 环境执行。UI 完成后使用 production
standalone、本地隔离 PostgreSQL 和真实 Chromium 验证，不以源码字符串测试代替浏览器证据。

## 5. 文件与边界

- 服务端：候选保存 route、策略草稿幂等服务及其测试。
- Client：策略研发候选组件、现有设计 token/CSS 和浏览器旅程。
- 始终：服务端重新校验、版本不可变、用户/候选所有权、Paper/Demo 与 live 隔离。
- 不做：任意代码编辑/执行、自动回测、自动投稿、真实订单、收费改变、provider 选择或 QuantDinger UI
  复制。

## 6. 完成标准

只有服务端安全合同、UI 交互、PostgreSQL 幂等/不可变测试、全量质量门禁、云端三端构建和真实浏览器
旅程全部有证据时，才可将 `tasks/todo.md` 的 4.4a 标为完成。T4.4 整体仍需新市场/provider 字段与
完整策略结果端到端验收，不因本切片自动完成。
