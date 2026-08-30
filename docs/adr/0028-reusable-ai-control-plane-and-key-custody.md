# ADR-0028：可复用 AI 控制面、独立模型密钥域与本机 Gateway

状态：Accepted（实施中）

日期：2026-08-30

## 背景

当前模型 Profile 同时包含 Provider、端点、模型和加密 Key，Research 与 Runtime 角色各自单选一个 Profile；
Client AI 又隐式复用 `report` 与 `proposal_a`。连接测试结果不持久化，Research/Runtime 调用未进入统一用量，
三个 Web/Worker 仍可能通过同一 `LLM_PROFILE_ENCRYPTION_KEY` 还原 Key。这些边界妨碍一把凭证复用多个模型、
配置健康判断、故障切换、成本核对和跨项目复用。

## 决策

1. 领域模型拆为 Provider Connection、Model Deployment 与 Binding Policy，全部使用不可变修订。
2. 固定 7 个 Research、3 个 Runtime explanation 和 2 个 Client AI 角色；七产品阶段仍由确定性代码拥有。
3. Binding 最多 primary + 2 fallback，只对网络、超时、429、Provider 5xx 回退。
4. 建立 `@agentnovas/ai-control-plane` 与 `@agentnovas/ai-control-plane-react` 两个内部可打包组件。
5. 核心包只定义纯合同与端口；首版 Provider adapter 仅实现 OpenAI-compatible Chat/Responses。
6. API Key 通过浏览器 envelope 交给独立 Secret Broker；Web 不持有模型解密主钥。
7. 所有真实模型网络调用收敛到只监听 loopback 的 AI Gateway；调用以 ID/hash 幂等并记录实际 fallback。
8. Client、Research、Runtime、Probe 使用统一 Usage Event；Provider 成本、平台 Credits、未定价分别呈现。
9. 预算是软告警；请求大小、Token、并发和速率是 Gateway 硬门禁。P-08 前不按价格自动停业务。
10. 迁移保留旧 ID、FK、API 和表作为兼容/回滚基础，不在本切片删除历史。
11. Gateway 与全部真实 Provider 能力默认关闭；legacy Research Worker 和真实永续路由继续硬关闭。

## 安全边界

- Browser、Maintenance Web、Client Web 不取得明文 Key 或 Broker 私钥。
- Broker 只处理有摘要、租约和 fencing 的命令，原子写入 0600 受管文件。
- Gateway 使用独立数据库角色和服务鉴权，不接 Nginx，不接受任意 URL 或 operation。
- AgentNovas 只允许公共 HTTPS；私网/本机端点失败关闭。
- Provider 响应是不可信数据，仍需业务层结构化校验；Gateway 不能修改 DSL、风控或订单意图。

## 后果

收益：配置可复用、Key 托管收敛、角色职责清晰、故障回退可审计、全部 AI 成本可对账。

代价：增加 Broker/Gateway 两个本机进程、两次加法迁移、旧 API facade 和一段受控兼容期；真实 Provider
启用需要独立运维 Gate 与凭证证据。

## 被拒绝的方案

- 继续一体化 Profile：无法安全共享 Connection，也不能表达能力和 fallback。
- Web/各 Worker 直接解密：扩大公网进程和多进程凭证域。
- 动态“智能”路由：难以重放、成本不可预测且会掩盖配置故障。
- 首版同时实现 Anthropic/Gemini 原生协议：扩大未验证面；Adapter 接口已经为后续扩展保留边界。
