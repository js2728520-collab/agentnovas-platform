# T4.4a 可编辑结构化策略候选规格

状态：`CURRENT / IMPLEMENTED (T4.4a)`

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

## 7. 实施与验证证据（2026-08-24）

- 服务端 `cffdd4b`：候选保存使用 32 KiB 有界 JSON、严格 `specification` 合同、V1–V3 服务端
  规范化/重校验、语义变化 `manual + UNVERIFIED`、候选级 PostgreSQL advisory transaction lock、
  不可变版本重放与不同输入 `409`。崩溃窗口只在实际 DSL 和标签一致时恢复关联。
- Client `795f552`：候选提供完整 JSON 编辑器、本地错误 `role=alert`、保存 busy/失败关闭、服务端
  canonical 结果接管、保存后锁定；编辑后的持久投影隐藏旧回测指标并显示“需重测”。网络失败或
  无效响应不会伪造保存成功。
- 浏览器与夹具 `e020240`、`31a8c0f`、`19e516e`：质量数据库包含隔离的完成态研究、已验证候选和
  holdout 证据。关闭态质量环境不放宽 `STRATEGY_RESEARCH_ENABLED=false`，因此 Chromium 只对候选
  读/写响应使用有状态本地投影；它仍检查浏览器实际请求体、201 结果、刷新投影和零 deployment
  请求。真实 DSL 降级、所有权、不可变关联、重复关联与并发串行化由领域/PostgreSQL 测试覆盖。
- 最终本地：`npm test` 1394/1394、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、
  repository secret scan（3083 个候选文件）、production dependency audit 0、`git diff --check`。
  首次全量运行遇到跨文件临时 PostgreSQL role teardown 竞争；涉事文件单独 4/4、随后完整重跑
  1394/1394，未修改业务代码掩盖夹具竞争。
- 云端：`e0202404167b6d2f4863593a4333bb42fd5fbf3c` / tree
  `bdbe698dd5391518fa176fc5c12bbef0572d2001` 的 3083 文件归档摘要为
  `d375229b0d6ec149c7e6e2f5878c23cd3235bc07b9a5d18510e46833c048785b`；`ssh an-saas` 的固定
  Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页 production build，production
  audit 为 0。官方 nginx 1.29.8 检查通过并保留 8 条既有 http2 兼容警告。
- 三端 standalone 归档摘要
  `a79cb4eff2df4ce084b0b427e4ef62e63b726cb1a655da0165f806c6de702573` 下载前后一致；本地隔离
  PostgreSQL、MFA 默认关闭和全部外部写入禁用的真实 Chromium 最终 18/18，通过三端空浏览器登录、
  audience/Cookie 隔离、新候选编辑旅程和 Maintenance 无确认弹窗回归。测试 schema、运行时密钥、
  本地/远端一次性产物均已清理，原本机三端 cache 已恢复；未推送、未部署、未执行生产迁移。
