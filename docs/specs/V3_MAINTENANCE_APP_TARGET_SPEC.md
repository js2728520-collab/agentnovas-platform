# Maintenance V3 目标应用规格

状态：`TARGET`
日期：2026-08-28

## 1. 职责与边界

Maintenance 负责系统、品牌、模型、技能、Prompt、Token、套餐、支付配置、优惠、外部集成、日志、任务、安全、版本和 CI/CD 控制面。

Maintenance 不展示客户列表、客户账户、客户交易或业务客户详情。需要技术诊断时仅返回脱敏聚合、内部 ID 和 traceId。

主导航固定为五个业务中心：

1. 系统运行：健康、就绪、日志、任务和技术工作记录。
2. AI 与策略：模型、Agent、Prompt、技能和 AI 用量。
3. 外部集成：行情、交易所、邮件、通知、支付、防火墙和 CI/CD 状态。
4. 平台配置：品牌、域名、语言、功能、价格和版本化协议。
5. 发布与安全：版本、回滚、紧急停控、访问控制和技术审计。

每个中心仅展示当前已接通且有权限的 Tab；个人资料、外观、语言和账户安全进入设置。Maintenance 支持简体中文与英语，默认简体中文。未接通能力不显示空菜单或伪健康状态。

语言和主题优先级为：当前 Maintenance 会话的服务端偏好 > Maintenance 本地偏好 > `zh-CN`。偏好按 Maintenance audience 独立保存；不读取浏览器语言自动切换，也不复用 Client 或 Operations 的偏好。

Maintenance 的配置与控制操作不使用确认 modal。普通配置、测试、发布、回滚、集成启停和紧急
控制均在原页面展示影响范围，填写对应审计原因后单击执行；按钮在原因或其他前置条件无效时保持
禁用。该交互减负不替代 recent MFA、RBAC、maker/checker、幂等、不可变事实或服务端状态机。

## 2. 系统与品牌

- 站点名称、Logo、版权、域名、协议、多语言和预览。
- 配置草稿、差异、测试、审批、定时生效和回滚。
- 三端配置按 audience 作用域隔离。

实施快照（2026-08-24）：T3.1a 通用发布内核和 Maintenance-only API、T3.1b
`/configurations` 工作台与到期激活 Worker 已完成；工作台包含不可变版本、顶层差异、测试证据、禁止自审、明确
offset/UTC 预览、调度、current、激活和已生效历史回滚；最小权限到期激活 Worker 已通过
数据库复核、全局租约、专用角色和健康告警实现。品牌/域名/协议等具体消费者尚未实现，页面
明确不声称这些配置已接管运行时。

## 3. 功能开关

支持模块、用户/组织、版本、灰度百分比和定时启停。高风险开关使用 maker/checker、原因、幂等和审计；正式生产 MFA 开关开启后同时要求 recent MFA。

功能开关不能绕过真实交易、提现、划转或部署 Gate。

实施快照（2026-08-24）：T3.1c-FF1 与 FF2 已实现 `client.strategy_research` 的全局 v1 和
定向 v2。创建界面固定 key 与 Client audience，可选择模块开关，或按内部用户/组织、精确应用
SemVer、稳定灰度百分比和独立启停时窗配置单条定向规则；全程使用页面内原因直接提交，无确认
dialog。测试结果和证据摘要由服务端根据不可变 payload 生成，浏览器只提交审计原因。运行时
身份、组织、部署版本和时间均由服务端提供；激活/回滚从下一次 Client 请求生效且只能收窄环境
Gate。多规则优先级尚未定义，必须通过未来新 schema 扩展，不能在 v2 中隐式加入覆盖语义。

## 4. 模型、技能和 Prompt

- 模型 Profile、供应商、Key、模型 ID、连通性和 Agent 绑定。
- Key 只写不读，只返回 `hasSecret` 与版本。
- 技能和 Prompt 支持草稿编辑、测试、双人审批、发布、历史和回滚。
- 已发布版本只读，历史执行引用版本 ID。

## 5. Token、套餐、Credits、支付和优惠

- Token 按用户、组织、模型、Agent、日期、功能、费用和失败率统计。
- 套餐和 Credits 价格创建新版本，不覆盖旧版本；仅产品负责人可提交，双人审批和定时生效。
- 管理 USDT 支付 provider、安全状态和人工退款工作流。
- 管理优惠码、折扣码和优惠券的期限、次数、范围、叠加和恢复规则。
- 不读取客户钱包、订单详情或客户 PII。

实施快照（2026-08-24）：T3.9a 已形成 `/ai-usage` 与 `GET /api/maintenance/ai-usage` 的只读
分析合同。统计按 UTC 请求创建时间归属已预留 inference，展示可信成功 Token、settled Credits
和已记录非取消失败率；组织使用请求级快照并区分请求时捕获、legacy 当前归属回填和无归属，
用户只显示稳定伪名，模型固定到请求 revision，并提供 Agent、功能和日期维度。默认 30 天、最多
90 天，高基数维度只返回请求量 Top 50。preflight 拒绝、用户取消和处理中请求不进入失败率口径，
因此它不是系统/provider 可用率。P-08 固定对话 Credits 数值和模型/功能价格分档仍受阻断。

## 6. 外部集成

管理交易所、券商、行情、通知、支付、WAF/防火墙和 CI/CD 集成。页面仅显示 configured/enabled/healthy、最近测试、延迟、安全错误码和版本。

完整 endpoint、Key、Secret、Webhook payload、签名材料和长期 token 不进入响应。

## 7. 日志、任务和安全

- 覆盖 API、登录、Worker/队列、交易/风控、模型、支付、数据库和部署。
- 支持游标、时间、domain、action、status、requestId/traceId 筛选。
- PII/secret 脱敏，导出短期有效并审计。
- IP 黑名单由应用、Nginx、WAF/防火墙多层联动，支持原因、范围、过期、审批和误封恢复。

## 8. 真实交易安全控制

- 查看 Execution Service 健康、provider 激活、live blocker、对账队列和 kill switch。
- 不读取客户凭证明文。
- kill switch 按 provider、账户和策略生效；解除不自动恢复。
- 人工对账结论不能伪造成已知成交，必须遵循有效成交事实合同。

## 9. CI/CD 触发控制面

专项实现边界见 ADR-0024 与 `RESTRICTED_CICD_DELEGATION_SPEC.md`。T8.0 只冻结设计；G7 前 Current
`/releases` 继续只登记证据，不因表、Worker 或按钮存在而宣称可触发部署。

### 9.1 允许动作

- 触发预定义 staging deploy。
- 在 staging 成功后提交 production deploy 申请。
- 触发到同环境历史成功版本的 rollback。
- 查询 workflow 状态和追加部署证据。

### 9.2 禁止动作

- 任意 Shell、SSH、SQL、Git ref、镜像地址或环境变量输入。
- 在浏览器保存或显示 CI/CD 长期凭证。
- 创建者自审或跳过 staging。
- 根据“触发成功”直接把版本标为 deployed。

### 9.3 安全合同

Maintenance 发送版本 ID、环境、允许动作、reason、idempotency key。受限适配器解析不可变制品并调用固定 workflow；回调验签后追加事实。production 需要不同人员批准和 staging 同制品成功。

## 10. 验收

- Maintenance API/UI 中客户业务信息和 secret 为零。
- Prompt、定价、开关和部署均不能自审或覆盖历史。
- CI/CD 参数无法注入任意命令或未批准 ref。
- workflow 失败不改变 current；回调重放不重复记录。
- provider、Worker、部署和安全状态不会把配置当健康、把接受当成功。
