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
| **INV-7** | **失败安全。** 有效行情源少于阈值、模型超时、结构错误或风控不可用时，不产生新开仓；退出能力不依赖 LLM 在线。 | 代码 + 测试 |
| **INV-8** | **七阶段固定顺序，缺阶段必须标 partial。** 不得用静态结论补齐。相同 card/candle/contract 的重试返回同一决策轮或幂等结果。 | 约定 + 测试 |
| **INV-9** | **平台密钥不进浏览器、日志、Git。** 界面永不回显明文。 | 约定 + secret scan |
| **INV-10** | **三端 audience 隔离。** 登录、Cookie、路由、权限、数据范围、审计全部按 audience 隔离；未知 Host 一律拒绝。 | 应用层（见「已知缺口」） |
| **INV-11** | **平台永不持有客户交易所账户的提现权限。** 跟单只需读 + 交易权限；绩效分成从客户预充的服务余额扣除，走优盾充值 + ledger + 应收 + maker/checker 复核，平台不具备自动划扣能力。 | ✅ **数据库约束**（迁移 0045） |

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

### 目标形态：真实交易 + 策略跟单

**平台的设计目的就是真实交易，实现策略跟单。** 当前 Beta 的「实盘路由硬关闭、
只跑 paper」是刻意的阶段性限制，不是终态。跟单模型在 `0000` 号迁移里就已定型：

- **非托管。** 客户连接自己的交易所账户（`exchange_accounts`），资金始终在客户
  账户里，不归集到平台。平台用客户的 API 密钥在客户账户上下单。
- `platform_strategy_subscriptions.capital_pct`（默认 3%）决定每单占该客户资金的
  比例，`stop_loss_pct` 是止损线。
- **密钥只要读 + 交易权限，永远不要提现权限**（见 INV-11）。

因此执行层不是「GA 时再接的缝」，而是产品主干：
- 域层只产出 `OrderIntent`（纯值，不知道交易所、不知道凭证、不知道签名）
- 执行服务是唯一能解密凭证并下单的进程，独立网段，不接受公网入站
- **跟单扇出与 paper 扇出是两回事**：paper 扇出是一次事务性记账（不会失败）；
  跟单扇出是 N 次真实交易所 API 调用，每次都可能限流、部分成交、被拒、超时。
  5000 客户 = 一轮决策最多 5000 次外部调用，需要限流池、重试、部分失败处理与对账。

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

- **API 面已按 audience 物理拆分。** `app/api` 下的路由文件按归属命名，
  每个构建只登记自己那几个后缀为可路由扩展名（`next.config.ts` 的 `pageExtensions`）：

  | 文件名 | 归属 | 进哪些构建 |
  | --- | --- | --- |
  | `route.client.ts` | 客户端 | client |
  | `route.operations.ts` | 运营端 | operations |
  | `route.maintenance.ts` | 运维端 | maintenance |
  | `route.internal.ts` | 内部端 | operations + maintenance |
  | `route.shared.ts` | 三端共享 | 全部 |

  实测结果：client 87 条、operations 75 条、maintenance 56 条（此前三端各 182 条）。
  **别的 audience 的路由不是被拒绝，是根本不在这个构建里。**

  **加新 API 必须带后缀**，裸 `route.ts` 会被架构边界检查拒绝。后缀与
  `lib/api-route-inventory.ts` 的 audience 必须一致，不一致也会红——
  后缀决定进哪个构建，清单决定运行时放行谁，两者错开就会出现
  「构建里有但运行时拒绝」或「运行时允许但构建里没有」。

  运行时的 fail-closed 校验保持不变：`lib/api-policy.ts` 对未登记路由抛
  `POLICY_NOT_REGISTERED` 404，audience 不匹配抛 `ROUTE_NOT_AVAILABLE` 404。

  **inventory 是生成的，不要手改。** 加了新 API 后跑：

  ```bash
  node scripts/generate-api-route-inventory.mjs
  node scripts/generate-nginx-api-allowlist.mjs
  ```

  忘了重新生成，`npm test` 会失败（两个生成器都有 `--check` 模式，由测试调用）。

- **边缘已有第一道边界。** `deploy/nginx/generated/*.conf` 是从 inventory 生成的
  per-vhost `/api` 白名单，不属于本 vhost 的前缀在 Nginx 层就返回 404，不进 Node。
  用前缀树生成：只有整棵子树都属于该 audience 时才合并，否则逐条精确匹配——
  按 `/api/<group>/` 粗粒度合并会让公网 vhost 放行 RBAC 管理接口。
  **部署时这三个文件要放到 `/etc/nginx/riverton/generated/`。**
- **官方现货是「每个 (客户, 策略卡) 一个部署」，不是「每张卡一轮扇出」。**
  5,000 会员 × 3 张卡 = 15,000 个部署，各自跑决策周期——这与本文档「决策轮」术语
  里写的「每张策略卡一轮，扇出到所有订阅该卡的客户组合」**不一致**，实现是前者。

  行情请求已经收敛：三张卡合计只有 6 种 (品种, 周期) 组合，
  `lib/strategy-runtime-worker.ts` 有进程内复用缓存，判定规则在
  `packages/domain/src/runtime/market-cache.ts`（按 K 线桶失效，不是固定 TTL）。

  **仍未解决的是决策轮本身的数量**：15,000 个部署意味着每根 K 线 15,000 次
  租约/心跳/完成事务和 15,000 行决策记录，而其中只有 6 份不同的判断。
  真正的修法是让决策轮按 (卡, 品种, 周期) 产生一次，再扇出到订阅该卡的组合。
  这会改动 INV-8 的决策轮模型，需要单独规划。

- **共享决策轮里不得出现任何客户数据。** 同一张策略卡在同一根已收盘 K 线上只判断
  一次（ADR-0018），该轮的七阶段叙述展示给订阅这张卡的所有客户。

  **卡级结论必须用 `neutralRuntimeRiskState()` 算**。用某位客户的真实风控状态算，
  risk 阶段的 evidence 里就会带上那位客户的回撤、当日亏损、连续亏损与熔断状态，
  然后展示给其他所有人。这不是理论风险——实施 ADR-0018 期间实际发生过。

  组合级准入用各自真实的状态单独算，写在该客户自己的 `strategy_runtime_cycles`
  行上。引擎是纯函数，跑两次的代价是亚毫秒级。
  由 `tests/strategy-runtime-repository.test.mjs` 断言共享轮的 risk 证据是中性状态。

- **公网 Web 进程当前能解密客户交易所凭证。** 凭证是 AES-GCM 密文内联存在
  `exchange_accounts.encrypted_credential_ref`（字段名有误导性，不是外部保管库的
  引用），密钥来自环境变量 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。
  `app/api/exchange-accounts/[id]` 的 `check` 动作会解密——该路由在 client 构建里。

  Beta 只跑 paper 时风险被限制在「凭证泄露但平台不下单」。
  **GA 打开实盘前必须把密钥从 Web 层拿掉**，见
  `docs/adr/0019-ga-execution-service-and-key-custody.md`。

  **已完成（ADR-0019 第 1、2 步）**：凭证的加解密都发生在独立的执行服务进程
  （`scripts/execution-service.mjs`，唯一持有 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`
  的进程）。三个 Web 应用不再需要那个环境变量，构建产物里也不含加解密代码。

  Web 层只能通过 `lib/execution/client.ts` 发内网请求，用
  `EXECUTION_SERVICE_SHARED_SECRET` 鉴权。那是**另一把**密钥：它证明「请求来自我们
  自己的进程」，不参与加密；泄露它能让服务替人下单，但拿不到凭证。两者分开轮换。

  三条容易写错的地方：

  - **只挡解密没用。** AES-GCM 对称，能加密就能解密。绑定账户时的加密也必须在执行
    服务里做，否则 Web 层照样持有密钥。
  - **明文凭证仍会流经 Web 进程**（客户从公网提交，无法避免）。这一步换来的是
    「一次一个账户的短暂明文」而不是「一把能解开全部账户的长期密钥」——别把它
    说成「Web 层再也见不到凭证」。
  - **执行服务的错误消息是对外表面。** 只有白名单里的错误身份能原样回传，其余
    折叠成 `INTERNAL_ERROR`；Drizzle 的原始报错带着完整 SQL 和参数。

  验收是机器检查，不是文档承诺：

  ```bash
  npm run quality:key-custody
  ```

  **实盘路由的现状**：授权机制就位（`execution_live_routing` 按 (交易所, 环境)
  逐条批准，开通走 maker/checker、关停单人即时，运维端有界面）；记账链路也已接通
  ——实盘成交进仓位表、进风控读数、进分成口径，两家交易所都有实盘适配器。

  曾经挡住实盘的五处**意外** fail-closed（租约过滤、边界断言、requestedPrice
  恒 null、symbol 格式、无创建入口）已经拆掉。它们逐个看都像普通条件，逐个改都像
  修 bug——把闸门收敛成一道有名字的，正是为了不再靠意外来保证安全。

  **实盘仍然关着，但现在只由一道命名闸门关着**：`isLiveExecutionReady()`。
  想开实盘先读 `packages/domain/src/execution/live-readiness.ts` 的
  `LIVE_EXECUTION_BLOCKERS`，剩下三条分别是余额核对缺失、客户侧开通入口缺失、
  从未对真实交易所下过一单。清单不是开关：清空它之前每条都要有实现和测试。

  **即使清单清空，默认也不会产生任何真实订单**，还需同时满足三件事：
  `execution_live_routing` 有 granted 授权、部署 `mode = 'live'` 且绑定可交易账户、
  无命中熔断且无未决对账。任一不满足都产出明确的拒绝回执，不静默跳过。

  记账上有两条容易写反：**模拟盘与实盘是同一本账**（只差 `book` 维度与本金），
  以及**事实取自回执与对账的归一判定**（`resolveEffectiveFill`），未决时什么都
  不记——记成成交会凭空造出仓位，记成未成交会让引擎继续开新仓。
  详见 `packages/domain/CLAUDE.md`。

  官方现货卡没有止损价（退出靠 DSL 条件），真实下单的保护性止损由
  `riskPerTradePct / maxAssetAllocationPct` 推导——这是把已有的风控预算换算到价格
  上，不是新增规则。止盈留空，编一个会在条件未满足时提前平仓。

  两条不许做成配置项的规则：**只有现货可路由**、**平仓不受任何限制**。
  `lib/beta-legacy-runtime-guard.ts` 挡的是永续不是实盘，不要因为要开实盘而移除它。

- **nginx 配置有闸门了。** `deploy/nginx` 曾经从未被 `nginx -t` 跑过一次，而它是三端
  隔离的第一道（每个 vhost 的 /api 白名单）。现在：

  ```bash
  npm run quality:nginx
  ```

- **审计锚点必须导出到库外。** 0049 的锚点让「链尾被截断」在库内可被发现，但
  `verify_audit_chain_anchors()` **只遍历库里还存在的锚点**——把审计行和对应锚点
  一起删掉，它会返回「干净」。被删掉的锚点不会替自己发声。

  ```bash
  npm run audit:anchors:export > anchors.json   # 存到数据库角色够不着的地方
  npm run audit:anchors:verify anchors.json     # 回验才是这套机制的价值
  ```

  一份从没被回验过的导出件只是一个文件。配 `AUDIT_ANCHOR_EXPORT_KEY` 后导出件带
  HMAC 签名；不配时导出件明确标注 `signed: false`，回验会说明它只证明了数据库侧
  未被篡改。

  需要 Docker。Docker 不可用时它 **exit 2 并明说「这不是通过」**——一个「查不了就
  算过」的闸门等于没有闸门。

  那 8 条 `listen ... http2` 弃用警告**是刻意保留的**，不要「顺手修掉」：
  `http2 on;` 要求 nginx ≥ 1.25.1，而 Ubuntu 22.04 (1.18)、Ubuntu 24.04 (1.24)、
  Debian 12 (1.22) 都更旧，在那里它是**致命错误**。nginx 跑在宿主机上而不是容器里，
  版本由发行版决定。新版本上的一条警告，好过旧版本上的起不来。

- **审计链尾锚定已就位，但归档到库外还没做。** 迁移 0044 的哈希链检不出截断链尾
  ——把最后 N 行删掉，剩下的链依然自洽。迁移 0049 增加 `audit_chain_anchors`：
  把当时的链尾（`chain_seq` + `row_hash` + 总行数）登记成锚点，
  `verify_audit_chain_anchors()` 校验锚定行是否还在、哈希是否一致、行数是否变少。

  锚点自身 append-only。运维端接口 `/api/maintenance/audit/anchors`
  （GET 列出并校验，POST 登记）。

  **仍未做的是把锚点导出到库外。** 锚点存在同一个库里，有完整写权限的人可以先删
  触发器再连锚点一起删。真正的防线是定期外送——备份、运维端存档或外部日志系统。
  **GA 前必须补这个运维动作。**

  接口的 `status` 有三个值，不要合并：`not_anchored`（没有锚点 = 没有保护）、
  `verified`（校验通过）、`violated`（发现截断或篡改）。
  把前两者都当成「没问题」会让「没有保护」看起来像「验证通过」（INV-6）。

---

## 本地开发环境

一次性准备：

```bash
createdb agentnovas_dev
npm run postgres:migrate
ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local --experimental-strip-types scripts/dev/provision-local-roles.mjs
ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local --experimental-strip-types scripts/dev/bootstrap-local-admin.mjs <邮箱> <密码>
```

日常启停：

```bash
bash scripts/dev/start-local.sh        # 3010 客户端 · 3011 运营端 · 3012 运维端
bash scripts/dev/start-local.sh stop
```

三个必须知道的点：

- **三端各用自己的数据库角色。** `lib/postgres.ts` 强制「连接串角色 == audience」，
  迁移 0040/0043 的 RLS 也按 `current_user` 判定。用超级用户连会直接报
  「Web DATABASE_URL 数据库角色与 RIVERTON_APP_AUDIENCE 不匹配」。
- **`RIVERTON_APP_LOCAL_PORT` 必须与实际端口一致**，否则 audience 解析返回
  `UNKNOWN_AUDIENCE`（Host 头解析是刻意 fail-closed 的）。
- **zsh 陷阱**：`"$role:localdev"` 会被当成参数展开修饰符 `:l`（小写化），
  连接串静默损坏成 `<role>ocaldev`，而且错误信息只说「角色不匹配」，很难联想到。
  写连接串一律用 `"${role}:..."`。

内部端（运营/运维）强制 MFA。`getPostgresPool` 会缓存首次失败的 Promise，
所以连接串配错时改完必须重启进程，热重载不会恢复。

## 改完必须跑什么

```bash
npx tsc --noEmit          # 类型
npm run lint              # ESLint
npm test                  # 776 项，node --test，不需要数据库
npm run test:apps         # 三端 production build
npm run quality:bundle    # 包体预算（见下，余量极小）
npm run quality:boundaries # 架构边界（跨端 import、资金写入口、遗留扩散、硬编码色值）
```

架构边界检查也在 `npm test` 里跑。**它变红时先问为什么跨过了那条线，不要直接把规则改宽**——
这些边界是替代 code review 的，单人 + AI 协作没有第二双眼睛。

**动了任何客户端代码，`npm run quality:bundle` 是必跑的。**
Client 的 JS 预算余量只有约 160 字节（204,636 / 204,800）。
根因是公开落地页会下载约 14KB 它用不到的 Portal 外壳 JS——分包问题，未修复。

`npm run test:smoke` 起一个生产 Next 服务，断言客户端的**两个入口**都能服务端渲染：
`/` 是公开落地页（必须有七阶段决策链，且不得混入门户外壳），
`/dashboard` 是门户（未登录时渲染会话验证态）。它会先跑 `build:client`，比较慢。

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

**`next dev` 与 `next build` 抢同一个 `distDir`。** 三端的 dev server 和生产构建
都用 `.next-<audience>`（`next.config.ts` 按 `RIVERTON_APP_AUDIENCE` 设定）。
本地开着 `scripts/dev/start-local.sh` 时跑 `npm run test:apps`，构建会随机失败，
而且错误信息和真正的编译错误长得一样。**跑三端构建前先 `start-local.sh stop`。**

**catch-all 路由下的 layout 不跨导航保留。** 三端都挂在 `app/[...segments]` 下，
实测（生产构建）Next 对 catch-all 段的不同取值当作不同路由匹配，会把该层的
`layout.tsx` 一起重挂——只有**根 layout** 保留。所以应用外壳挂在 `app/layout.tsx`
（经 `app/audience/current-frame.tsx` 按 audience 分流），不要往 `[...segments]`
那层加 layout 指望它持久。

**根 layout 里的外壳必须 `next/dynamic` 懒加载。** 根 layout 被所有页面共享，
静态 import 会把整套外壳打进公开落地页和登录页的包。客户端 JS 预算余量只有
约 3KB，这一条踩了直接超标（我踩过一次：+2,957 字节）。

**`docs/review/SYSTEM_ASSESSMENT_2026-08-20.md` 的第 1–5 节是起点 `0762fa3` 的快照，
不是现状。** 文档开头有说明。引用它之前先去代码或迁移里验证——
里面列的很多缺陷（例如账本无 DB 保证）后来已经修复。

---

## 遗留代码：已清零

P4 之后仓库里没有需要围住的遗留件了。已删除：`app/client-app.tsx`(2506)、
`app/globals.css`(3871)、`app/globals-beta.css`(1922)、`app/locale-guard.tsx`、
`app/i18n-runtime.ts`、`app/market-terminal.css`、`app/agent-role-admin.css`、
`app/community-strategy-center.tsx`、`app/strategy-detail.tsx`、`/workspace` 路由及其外壳。

架构边界规则「遗留代码不扩散」的清单因此是空的——**机制保留**，将来若再引入需要
围住的遗留件，在 `scripts/quality/check-architecture-boundaries.mjs` 的 `legacy`
表里加一条并把探针测试加回来。

**落地页有两处 zh-CN 真源。** `client-public-landing.tsx` 里的 `initialLocaleData`
是首屏内联副本（避免加载整个语言包），`client-public-landing-locales.ts` 是其余
6 种语言。**改中文文案要同时改两处**，否则中文与其它语言会不一致。

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
