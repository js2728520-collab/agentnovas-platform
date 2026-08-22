@AGENTS.md

# AgentNovas / Riverton Capital

AgentNovas 是技术平台与代码品牌，Riverton Capital 是面向客户的产品品牌。

**卖的不是收益，是可解释、可审计的决策过程。** 核心 IP 是七智能体决策链：
LLM 负责解释、提案、质疑；**确定性代码拥有校验、回测、评分、准入、风控和订单意图**。
收入来自四档会员 + AI 积分 + 周绩效分成（UTC 自然周，高水位线，亏损周不计费）。

三个应用：Client（受邀客户）、Operations（运营 maker/checker/客服）、Maintenance（技术与安全）。

---

## 不可违反的业务不变量

这些是产品与合规决策，不是技术选型。**重构可以改变任何代码结构，但不能违反下面任何一条。**
标注了当前的强制方式——「约定」意味着没有机器保护，改动时要格外小心。

| 编号 | 不变量 | 强制方式 |
| --- | --- | --- |
| **INV-1** | **风控结论不可被任何模型覆盖。** 硬风控由确定性代码执行；LLM 只能解释、提案、质疑，不能改写风控输出。 | 约定 + 测试 |
| **INV-2** | **客户 paper 回执与平台 Demo 回执永不混写。** 分表存储、分接口读取；客户订单历史只能从 paper trades API 读，不得回退到空数组或浏览器构造。 | 分表 + 测试 |
| **INV-3** | **资金与权益变更走 maker/checker 双人复核。** 发起人不能批准自己发起的单据；「记录凭证」与「批准」是两个独立权限，同一角色不应同时持有。 | 代码 + 测试 |
| **INV-4** | **账本 append-only、借贷必平、幂等。** 更正只能通过反向分录。 | ✅ **数据库触发器**（见下） |
| **INV-5** | **绩效分成按 UTC 自然周 + 高水位线。** 亏损周不计费，需先补回高水位线以上部分。历史订单保存计划版本与费率快照，改价不影响历史。 | 代码 + 测试 |
| **INV-6** | **未达门槛必须显式标注。** 回测未通过准入显示 `NOT_QUALIFIED`；集成未配置显示「未配置」而不是伪装就绪；降级不得被记录为外部验证已通过。 | 约定 + 测试 |
| **INV-7** | **失败安全。** 有效行情源少于阈值、模型超时、结构错误或风控不可用时，不产生新开仓；退出能力不依赖 LLM 在线。 | 代码 |
| **INV-8** | **七阶段固定顺序，缺阶段必须标 partial。** 不得用静态结论补齐。相同 card/candle/contract 的重试返回同一决策轮或幂等结果。 | 约定 + 测试 |
| **INV-9** | **平台密钥不进浏览器、日志、Git。** 界面永不回显明文。 | 约定 + secret scan |
| **INV-10** | **三端 audience 隔离。** 登录、Cookie、路由、权限、数据范围、审计全部按 audience 隔离；未知 Host 一律拒绝。 | 应用层（见「已知缺口」） |

### 数据库已强制的部分

`postgres/migrations/0022_ledger_approval_invariants.sql` 里已经有：

- `ledger_transactions` / `ledger_postings` / `ai_credit_ledger` / `deposit_provider_events`
  四张表 append-only（UPDATE/DELETE 触发器直接抛 `LEDGER_APPEND_ONLY`）
- 借贷平衡：`DEFERRABLE INITIALLY DEFERRED` 约束触发器，事务提交时校验借贷相等、至少两条分录、金额为正
- 币种一致性、幂等唯一索引、反向分录唯一约束
- postings 只能在所属 transaction 处于 `pending` 时写入
- credits 余额 `CHECK (balance_available >= 0)` 等三条

**不要绕过这些写资金表。** 直接 SQL 也绕不过——触发器会拒绝。

`postgres/migrations/0044_audit_tamper_evidence.sql` 补上了审计侧：

- `audit_logs` 哈希链（`chain_seq` / `prev_hash` / `row_hash`），插入时由触发器自动接链
- `audit_logs` 与 8 张 `*_decisions` 表 append-only，UPDATE/DELETE 抛 `AUDIT_APPEND_ONLY`
- `verify_audit_log_chain(from_seq, to_seq)` 返回空集表示区间完整；
  能检出内容改动与中间行删除，**但检不出链尾截断**（见已知缺口）

`*_decisions` 表是证明双人复核确实发生过的记录。**能伪造 decision 行，maker/checker 就形同虚设**——
这是 INV-3 的实际防线。

### GA 时会变化的一条

当前 PRD 明确「客户不上传交易所密钥、不托管客户资金」。
**GA 后平台将托管密钥并开放真实交易**，这一条届时反转。
在那之前，任何「接收客户交易所凭证」的代码都是越界的。
GA 的执行层必须是独立进程、独立网段、独立密钥托管——不要在 Web 层实现。

---

## 架构边界

### 三端 audience

| 应用 | Host | 端口 | 构建 |
| --- | --- | --- | --- |
| Client | `agentnovas.com` | 3000 | `RIVERTON_APP_AUDIENCE=client` → `.next-client` |
| Operations | `zht.agentnovas.com` | 3001 | `RIVERTON_APP_AUDIENCE=operations` → `.next-operations` |
| Maintenance | `xm.agentnovas.com` | 3002 | `RIVERTON_APP_AUDIENCE=maintenance` → `.next-maintenance` |

audience 由 Host 头解析（`lib/riverton-apps.ts`）。本地开发时 `localhost:PORT` 的端口必须与
`RIVERTON_APP_LOCAL_PORT` 一致，否则返回 `UNKNOWN_AUDIENCE`。

路由白名单在 `app/riverton-route-contract.ts`，**服务端在渲染前校验**。
注意：白名单与各 `*-app.tsx` 里的 if/else 分发是**两份真源**——加路由必须同时改两处，
只改白名单会让请求静默落到兜底页面（Client 会落到「资产与账本」）。

### 依赖方向

```
apps/*  →  packages/*  →  lib/
```

- 客户端应用不得 import 运营/运维的模块
- `app/layout.tsx` 被所有页面共享：**不要从 `"use client"` 模块里 import 常量**，
  整个模块（含其依赖）会被拖进所有页面的公共包。需要共享常量时抽独立的无 React 模块
  （参考 `packages/ui/src/theme-script.ts`）

### 已知缺口

- **三端编译同一份 API 面。** `app/api` 下 182 个路由，三个构建全都包含——
  公网盒子上跑着运维控制面的代码。目前靠 `lib/api-route-inventory.ts`（4933 行清单）
  + `lib/api-policy.ts` 的 fail-closed 校验兜底：未登记的路由抛 `POLICY_NOT_REGISTERED` 404，
  audience 不匹配抛 `ROUTE_NOT_AVAILABLE` 404。

  **inventory 是生成的，不要手改。** 加了新 API 后跑：

  ```bash
  node scripts/generate-api-route-inventory.mjs
  node scripts/generate-nginx-api-allowlist.mjs
  ```

  忘了重新生成，`npm test` 会失败（两个生成器都有 `--check` 模式，由测试调用）。
  运行时行为是安全的（404），但你会浪费时间找为什么新接口 404。

- **边缘已有第一道边界。** `deploy/nginx/generated/*.conf` 是从 inventory 生成的
  per-vhost `/api` 白名单，不属于本 vhost 的前缀在 Nginx 层就返回 404，不进 Node。
  用前缀树生成：只有整棵子树都属于该 audience 时才合并，否则逐条精确匹配——
  按 `/api/<group>/` 粗粒度合并会让公网 vhost 放行 RBAC 管理接口。
  **部署时这三个文件要放到 `/etc/nginx/riverton/generated/`。**
- **审计链尾可被截断。** 迁移 0044 后 `audit_logs` 有哈希链，改内容或删中间行都会被
  `verify_audit_log_chain()` 检出，但**截断链尾是链内校验无法自证的**——需要把链尾哈希
  定期外送到本库之外（备份、日志系统或运维端存档）。GA 前必须补这个运维动作。

---

## 改完必须跑什么

```bash
npx tsc --noEmit          # 类型
npm run lint              # ESLint
npm test                  # 776 项，node --test，不需要数据库
npm run test:apps         # 三端 production build
npm run quality:bundle    # 包体预算（见下，余量极小）
```

**动了任何客户端代码，`npm run quality:bundle` 是必跑的。**
Client 的 JS 预算余量只有约 160 字节（204,636 / 204,800）。
根因是公开落地页会下载约 14KB 它用不到的 Portal 外壳 JS——分包问题，未修复。

`npm run test:smoke` **当前是失败的，且改动前就失败**：它断言 `/` 返回「正在验证客户端会话」，
但 client audience 的 `/` 渲染的是公开落地页。这是断言过时，不是回归。不要为了让它通过而改产品行为。

---

## 已知陷阱

**测试里有大量「源码文本断言」。** 很多契约测试断言源文件里包含某个字符串
（例如 `assert.match(shell, /event\.key === "Tab"/)`）。重构改写法时会撞上。
撞上时要判断是「契约仍成立但写法变了」还是「真的破坏了契约」——
前者可以改断言，**后者绝对不行**。改测试断言必须在提交信息里说明原因。

**客户端外壳禁止复用内部控制台外壳。** `tests/riverton-ui-contract.test.mjs` 明确断言
`client-portal-shell.tsx` 中不得出现 `ConsoleShell` 或 `console-shell`，且不得有 `href: "/"`
（`/` 是公开落地页，已登录客户的品牌链接必须指向 `/dashboard`）。这是产品边界，不是代码洁癖。
注意断言是文本匹配——**连注释里写 `ConsoleShell` 都会失败**。

**登录页不得引用 Geist 网络字体。** login 路由与应用包隔离以保证 LCP，
`.rc-auth` 必须用 system-ui 字体栈。契约测试会检查。

**`color-mix(in oklch, 语义色 X%, 背景)` 在无彩色背景上会串色。** 背景 hue 为 0，
oklch 走极坐标插值会把绿色 tint（hue 162）拉成橙色。需要混色时用 `oklab`，
或直接为每个主题写死值。设计令牌层已经是写死值。

**`docs/review/SYSTEM_ASSESSMENT_2026-08-20.md` 的第 1–5 节是起点 `0762fa3` 的快照，
不是现状。** 文档开头有说明。引用它之前先去代码或迁移里验证——
里面列的很多缺陷（例如账本无 DB 保证）后来已经修复。

---

## 遗留代码：不要扩展

| 文件 | 状态 |
| --- | --- |
| `app/client-app.tsx`（2506 行） | 遗留 SPA，内部字符串路由，只服务 `/workspace`。**不要加新功能**，等 P4 拆成路由页面。 |
| `app/globals.css`（3871 行） | 已无人 import。历史遗留，不要引用。 |
| `app/globals-beta.css`（1922 行） | 只服务落地页与 `/workspace`。**不要往里加规则。** 它的 body 配色已限定为 `body:has([data-app-shell])`，改回全局会破坏浅色主题。 |
| `app/locale-guard.tsx` + `app/i18n-runtime.ts` | 全文档 MutationObserver 改写，与 React 冲突。只挂在 `/workspace`。**不要在新代码里使用**，多语言等 P4 换 `next-intl`。 |

新的样式一律走 `app/design-tokens.css` 的 `--rv-*` 令牌 + `app/riverton-console.css`
或 CSS Module。**新代码里出现硬编码色值就是错的。**

---

## 文档真源

改动前先确认在看哪一份：

- **产品边界**：`docs/product/PRD.md`、`docs/product/SEVEN_AGENT_TRADING_HALL.md`
- **系统边界**：`docs/specs/SYSTEM_SPEC.md`（当前态）
- **三端规格**：`docs/specs/{CLIENT,OPERATIONS,MAINTENANCE}_APP_SPEC.md`
- **接口**：`docs/api/API_CATALOG.md`、`docs/api/openapi-controlled-beta.yaml`（覆盖不全）
- **发布门禁**：`docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md`
- **决策记录**：`docs/adr/`
- **交接与变更历史**：`docs/DEVELOPMENT_HANDOFF.md`

`docs/创始人待办清单与真实交易闭环接入指南.md` 标记为 `RETIRED`，**禁止执行**。

领域参数（套餐价格、策略卡风控阈值、Demo provider）的唯一真源是
`packages/contracts/src/commercial-beta.ts`。**前端不得复制第二份常量。**

---

## 术语

- **决策轮 decision round**：七阶段一次完整执行，有唯一 `decisionRoundId` 和 `traceId`。
  每张策略卡一轮，扇出到所有订阅该卡的客户组合——不是每个客户一轮。
- **三张官方策略卡**：`ai_conservative` / `ai_balanced` / `ai_aggressive`，
  每位有效会员每张卡一个独立 10,000 USDT paper 组合。
- **paper**：服务器记账的模拟成交，不是真实持仓，盈亏不可提取。
- **平台 Demo**：平台自己在 OKX Demo / Binance Testnet / Bybit Demo 的测试账户，
  只用于生成技术证据，与客户 paper 物理隔离。
- **maker / checker**：发起人 / 复核人。同一单据两者必须是不同的人。
- **高水位线 high-water mark**：绩效分成的计费基准，只对超过历史最高权益的部分计费。
- **entitlement**：会员权益，含到期日、credits 配额、分成费率快照。
