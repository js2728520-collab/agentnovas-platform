# AI 控制面候选验收证据（2026-08-30）

状态：`CANDIDATE_COMPLETE / AWAITING_MERGE_APPROVAL`

## 1. 候选范围

- 基线提交：`62261ec`
- 候选分支：`codex/ai-control-plane-reuse`
- 独立工作树：`/Users/kevin/Documents/Kevin/agentnovas-platform3/ai-control-plane-worktree`
- 当前仓库要求：Node.js `>=22.21.0`；本机验收 Node.js `v26.5.0`
- 未执行：Registry 发布、远程 push、PR、测试站/生产部署、真实 Provider 凭证测试、真实交易或工作树合并/删除

候选分支按规格、包、持久化、密钥域/Gateway、消费者/UI、Runbook/验收顺序形成原子提交。实现保留
`/ai-strategy?tab=models|usage` 和旧 Profile/Binding API facade，固定 12 个显式角色，并新增：

- `@agentnovas/ai-control-plane@0.1.0`：ESM、类型声明、明确 exports，无 Next.js、PostgreSQL 或 AgentNovas RBAC 依赖；
- `@agentnovas/ai-control-plane-react@0.1.0`：数据源、角色、动作/权限、文案、格式器和 class names 由宿主注入；
- `0093_ai_control_plane.sql` / `0094_ai_secret_custody.sql`：加法、可重跑迁移与 legacy ID/FK/API 兼容；
- 默认关闭的独立 Secret Broker 和 loopback AI Gateway；
- Client、Research、Runtime explanation 与 Probe 的统一用量、精确 Provider 成本、settled Credits、软预算和安全视图。

## 2. 自动化 Gate

| Gate | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run build:packages` | PASS | 两个 `0.1.0` 包生成 ESM 与 `.d.ts` |
| `npm run test:packages` | PASS | 12/12；公共 API、状态派生、fallback、价格、Provider adapter、React SSR |
| `npm run pack:packages` | PASS | 临时空项目安装两个 tarball，Node import、TypeScript 与 React JSX 消费通过；输出 `core/react@0.1.0` |
| `npm test` | PASS | 1683/1683；含 PostgreSQL fresh/rerun、legacy 升级、并发修订、Broker fencing、Fake Provider 幂等与统一用量 |
| `npx tsc --noEmit --incremental false` | PASS | 无类型错误 |
| `npm run lint` | PASS | 无错误或 warning |
| `npm run quality:boundaries` | PASS | 8/8 架构边界 |
| `npm run quality:key-custody` | PASS | Client 580、Operations 520、Maintenance 521 个部署 JS；三端均无模型/交易所凭证解密能力 |
| `npm run quality:secret-scan` | PASS | 3360 个候选文件，零 finding |
| `npm run test:apps` | PASS | Client、Operations、Maintenance 三个 Next.js 16 production build |
| `npm run quality:bundle` | PASS | gzip JS：Client 200147、Operations 201200、Maintenance 201320 bytes；上限 204800 |
| `QUALITY_E2E_PORT_OFFSET=10 npm run test:e2e` | PASS | Playwright production Chromium 20/20；四断点、键盘、axe、Host/Cookie/audience/RBAC 与 AI 主旅程 |
| `git diff --check` | PASS | 无空白错误 |
| `npm audit --omit=dev --audit-level=high` | PASS | production dependency vulnerabilities 0 |

本机另一个无关项目长期占用默认 Maintenance 端口 3002，未终止或修改该进程；E2E 使用仓库正式支持的
`QUALITY_E2E_PORT_OFFSET=10` 在 3010–3012 执行，其余参数、production standalone 产物和 20 条 canonical
旅程不变。E2E 临时 PostgreSQL schema 已清理，运行时测试秘密已删除，`externalWritesEnabled=false`。

忽略目录内的机器证据摘要：

- `outputs/quality-e2e/gate-result.json`：`bd0135afc3b1c538bea89ee963c2d1cdb94c523ade931b0d54ddb83f55d328d6`
- `outputs/quality-e2e/results.xml`：`4fb5c47b5493a7af541b69eb65ca8212170503c2db88026a77770a7e2a5ce369`
- `outputs/quality-e2e/fixture-cleanup.json`：`189f981ea9544f440719dc5bce65ce6a03e370e50fe9190a4a8ee8701b1e1906`
- `outputs/quality-bundle/report.json`：`5fe52cb1b921ba7006cd1f40d265a9617ccb982f09678640303c0787b63eb0ab`

## 3. 安全与正确性证据

- 浏览器以 AES-256-GCM 加密 API Key，以 Broker RSA-OAEP-SHA256 公钥包装数据密钥；Maintenance 只写密文命令。
- Broker 私钥只由独立进程读取；keyring 支持 generation，目录/文件分别强制 `0700`/`0600`，原子替换且命令有租约和 fencing。
- 成功命令清空 envelope，只保留 `secretRef`、指纹和 receipt；Web/普通 Worker 不以 legacy 密文字段作为运行时真源。
- Gateway 只监听 `127.0.0.1`，不在 Nginx 暴露；公共 HTTPS 策略拒绝凭证 URL、查询参数、重定向、IPv4/IPv6 私网、多播/保留地址和 DNS rebinding。
- `invocationId + requestHash` 保证同请求重放、不同 hash 冲突；取消、认证、配置、校验、权限、预算和输出合同错误不进入 fallback。
- 代码审查期间修复了传输错误被误归类为 `network` 的问题；用户取消现在保持 terminal `cancelled`，大小/输入校验保持 terminal `validation`。
- Provider request ID 只在可信调用结果短暂存在，数据库持久化为 SHA-256；安全视图不返回 Prompt、结果、完整端点、秘密或原始用户 ID。
- 预算只记录 80%/100% 告警事实，不自动停业务；无 Rate Card 的调用保持 `unpriced`，Provider 成本与平台 Credits 分离。

## 4. 验收边界

Fake Provider 证明本地完整调用、Probe、fallback、幂等、Token、成本和用量闭环，但不构成真实 Provider 验收。
以下模板和运行时仍默认关闭：

- `AI_GATEWAY_ENABLED=false`
- `AI_SECRET_BROKER_ENABLED=false`
- `STRATEGY_RESEARCH_ENABLED=false`
- `STRATEGY_RUNTIME_ENABLED=false`

本候选没有引入 Redis、Cloudflare Runtime、原生 Anthropic/Gemini、客户 BYOK、固定 Credits 定价或真实永续订单
路由。LLM 不拥有 DSL 校验、回测、评分、风控或订单意图决策权。

## 5. 合并前停止点

候选分支和工作树必须保留。原工作区中的邮件/支付未提交改动不属于本候选，未被携带、stash、覆盖或暂存。
只有用户确认后，才执行：原工作区所有者先处理干净状态 → 候选分支 rebase 到最新
`codex/platform-v3-doc-sync` → 重跑本页全部 Gate → 用户再次确认 → 本地 fast-forward merge → 确认两边干净后
正常移除工作树和删除已合并本地分支。任何一步失败或未获批准都保留候选，不强制删除。
