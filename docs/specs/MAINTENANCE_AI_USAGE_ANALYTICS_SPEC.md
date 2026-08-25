# Maintenance AI 用量分析规格

状态：`TARGET_TRUTH / PARTIAL_CURRENT`。T3.9a 已实现并通过完整 Gate；T3.9b 仍由 P-08 固定价格阻断。

## 1. 目标

Maintenance 提供只读 AI 用量与运行记录看板，基于当前付费 Client AI 运行时的可信计量事实，支持按日期、组织、用户、模型、Agent 和功能查看请求数、可信 Token、Credits 结算与已记录非取消失败率。

本切片不实现固定 Credits/用量模式的运行时切换，也不决定独立的价格消费者。P-08 参数唯一以
`packages/contracts/src/product-parameters.ts` 为准；固定 Credits 数值、模型/功能分档和
`provider_usage` 运行时接线须另有版本化配置、历史 pin、确定性测试和 Gate。当前可信用量结算
只能作为历史/当前计量事实，不能冒充已确认的固定价格。

## 2. 真源与排除项

唯一请求真源为 `client_ai_inference_requests`：

- 成功请求使用 provider 返回且已通过运行时校验的 `input_tokens`、`output_tokens`；
- 模型使用请求固定的 `profile_revision_id`，不得按 Profile 当前版本回填历史；
- Credits 使用请求关联 reservation 的真实 `status` 和 `settled_credits`；
- 新请求在创建 inference 时保存客户当时的有效组织归属快照，后续客户转组不改写历史；迁移前记录以迁移时的当前有效归属回填并标记 `legacy_current_backfill`，无法回填的标记 `legacy_unattributed`；
- `ai_usage_daily` 只含旧字符计数，不是当前付费 AI 的可信计量，不得参与本看板。

不得查询或返回模型密钥、base URL、请求 payload、AI 结果、错误原文、provider request ID、usage ID、邮箱、手机号、用户名或昵称。

## 3. 时间窗口

- 查询参数：`from=YYYY-MM-DD`、`to=YYYY-MM-DD`；两端均包含；
- 时区固定为 UTC，并在响应和界面中明确标识；
- 时间归属固定使用 `client_ai_inference_requests.created_at`，即请求创建 cohort；跨日完成或结算不改变日期归属；
- 默认窗口为截至当前 UTC 日期的 30 天；
- 最大窗口为 90 个自然日；未来日期、倒置区间和非法日期返回 400；
- 服务端计算默认值和校验，不信任浏览器。

## 4. 指标口径

每个总览或分组均返回：

- `requestCount`：窗口内全部请求；
- `succeededCount`：`status=succeeded`；
- `recordedFailureCount`：`status=failed` 且 `error_code` 不是 `AI_REQUEST_CANCELLED`；
- `cancelledCount`：`status=failed` 且 `error_code=AI_REQUEST_CANCELLED`；
- `processingCount`：`status=processing`；
- `inputTokens`、`outputTokens`：仅累加成功请求的可信 Token；
- `settledCredits`：仅累加 `reservation.status=settled` 且非空的 `settled_credits`，以十进制字符串返回，避免 JavaScript 精度丢失；
- `releasedCount`：关联 reservation 为 `released` 的请求数；
- `recordedFailureRate`：`recordedFailureCount / (succeededCount + recordedFailureCount)`；分母为零时返回 `null`。

统计总体仅包含已经建立 `client_ai_inference_requests` 且完成 Credits 预留阶段的请求。模型配置不可用、余额不足、请求校验失败等 preflight 拒绝不在请求表中，也不在本指标中；主动取消不进入分子或分母；处理中请求尚无终态，也不进入分母。因此本指标只能描述“已记录 cohort 的非取消失败率”，不能单独描述 provider 或整套系统可用率。

## 5. 分组合同

响应同时包含以下有界分组：

- `byDay`：窗口内每天一组，按日期升序；
- `byOrganization`：请求级组织快照；无归属统一为 `unattributed`；最多 50 组，按请求数降序；
- `byUser`：数据库安全投影先提供非原始的单向伪名源，API 再以 SHA-256 生成稳定 `USR-` 标识；不返回原始用户 ID 或身份字段；最多 50 组。该标识属于 pseudonymization，不声明为不可关联的匿名化；
- `byModel`：固定 revision ID、provider 名和 model 名；最多 50 组；
- `byAgent`：`assistant_message -> report`、`strategy_generation -> proposal_a`；
- `byFunction`：`assistant_message`、`strategy_generation`。

超过 50 组时响应返回对应 `truncated=true`，界面提示当前只展示请求数最高的 50 组。

## 6. 权限与数据边界

- 新权限：`maint.ai_usage.view`，敏感只读权限；当前全局 MFA Gate 关闭时不增加登录或操作弹窗，正式生产重新开启 MFA 后要求近期 MFA；
- Maintenance API 必须使用 `requireAccessPermission(request, "maint.ai_usage.view")`；
- bootstrap 管理员和 `tech_staff` 默认获得该权限；
- Maintenance 数据库角色只获得专用安全投影视图的 `SELECT`，不得因本功能获得 Client AI 原始请求表、Credits 账本或客户归属表的新增直接权限；
- 安全投影只暴露聚合所需列，禁止包含 payload、result、error message、provider request ID、usage ID 和任何模型凭证；
- API 响应设置 `cache-control: no-store`。

## 7. API

`GET /api/maintenance/ai-usage?from=YYYY-MM-DD&to=YYYY-MM-DD`

成功响应：

```json
{
  "period": { "from": "2026-08-01", "to": "2026-08-24", "timezone": "UTC" },
  "timeBasis": "request_created_at",
  "population": {
    "included": "reserved_inference_requests",
    "failureNumerator": "non_cancelled_failed_terminal_requests",
    "excludes": ["preflight_rejections", "user_cancellations", "processing_requests"]
  },
  "pricing": { "status": "decision_required", "blocker": "P-08" },
  "summary": {},
  "byDay": [],
  "byOrganization": { "data": [], "truncated": false },
  "byUser": { "data": [], "truncated": false },
  "byModel": { "data": [], "truncated": false },
  "byAgent": [],
  "byFunction": []
}
```

非法窗口返回统一错误信封和 HTTP 400；未认证返回 401；无权限返回 403。

## 8. UI 与可访问性

- Maintenance 新增“AI 用量”导航和 `/ai-usage` 页面；
- 日期字段内联筛选，点击“应用日期”直接读取，不增加 `confirm()` 或二次确认弹窗；
- 顶部显示请求、可信 Token、已记录非取消失败率、已结算 Credits、组织归属证据质量与固定费用规则状态；
- 分组表提供明确表头、空态、加载态、错误态和重试；
- 请求刷新期间保留旧数据并用 live region 表明更新中；
- 所有日期和失败率口径在页面中可见，不用颜色作为唯一状态信号。

## 9. 验收

1. 合成成功、失败、取消、处理中请求后，各指标符合第 4 节口径，界面不得将该指标命名为系统失败率或 provider 可用率。
2. 大整数 Credits 不发生 Number 精度损失。
3. 用户响应只含稳定脱敏标识；原始 ID、邮箱、错误原文和 AI 内容不出现在 API 响应。
4. 历史请求展示其固定模型 revision，而不是 Profile 当前 revision。
5. 91 天、倒置、未来或非法日期被拒绝。
6. API inventory 登记为 Maintenance permission route。
7. Client 与 Operations 构建不包含该 Maintenance 页面模块。
8. 三端登录与路由隔离浏览器回归通过；Maintenance 有权限账号可打开看板，无权限账号得到拒绝。

## 10. 已知边界

- P-08：参数已在 `packages/contracts/src/product-parameters.ts` 冻结；固定 Credits 消费者、模型/功能价格分档和计费模式切换仍未接入并通过 Gate，费用列不得标记为固定价格已生效。
- 迁移前记录没有原始请求时刻组织证据，只能以迁移时归属回填并显式保留 legacy 标记；不得把该回填描述成原始历史快照。
- 当前付费 AI 仅覆盖 `assistant_message` 和 `strategy_generation`；后续新增操作必须显式扩展 operation-to-Agent 映射和测试，未知操作不得静默归类。

## 11. T3.9a 验收证据（2026-08-24）

- 全量逻辑测试 1430/1430，TypeScript、全仓 ESLint、8 条架构边界、repository secret scan（3096 个候选文件）和 production dependency audit 0 全部通过；
- `ssh an-saas` 使用 Node 22.21.1 完成 Client 67、Operations 62、Maintenance 52 页 production build；bundle budget、三端 key-custody 和官方 Nginx 配置检查通过；
- 最终 Maintenance 源文件本地/云端 SHA-256 均为 `bfba6a4c8c14898bc4336b1b4f97f8f725d183571439a504cba15d177b612ed5`，重建后的 standalone + static 归档本地/云端 SHA-256 均为 `4a5376e024d3146f59850aa2f254a45d05b6014d877f1ec7341925b63cb5a875`；
- 本地以云端产物、隔离 PostgreSQL、MFA 默认关闭和全部外部写入禁用运行真实 Chromium/axe 20/20；覆盖三端从空浏览器登录、Host/Cookie audience 隔离、权限链接注册、五设备安全、Maintenance AI 用量有权限访问、非法共享日期 URL 错误恢复、零控制台告警及普通配置动作零冗余确认弹窗；
- 质量 schema `quality_e2e_1787528629948_38829_4c22d548` 已删除，runtime secrets 已移除，cleanup failures 为 0；本机原三端 build cache 已恢复；未执行生产迁移、未接触生产数据库、未启动或切换远端服务、未推送、未部署。
