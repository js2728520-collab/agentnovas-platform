# ADR-0019: GA 执行服务与密钥托管

状态：Proposed

日期：2026-08-22

## 背景

平台的目标形态是**真实交易 + 策略跟单**（根 `CLAUDE.md`）。当前 Beta 的
「实盘路由硬关闭、只跑 paper」是刻意的阶段性限制。GA 要接的是真实执行。

跟单是**非托管**的：客户连接自己的交易所账户，资金始终在客户账户里，平台用
客户的 API 密钥在客户账户上下单。`platform_strategy_subscriptions.capital_pct`
（默认 3%）决定每单占该客户资金的比例。

### 现状盘点

**已经就位的：**

- 域层产出 `OrderIntent`（纯值，带 `targetPositionRatio` 而非绝对数量，
  带决策轮溯源），`ExecutionPort` 是出站端口，`resolveOrderQuantity` 在扇出时
  按各组合资金与上限取更严格者换算。**域层不需要为 GA 改动。**
- INV-11 由数据库约束强制（迁移 0045）：
  `CHECK (withdrawal_authorized = 0 AND withdrawal_credential_ref IS NULL)`。
  密钥只能有读 + 交易权限。
- 决策轮已共享化（ADR-0018）：一轮判断扇出到 N 个订阅者，结构已就位。

**没有就位的，也是本 ADR 的中心问题：**

凭证用 AES-GCM 加密后**内联存在 `exchange_accounts.encrypted_credential_ref`**
（字段名有误导性，它不是外部保管库的引用，就是密文本身）。
密钥来自环境变量 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。

**任何同时拥有该环境变量与数据库读权限的进程，都能解密全部客户的交易凭证。**

而现在**公网面向客户的 Web 进程正是这样一个进程**：
`app/api/exchange-accounts/[id]/route.client.ts` 的 `check` 动作会调用
`decryptExchangeCredential` 去验证连通性。经构建产物核实，client 构建里有 4 条
`exchange-accounts` 路由（operations 与 maintenance 各 0 条）。

这与 `packages/domain/src/execution/execution-port.ts` 注释里写的设计意图直接矛盾：

> 真实执行必须跑在独立进程、独立网段，是全系统唯一能解密交易所凭证并签名的地方。

Beta 阶段只跑 paper，风险被限制在「凭证泄露但平台不下单」。GA 之后，
公网盒子被攻破一次 = 全部客户的交易权限被拿走。

## 决策

### 一、密钥离开 Web 层

`EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` **只存在于执行服务的进程环境里**。
三个 Web 应用都不再配置它，也不再 import `exchange-credentials.ts` 的解密函数。

Web 层现在有两处需要凭证，都改为委托：

| 现在 | 改为 |
| --- | --- |
| `exchange-accounts/[id]` 的 `check` 动作解密后自己验连通性 | 调用执行服务的内部接口，只拿回「权限位 + 状态」，不接触密文 |
| `trading-emergency-close.ts` 解密后直接下平仓单 | 调用执行服务的紧急平仓接口 |

由架构边界规则强制：`app/**` 与 `apps/**` 不得 import
`lib/exchange-credentials.ts` 的解密函数。这条能机器检查，不是约定。

### 二、执行服务的形态

一个独立的 Node 进程，与 Web 应用同仓库、独立部署单元：

- **不接受公网入站。** 只监听内网地址，只接受来自 Web 应用与 Runtime Worker
  的调用，凭共享密钥或 mTLS 认证。
- **是全系统唯一能解密凭证并对交易所请求签名的地方。**
- 出站只到交易所 API，按交易所维度限流。
- 日志永不打印明文凭证（INV-9），也不回显给任何界面。

它实现域层的 `ExecutionPort`：接收一批 `ExecutionRequest`，返回
`ExecutionReceipt[]`。域层零改动。

### 三、扇出的工程问题

跟单扇出与 paper 扇出是两回事：**paper 扇出是一次事务性记账（不会失败）；
跟单扇出是 N 次真实交易所 API 调用，每次都可能限流、部分成交、被拒、超时。**

一轮决策最多扇出到全部订阅该卡的客户账户。必须解决四件事：

**1. 限流池。** 按 (交易所, 账户) 与 (交易所, 全局) 两级令牌桶。各交易所的
限流口径不同（权重制、按端点、按 IP），配置从交易所文档取，不写死在代码里，
运维端可调。超出预算时排队而不是丢弃——丢弃等于客户没跟上这一轮。

**2. 幂等。** 交易所的 `clientOrderId` 由
`(decisionRoundId, portfolioId, action)` 确定性派生。重试落在同一个
`clientOrderId` 上，交易所自身会拒绝重复下单。这把「网络超时后不知道单是否已下」
从必须人工核对变成可自动恢复。

**3. 部分成交。** 市价单也可能部分成交。回执必须如实记录
`filledQuantity` 与 `averagePrice`，`outcome` 用 `partial`，
**不得四舍五入成 `filled`**。后续仓位与绩效结算都以回执为准。

**4. 对账。** 下单后必须查单确认，不能只信下单响应。查不到或状态不一致的进
`reconcile_wait`，由对账任务重试；超过阈值仍不一致则升级到运维端人工处理，
并暂停该账户的新开仓——**不确定状态下继续下单是最危险的**（INV-7）。

### 四、失败与降级

- **单个账户失败不影响其他账户。** 扇出是 N 个独立结果，不是一个事务。
- **交易所整体不可用时暂停该交易所的新开仓，但不阻断平仓。** 与引擎的
  `riskApproved = action === "exit" || ...` 一致：退出能力不依赖任何一层在线。
- **kill switch**：运维端可按交易所、按账户、按策略卡三个维度暂停新开仓，
  动作进审计并走 maker/checker。

### 五、绩效分成不变

分成仍从客户预充的服务余额扣除，走优盾充值 + ledger + 应收 + maker/checker
（INV-11）。执行服务**不碰资金**，它只下单和回执。真实交易的已实现盈亏进
高水位线计算，口径与 paper 一致（INV-5）。

## 结果

### 安全边界的实际变化

| | 现在 | GA 后 |
| --- | --- | --- |
| 能解密客户凭证的进程 | 公网 Web + 任何有环境变量的进程 | **只有执行服务** |
| 公网盒子被攻破的后果 | 全部客户交易权限（GA 后） | 无凭证可取 |
| 平台能否转走客户资金 | 否（INV-11，数据库约束） | 否（不变） |

### 风险与代价

- **多了一个部署单元。** 自托管环境要再管一个进程、一套内网认证、一份密钥。
- **Web 层的连通性检查变成跨进程调用。** 延迟增加，且执行服务不可用时
  客户无法验证账户——必须显式显示「验证服务不可用」，不能显示「验证失败」
  （INV-6）。
- **对账是持续运维成本。** 不是一次性工程。

### 未决问题

1. **执行服务与 Web 之间的认证方式**：共享密钥（简单，密钥轮换靠人）
   还是 mTLS（复杂，但轮换可自动化）。自托管单机场景下共享密钥可能够用。
2. **凭证是否再上一层保管库**（如 age/sops + 启动时注入，或 Vault）。
   当前方案把密钥收敛到一个进程，已经解决了最大的敞口；引入保管库是下一层，
   不应阻塞本 ADR。
3. **首批支持哪些交易所**。三个 Demo provider 是 OKX / Binance / Bybit，
   但真实交易的接入顺序应按客户实际持仓分布定，不是按 Demo 顺序。

## 实施顺序

1. **把密钥从 Web 层拿掉**（不需要执行服务就能做的部分）：
   `check` 与紧急平仓改为委托，加架构边界规则禁止 Web 层 import 解密函数。
   此时委托目标可以先是同进程的一个内部模块，把调用形状先定下来。
2. **抽出执行服务进程**：同一份代码换个入口独立跑，内网监听 + 认证。
   Web 层改为跨进程调用。
3. **实现 real `ExecutionPort`**：限流池、幂等 `clientOrderId`、部分成交回执。
4. **对账任务与 `reconcile_wait` 状态机**。
5. **kill switch 与运维界面**。
6. **打开实盘路由**（移除 `assertBetaSpotRuntimeLease` 的硬关闭），
   按交易所逐个灰度。

### 关于第 1 步收益的更正

本 ADR 初稿写的是「第 1 步就能显著缩小敞口」。**实施后实测，这句话是夸大的。**

第 1 步之后，`lib/execution/credential-access.ts` 仍与 Web 应用同进程，客户端服务端
构建里依然含解密代码并引用 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`（实测 3 个 chunk）。
**敞口没有变化。**

第 1 步实际达成的是三件事，都不是「缩小敞口」而是「让缩小敞口成为可能」：

1. 解密点从 3 处收敛到 1 处（此前是 `exchange-accounts/[id]`、
   `trading-emergency-close`、`research-exchange-account`）；
2. 架构边界规则第 8 条阻止新的解密点出现——包括阻止 Web 层重新直接解密；
3. 调用形状定成了 RPC-ready：只传 id、只拿回非机密结果，第 2 步换成跨进程调用时
   上层零改动。

**敞口的实际消除在第 2 步。** 它的验收标准是可机器检查的：

```bash
# 三个 Web 构建的服务端产物里都不应再出现这个名字
grep -rl EXCHANGE_CREDENTIAL_ENCRYPTION_KEY .next-client/server .next-operations/server .next-maintenance/server
```

在那之前，「Web 进程持有全部客户交易凭证的解密能力」这条已知缺口保持有效。


## 第 2 步实施记录（已完成）

### 内网认证：共享密钥

`EXECUTION_SERVICE_SHARED_SECRET`，请求头 `x-riverton-execution-auth`，
用 `timingSafeEqual` 等长时间比较。密钥缺失或短于 32 字符时**执行服务拒绝启动**，
而不是「没配就不鉴权」——后者在部署漏配时会静默变成任何人都能调用的下单接口。

它与 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` 是两把不同的密钥，做两件不同的事：

| | 凭证加密密钥 | 共享密钥 |
| --- | --- | --- |
| 作用 | 加密/解密客户交易所凭证 | 证明请求来自我们自己的进程 |
| 泄露后果 | 加数据库读权限 = 全部客户的 API Key | 能让服务替他下单，但拿不到凭证 |

执行服务是全系统唯一能解密的地方；若内网上任何东西都能调它，把加密密钥搬过去就
没有意义。爆炸半径不同，所以分开存放、分开轮换。

### 三件实施中才暴露的事

**一、只搬解密是不够的——加密也得搬。** 第一次构建后 `decryptExchangeCredential`
确实消失了，但客户端产物里仍然引用凭证密钥：绑定交易所账户时 Web 层要**加密**
凭证。AES-GCM 是对称的，**能加密就能解密**——解密代码不在构建里没有用，密钥在
就够了。绑定流程因此也进了执行服务（`bind_exchange_account`）。

需要诚实说清这一步换来了什么：明文凭证仍然流经 Web 进程，因为它是客户从公网提交
上来的，无法避免。变化的是**一次一个账户的短暂明文**与**一把能解开全部账户、
长期有效的密钥**之间的差别。

**二、运维端有一条回退路径直通交易所密钥。** `lib/integration-credentials.ts`
原本写 `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY || EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。
只要前者漏配，运维端就持有交易所凭证密钥——而它从不需要解密任何客户的交易凭证。
回退已删除，该密钥现在是必配项。

*迁移*：若既有集成凭证是用交易所密钥加密的，把同一个值显式配成
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` 即可继续解密。但这只是让两把密钥**可以**
分开，不等于已经分开——应尽快用一个独立值重新加密。

**三、错误消息是对外表面。** 首次跑通时服务把 `error.message` 原样回给 Web 层，
而 Drizzle 的失败消息带着完整 SQL 与参数——库表结构和客户/账户 id 就这样从一个
面向公网进程的接口吐了出去。改成白名单：只有列明的错误身份原样回传，其余折叠成
`INTERNAL_ERROR`，详细原因只进本进程日志。

### 数据库身份

执行服务拿到独立角色 `agentnovas_execution_service`，由
`RIVERTON_EXECUTION_SERVICE=true` 声明，仍走既有的「角色必须匹配进程身份」校验。
让它冒用 client 角色会使数据库层面再也分不清「客户端 Web 读了凭证密文」和
「执行服务读了凭证密文」。

**下一步的自然延伸**：把 `exchange_accounts.encrypted_credential_ref` 的列权限从
三个 Web 角色上收回。那之后 Web 层连密文都取不到，「拿不到凭证」将由数据库强制，
而不再依赖构建产物的洁净。

### 验收（已通过，且是机器检查）

```bash
npm run quality:key-custody
```

扫描三个 Web 构建产物的全部 `.js`，出现凭证密钥名、解密函数名或**加密函数名**
即失败。查产物而不只查源码，是因为把解密拉回 Web 层的方式不止直接 import 一种——
多一条间接依赖、一次 re-export 都能让打包器把整条链塞回公网进程，而源码规则不会红。

当前结果：client 537 个 .js、operations 467 个、maintenance 377 个，**零命中**。
探针验证过这个检查器确实会报警（注入一处即 exit 1）。

架构边界规则第 8 条同步扩到三条子规则：不得解密、不得加密、Web 层不得引用
`lib/execution/server/**`。

### 部署要求

- 执行服务只监听回环或内网地址；代码里**拒绝**绑 `0.0.0.0` 和 `::`。Nginx 不为它
  配 server 块。
- 与 Web 分开的 systemd unit、分开的 `.env`、分开的文件权限。
- 三个 Web 的 `.env` 里**删除** `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。本地
  `start-local.sh` 已经主动 `unset` 它——只有本地同样拿不到，回归才会在开发时就炸掉。


## 第 3 步实施记录（已完成）

判定放域层（纯函数、可毫秒级单测），编排放执行服务：

| 位置 | 内容 |
| --- | --- |
| `packages/domain/src/execution/client-order-id.ts` | 幂等标识的确定性派生 |
| `packages/domain/src/execution/rate-limit.ts` | 两级令牌桶的排队时刻计算 |
| `packages/domain/src/execution/fill-accounting.ts` | 成交回执分类 |
| `lib/execution/server/rate-limit-pool.ts` | 桶状态保存与真实等待 |
| `lib/execution/server/live-execution-port.ts` | real `ExecutionPort` |

### 实盘仍然关闭

`LIVE_EXECUTION_ENABLED` 默认为假，此时**不向交易所发出任何请求**，但仍产出一条
`LIVE_ROUTING_DISABLED` 的回执——静默跳过会让上层以为下单成功了（INV-6）。
第 6 步才按交易所逐个灰度。现在把实现和单测做完，是为了让第 6 步只剩「打开开关」
一个动作，而不是在开实盘当天才第一次写这段代码。

### 三件实施中才发现的事

**一、`getOkxDemoOrder` 只能按 `ordId` 查，而超时场景永远拿不到 `ordId`。**
确定性 `clientOrderId` 的价值有两半：防重复下单，以及回答「那一单到底成没成」。
第二半需要按 `clOrdId` 查单——没有它，超时后只能人工去交易所后台核对。已补上
`clOrdId` 查询路径。

**二、单测抓到限流会在扇出场景失效。** 桶的时间线原本会被调用方的 `now` 拨回去。
扇出正是「在同一个 `now` 上一次性规划上千笔」，于是第 N 笔的等待从一个早已过去的
时刻起算，排队全被压缩到前面——限流恰好在它唯一存在的理由上失效。修法是桶的时间
线只能前进。

**三、`1 - 0.7 = 0.30000000000000004`。** 这个数会作为撤单/补单数量发给交易所，
而交易所按品种精度校验，多出来的尾数会让整笔请求被拒。剩余量收敛到 8 位小数。

### 一处需要更正的旧说法

`packages/domain/CLAUDE.md` 一度写着「`ExecutionPort` 的 paper 实现已存在」。
**实际上没有**：paper 记账走 `lib/official-paper-repository.ts`，从未经过这个端口。
于是 `resolveOrderQuantity` 注释里「好让 paper 与 real 用同一套换算」目前是意图而非
事实。把 paper 接到端口上是一次独立改造，不在本 ADR 范围内，已在域层文档里写明。

### 失败方向的取舍

下单抛错后先用 `clientOrderId` 查一次：

- 查到 → 用真实结果，超时被自动恢复；
- 查到「不存在」→ 判为未下单（`PLACE_FAILED`），可安全重试；
- 查询本身也失败 → `RECONCILE_WAIT`，**不当作没下单**。当作没下单会让重试重复
  下单，这是最危险的方向（INV-7）。该状态由第 4 步的对账任务接手。
