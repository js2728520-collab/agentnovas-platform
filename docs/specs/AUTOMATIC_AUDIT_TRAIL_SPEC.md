# 服务端自动审计留痕规格

状态：`CURRENT_TRUTH / COMPLETE`

日期：2026-08-30

## 1. 目标

用户不再为了保存配置、执行测试、发起控制动作或完成普通管理操作而填写通用“审计原因”。所有审计事实由
可信服务端根据已认证操作者、动作、资源、请求关联信息、幂等键和执行结果自动生成。UI 不得因为缺少审计文字
而禁用本来已经满足业务前置条件的按钮。

本规格覆盖 Client、Operations、Maintenance 的通用审计输入，并优先修复 `/ai-strategy?tab=models` 的模型
Profile 保存、探测、修订回滚、角色绑定和预算配置旅程。

## 2. 字段分类

### 2.1 必须移除的通用审计输入

- 配置、测试、启停、发布、回滚、调度、激活、导出和普通账号/权限操作的“审计原因”。
- 只为满足 API 或数据库 `reason` 非空约束而出现的 textarea、dialog 字段和按钮可用性校验。
- 浏览器请求中的上述 `reason`；旧客户端仍可提交，但服务端不得把它作为可信审计事实。

### 2.2 必须保留的业务语义输入

- 资金、Credits、充值、结算、退款或归属调整的业务依据。
- 拒绝决定、事故处置、风控 Kill Switch、真实路由控制的业务说明。
- 客户 PII 临时揭示的访问用途，以及法律/合规要求的声明或证据。

保留字段必须使用“业务依据”“拒绝说明”“事故说明”等准确名称，不能再泛称“审计原因”。它们既是业务决定
输入，也是自动审计事件的业务数据引用；服务端仍执行原有长度、权限、maker/checker 和 recent MFA 校验。

## 3. 自动审计合同

每个受控写操作至少绑定：

- `actorUserId` 与当前应用 audience；
- 稳定 `action`；
- `subjectType` 与 `subjectId`；
- 服务端接收或生成的 `requestId`，以及可用时的 `traceId`、`idempotencyKey`；
- 服务器时间、执行终态和安全错误码；
- 配置/修订/决定的非秘密摘要。

兼容期内，既有不可变事实表的 `reason` 列不删除。服务端写入稳定的
`automatic:<action>` 标记，代表审计来源为系统动作目录，而不是用户自由文本。`audit_logs.after_json` 同时记录
`auditSource: "automatic"` 与 `action`。不得从请求 body 复制通用 `reason`，也不得把 Prompt、结果、秘密、完整
端点或 Provider 回执写入审计。

审计写入继续与业务变更处于既有 PostgreSQL 事务中；幂等重放不得制造第二条业务事实。失败记录沿用各子系统
既有错误审计能力，本切片不以删除输入为由放宽或伪造失败终态。

## 4. API 兼容与迁移

- 新 UI 不发送通用 `reason`。
- 旧 API 在兼容期允许 body 中存在 `reason`，但忽略该值并使用服务端动作目录生成审计标记。
- 响应 DTO 暂时保留历史 `reason` 字段时，应将自动标记按原字段返回，不伪装成人工说明。
- 不删除旧列、旧事实、旧审计日志或历史人工原因；因此不需要破坏性数据库迁移。
- 业务语义原因继续按原 API 合同接收，除非对应资源另有版本化迁移。

## 5. UI 合同

- 删除 `InlineAuditReasonField`、`hasValidAuditReason` 和所有通用审计 textarea。
- 按钮只由真实业务前置条件、权限、busy 状态和安全 Gate 控制。
- 高风险动作可以保留目标/影响确认，但确认界面默认不要求输入审计文字。
- 需要业务说明的动作必须明确展示业务字段，不复用通用确认组件的“操作原因”。
- 成功/失败继续通过 `aria-live` 告知；键盘、焦点、四断点和颜色对比合同不变。

## 6. 安全边界

- RBAC、same-origin/CSRF、recent MFA、maker/checker、作用域、幂等、限流和不可变事实链全部保持。
- 浏览器不能选择审计 action、actor、subject 或审计来源。
- 自动审计标记来自服务端 allowlisted 常量；非法 action 必须失败关闭，避免日志注入。
- 不增加 Redis、Cloudflare Runtime、真实 Provider 调用、真实交易或外部写入。

## 7. 验收

- 模型配置测试成功后，只要模型表单本身有效即可保存 Profile。
- 代码库没有 `InlineAuditReasonField`、`hasValidAuditReason` 或通用审计输入组件的运行时引用。
- AI 控制面和旧 Profile/绑定 API 在 body 不含 `reason` 时成功进入原业务流程。
- 旧客户端发送任意通用 `reason` 时，该文字不会进入新审计事实。
- 配置、集成、发布、权限、账号和导出等已识别通用流程使用服务端自动标记。
- 资金、拒绝、事故、风控、PII 等业务语义说明仍受原安全校验保护。
- 定向合同、PostgreSQL、TypeScript、ESLint、架构/密钥门禁、三端构建和浏览器主旅程通过。

## 8. 实施结果

三端通用手工审计字段和按钮 Gate 已退役，AI Profile 在真实配置前置条件满足时即可保存。审计 helper 在可信
服务端边界根据 allowlisted action 生成自动标记，调用方不能再注入 `reason`；旧 API 的同名字段只为兼容而
接收并忽略。资金、审批决定、事故处置、风控控制和 PII 访问用途等业务字段使用准确名称继续保留。

最终本地验收：全量 Node/PostgreSQL 合同 `1692/1692`、production Chromium `20/20`、TypeScript、ESLint、
Client production build、8 条架构边界、三端 Web key-custody、3363 文件秘密扫描和依赖高危审计全部通过。
真实 Provider、Research Worker、Runtime 外部解释、真实交易和外部写入继续默认关闭。
