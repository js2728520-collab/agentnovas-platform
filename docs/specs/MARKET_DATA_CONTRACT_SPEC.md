# 多市场行情统一合同规格

状态：`TARGET/PARTIAL_CURRENT`；T2.1a/T2.1b/T2.2a/T2.3a/T2.11a 已实现，真实供应商接入与有状态切换仍受 P-01/P-03 和后续 Gate 阻断
日期：2026-08-24
上位真源：`../product/PRD.md` 第 6 节；`V3_SYSTEM_TARGET_SPEC.md` 第 5 节；ADR-0021；需求方确认书 V1.1

## 1. 目标

建立不依赖具体供应商的行情合同，使 Client、Research、Runtime 和后续 Maintenance 数据源目录使用同一组市场、供应商、标的、交易日历、能力、授权和事件元数据，并满足：

- UI 不再根据 Binance、Yahoo 或其他供应商特例推断市场能力。
- 每个标的使用平台 canonical instrument ID，并显式保存 provider symbol 映射。
- 每个市场显式声明 IANA 时区、交易日历、支持能力、协议和数据用途。
- 行情事件携带 provider、exchange time、receive time、sequence 和服务端派生的新鲜度。
- 陈旧、超延迟或非法行情只能展示，不能触发新的自动开仓。
- 当前 API 采用向后兼容的加法式升级，不移除或改义既有字段。

本规格只统一数据合同与安全判定。它不选择真实供应商、不保存供应商密钥、不实现 WebSocket、不迁移生产数据，也不能打开真实订单或资金出站能力。

## 2. 已确认范围、假设与开放项

### 2.1 已确认范围

1. 行情目标市场包括加密货币、A 股、港股、韩股、日股、外汇和贵金属；A/HK 优先，KR/JP 后续。
2. 加密货币支持账户一致源、独立选择和策略级绑定；无已配置源时 Coinbase 是目标 fallback。
3. 实时链路目标为正常端到端延迟不高于 500ms、断线恢复不高于 10 秒；目标值必须可观测，不能冒充当前健康事实。
4. UI 显示数据源、更新时间和连接状态；主源失败后只有通过 symbol、时间、价格和完整性校验的备源才可接管。
5. 缓存陈旧数据只允许展示，不得触发新开仓。
6. 股票供应商由授权、质量、稳定性和成本共同决定；没有供应商与授权结论时不得虚构可用能力。

### 2.2 本切片假设

- T2.1a 定义值类型、严格运行时校验和新鲜度安全派生规则。
- T2.1b 只把当前静态行情目录映射到新合同，并向 `/api/market/instruments` 增加版本化元数据；保留 `instruments/updatedAt/source` 既有字段。
- 当前公共 Yahoo/Binance 数据路径统一标记为 `display/research`，不声明生产授权，也不具备 execution eligibility。
- 时间戳统一为 ISO 8601 UTC；市场时区使用 IANA timezone；交易日历以稳定 ID 引用，不在浏览器复制节假日规则。
- A/HK/KR/JP 仅在合同 taxonomy 中预留合法值，不在当前 API 虚构 provider 或 instrument availability。
- WebSocket sequence、缓存、重连、主备切换与 provider preference 分别由 T2.2/T2.3 实现。

### 2.3 仍需确认或外部证据

- P-01：首期加密交易所优先顺序、账户一致源与 Coinbase fallback 的精确优先级。
- P-03：A/HK/KR/JP 供应商、授权范围、数据保存/再分发条件与 SLA。
- 每个供应商的 symbol、复权、停牌、交易日历和流量限制 fixture。

这些开放项阻断真实 provider 注册和上线，不阻断纯合同、当前兼容目录与失败关闭规则。

## 3. 领域合同

### 3.1 稳定标识

- `providerId`：平台内稳定、小写、连字符分隔的供应商 ID；不得使用展示名作为主键。
- `marketId`：平台市场 ID，例如 `crypto-global`、`equities-us`；市场与 provider 是多对多关系。
- `instrumentId`：平台 canonical instrument ID；provider symbol 只能作为映射，不能成为跨供应商主键。
- `calendarId`：交易日历稳定引用；日历类型为 `continuous/provider_managed/exchange_managed`。

ID 必须通过服务端 allowlist/格式校验。浏览器不能提交任意 provider ID 来改变 Runtime 或 Execution 的数据源。

### 3.2 市场与能力

市场描述至少包含：

```ts
type MarketDescriptor = {
  id: string;
  assetClass: "crypto" | "equity" | "forex" | "metal";
  region: "global" | "us" | "cn" | "hk" | "kr" | "jp";
  timezone: string;
  calendar: { id: string; kind: "continuous" | "provider_managed" | "exchange_managed" };
  capabilities: Array<"instrument_search" | "quote_snapshot" | "candle_history" | "realtime_stream">;
  protocols: Array<"rest" | "websocket">;
  usage: Array<"display" | "research" | "execution">;
  executionPolicy: "display_only" | "paper_only" | "live_gate_required";
};
```

数组去重并排序，未知枚举或未知字段失败。`executionPolicy` 只是能力上限，不能替代 named live Gate；即使为 `live_gate_required`，Gate 未通过仍不得发单。

### 3.3 供应商授权

Provider 描述把技术能力与授权分开：

- `authorization`: `public/licensed/customer_account`。
- `configured`、`connected`、`healthy` 分别表示配置、连接和健康，不能互相推导。
- `usage` 明确允许 display、research 或 execution；未知授权默认空集。
- `latencyTargetMs`、`reconnectTargetMs`、`staleAfterMs` 是已配置目标，不是实时观测结果。

当前兼容目录不把公共网页源登记为已授权生产 provider。真实 provider 注册必须同时提供授权、数据用途、目标、symbol fixture 和失败关闭证据。

### 3.4 标的与 symbol 映射

Instrument 描述至少包含 canonical ID、展示 symbol/name、asset class、market ID、quote currency 和 provider mappings。映射保存 `providerId/providerSymbol`，可附加 provider instrument ID；不得从字符串拆分猜测 base/quote、交易所或市场。

同一 `(providerId, providerSymbol)` 只能映射一个 canonical instrument。未知市场、未知 provider、重复映射和资产类别不一致全部失败关闭。

### 3.5 行情事件与时间

统一事件 envelope 至少包含：

```ts
type MarketDataEventEnvelope = {
  contractVersion: 1;
  providerId: string;
  marketId: string;
  instrumentId: string;
  sequence: string;
  exchangeAt: string;
  receivedAt: string;
  evaluatedAt: string;
  latencyMs: number | null;
  quality: "fresh" | "delayed" | "stale" | "invalid";
  canOpenPosition: boolean;
};
```

`sequence` 使用十进制字符串，避免 JavaScript 大整数丢失；不具备全局序列的 provider 仍需由 adapter 产生可比较的局部 cursor，并明确作用域。`latencyMs/quality/canOpenPosition` 只能由服务端根据已验证时间戳和阈值派生，禁止接受浏览器覆盖。

判定规则：

- 时间无效、接收早于交易时间且超过允许时钟偏差、接收时间晚于本次服务端评估时刻、阈值无效：
  `invalid`，禁止开仓。
- `evaluatedAt - exchangeAt >= staleAfterMs`：`stale`，禁止开仓。
- 未 stale 但 `receivedAt - exchangeAt > latencyTargetMs`：`delayed`，禁止自动新开仓。
- 只有时间合法且同时满足 latency/stale 阈值才为 `fresh`；这仍不代表 live Gate 已通过。

关闭仓位、撤单和事故处置不得简单复用“禁止新开仓”逻辑；由后续 Runtime/Execution 风控规格分别定义。

## 4. API 兼容合同

T2.1b 对现有 `GET /api/market/instruments` 做加法式扩展：

```json
{
  "contractVersion": 1,
  "markets": [],
  "instruments": [],
  "updatedAt": "2026-08-24T00:00:00.000Z",
  "source": "static-platform-catalog"
}
```

- 旧消费者继续读取原 `instruments/updatedAt/source`。
- instrument 原字段不删除、不改义；新增 canonical/market/calendar/capability 元数据由服务端目录派生。
- `markets` 只返回当前目录真实覆盖的市场，不把目标 taxonomy 伪装成可用市场。
- 响应使用 `cache-control: no-store` 或现有更严格缓存合同；错误不泄露 provider endpoint、密钥或授权正文。
- 后续 source preference/status API 另写合同并进入中央 API Policy；本切片不增加写 API。

## 5. 项目结构与代码风格

- `packages/contracts/src/market-data.ts`：可序列化公共类型、严格 normalizer 和新鲜度派生函数。
- `packages/contracts/src/market-source-arbitration.ts`：provider 无关的 symbol、时间、价格和 sequence 主备仲裁合同。
- `lib/market-catalog.ts`：当前平台市场目录与既有 instrument 的兼容映射。
- `lib/market-instruments.ts`：保留当前静态标的真源，不嵌入 provider 选择策略。
- `app/api/market/instruments/route.client.ts`：薄响应映射，保持旧字段。
- `tests/market-data-contract.test.mjs`：枚举、严格字段、时间/序列/安全派生边界。
- `tests/market-route-contract.test.mjs`：API 向后兼容和无虚构市场/provider。

公共 normalizer 返回新的不可变对象，不修改入参。例如：

```ts
const quality = evaluateMarketDataFreshness({
  exchangeAt,
  receivedAt,
  evaluatedAt,
  latencyTargetMs,
  staleAfterMs,
});
```

合同使用仓库既有 lower snake-case 枚举风格；所有未知字段、重复数组成员、非 IANA timezone、非有限阈值和不合法时间戳在边界拒绝。禁止 provider 特例进入 Client 组件。

## 6. 命令与测试策略

- RED/GREEN 定向合同：`node --test --experimental-strip-types tests/market-data-contract.test.mjs tests/market-stream-state.test.mjs tests/market-source-arbitration.test.mjs tests/market-route-contract.test.mjs`
- 既有行情回归：`node --test --experimental-strip-types tests/market-content-freshness.test.mjs tests/market-data-snapshots.test.mjs tests/market-route-contract.test.mjs`
- 全量：`npm test`
- 类型：`./node_modules/.bin/tsc --noEmit`
- Lint：`npm run lint`
- 架构/安全：`npm run quality:boundaries && npm run quality:key-custody && npm run quality:nginx && npm run quality:secret-scan && npm audit --omit=dev --audit-level=high`
- 三端 production build：只在 `ssh an-saas` 的 Node 22.21+ 隔离目录执行。
- 浏览器：若本切片改变 Client 可见 UI，则使用本地 production standalone + 真实 Chromium 回归 `/market` 和三端空浏览器登录；纯 API 加法且 UI 未消费时记录为不触发 UI 专项，但三端登录 Gate 在完整阶段收口时仍强制执行。

测试覆盖：未知/重复字段、ID、枚举、timezone、序列、未来时间、时钟偏差、latency/stale 边界、服务端派生 `canOpenPosition`、旧响应字段、当前目录一致性以及目标市场未被虚构为当前可用。

## 7. 边界

**始终执行：** 服务端严格校验；canonical ID；IANA timezone；UTC timestamp；授权与健康分离；陈旧/非法/超延迟行情阻断自动新开仓；API 向后兼容；失败关闭；测试、类型、Lint、架构与安全门禁。

**需要另行确认：** 真实 provider 选择与优先级、授权/再分发范围、每市场 SLA、symbol/复权/日历 fixture、客户账户一致源和独立源冲突优先级。

**绝不执行：** 用 UI/provider 展示名作为稳定主键；从 symbol 字符串猜测市场；把 configured 当 healthy；把 latency 目标当实测；把公共源写成已授权生产源；让浏览器提供 `canOpenPosition`；通过行情合同绕过 live、资金或发布 Gate。

## 8. 分片完成标准

### T2.1a

- 公共类型、严格 normalizer 和新鲜度派生规则完成。
- 合法/非法 fixture、边界时间和陈旧阻断 RED/GREEN 通过。
- 无 provider 特例、数据库、网络或外部副作用。

### T2.1b

- 当前静态目录映射为统一市场/标的合同。
- instruments API 保持旧字段并增加 `contractVersion/markets`。
- 不返回虚构的 A/HK/KR/JP provider 或可用 instrument。
- 定向、全量、TypeScript、Lint、架构、安全与云端三端构建通过。

T2.1a/T2.1b 完成只把 M-01 提升为 `CURRENT` 的合同底座；真实 provider、WebSocket、主备切换和 G2 仍分别属于后续任务。

## 9. T2.1a/T2.1b 实施结果

2026-08-24 已完成 provider 独立公共类型、严格 market/provider normalizer、版本化事件 envelope
和服务端新鲜度派生。未知字段、重复能力、非 IANA 时区、不规范 ID/sequence、无界数组、非法
目标阈值和浏览器伪造 `quality/canOpenPosition` 均在边界拒绝；非法、超延迟或 stale 行情只会
得到 `canOpenPosition=false`。这是新开仓资格的必要条件，不替代 Runtime 风控或 named live Gate。

当前 40 个静态标的映射为 `crypto-global/equities-us/forex-global/metals-global` 四个当前市场，
只声明 REST、display/research 和 `display_only`。公共 Binance/Yahoo 映射使用稳定 provider ID，
不声明生产授权、WebSocket 或 execution。A/HK/KR/JP 只保留类型 taxonomy，没有在当前 API
虚构 provider、市场或标的。

`GET /api/market/instruments` 保留既有 `instruments/updatedAt/source` 字段和值，并加法式增加
`contractVersion/markets` 及 instrument canonical 元数据；现有 Client 继续读取原字段。定向
22/22、全量 1348/1348、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、secret scan、
production dependency audit 和云端三端 production build 均通过。云端真实 nginx 语法通过；
已知 `listen ... http2` 兼容警告按现有脚本保留。本切片没有 UI 消费变化，按第 6 节不单独重跑
视觉专项；未启动服务、未迁移数据库、未推送、未部署。

## 10. T2.2a provider 独立行情流状态机

T2.2a 只定义纯 sequence、连接、新鲜度、重连和缓存判定，不打开 socket 或选择 provider：

- sequence 是最多 128 位的 canonical 非负十进制字符串，使用 `BigInt` 比较，不转换为 Number。
- cursor scope 固定为 `providerId/marketId/instrumentId`；scope 不同必须由 adapter 建立新 cursor，
  不能把浏览器传入的 stream ID 当成 sequence reset 授权。
- 同 scope 只接受严格递增 sequence；相同为 duplicate，更小为 out-of-order，两者都不推进 cursor。
- 连接状态由 `connected/lastAcceptedAt/evaluatedAt/staleAfterMs/reconnectStartedAt` 派生为
  `connecting/live/stale/reconnecting/offline/invalid`，不能由 UI 自报 live。
- 重连采用确定性指数退避并封顶 10 秒；10 秒是单次重试间隔上限和恢复目标，不伪造实际恢复成功。
- cache timestamp 合法时允许 display；达到 stale 阈值后明确 `displayOnly=true` 且
  `eligibleForNewPosition=false`；时间非法时连展示资格也拒绝。

完成标准：纯函数没有 I/O/时钟读取；所有时间由调用方传入；覆盖大整数、重复、乱序、scope、
阈值等号、未来时间、重连上限和 stale cache。T2.2a 完成不代表 WebSocket、主备或 G2 完成。

实施结果（2026-08-24）：`packages/contracts/src/market-stream.ts` 已提供 sequence cursor、cache
使用资格、连接状态和确定性重连退避。`streamFreshEnoughForAdmission` 只是进入 Runtime 风险 Gate
的必要条件，不是开仓授权；调用方仍必须执行策略、账户、行情质量和风险检查。9 项定向测试、
全量 1357/1357 及本地质量门禁通过。该实现没有 socket/provider adapter、网络 I/O、数据库或 UI
变化，未声称达到 ≤500ms、10 秒实际恢复、主备切换或 G2。

## 11. T2.3a provider 无关主备行情仲裁合同

T2.3a 只实现一次仲裁周期的纯确定性合同，不建立网络连接、不选择真实供应商，也不把本切片
冒充完整主备运行系统：

- 调用方显式提供同一 canonical market/instrument 的有序 source policy；数组顺序就是主源到
  备源优先级。合同不写死 Binance、Coinbase、股票或其他 provider 顺序。
- 每个 source policy 固定 `providerId + providerSymbol`；候选事件必须同时匹配 canonical
  market/instrument 和精确 provider symbol，不能从展示 symbol 猜映射。
- 每个候选使用统一事件 envelope 的服务端时间、新鲜度和 `canOpenPosition` 派生；浏览器不能
  自报 quality、latency、sequence reset 或开仓资格。
- 每个 provider 的前序 cursor 独立校验；duplicate、out-of-order 和 scope mismatch 候选不能
  接管。provider 特有 gap/reset/replay 规则仍等待真实 fixture，不在公共合同中猜测。
- 价格只接受有界的正十进制字符串并用整数缩放比较，不能经过 JavaScript 浮点。调用方必须显式
  提供最大偏差 bps、最小一致 source 数和参考价最大年龄，没有隐藏默认值。
- 价格完整性可以由足够数量的当前 fresh source 相互一致证明，或由同 scope、未过期且来自另一个
  provider 的最近已接受参考价证明。实时 source 形成多个最高票且彼此冲突的价格簇时，不按优先级
  猜测获胜簇；没有独立参考价消歧就全部失败关闭。参考价达到年龄阈值、来自未知 source、与候选
  同 provider、scope 不同或时间非法时不能作为切换证据。
- 只有 fresh、sequence 接受且价格完整性通过的候选参与选择；按 source policy 选择最高优先级。
  主源不可用时可选择通过全部检查的备源；无法确认价格、时间或完整性时返回 unavailable，明确
  `eligibleForNewPosition=false`。
- 返回的 eligibility 只是 Runtime 新开仓 Gate 的必要条件，不代表授权、策略、账户、风险或 named
  live Gate 已通过，也不影响既有仓位的安全退出路径。

输入数量、ID、symbol、价格位数、bps、时间和 cursor 全部有界；函数不读取系统时钟、不修改
入参、不保存状态。T2.3a 不实现有状态防抖/切回、WebSocket 补齐、provider sequence gap/reset、
客户端偏好、策略绑定、Maintenance source 目录或真实故障注入；这些能力必须在 P-01/P-03、真实
授权和 provider fixture 冻结后分别进入 T2.2b/T2.3b/T2.4。

完成标准：覆盖主源正常、主源 stale 后参考价校验的备源接管、精确 bps 边界、价格分歧、参考价
过期、symbol/scope 错配、duplicate/out-of-order、大整数 sequence、非法时间/价格、未知字段和
输入上限；定向、全量、TypeScript、ESLint、架构与安全 Gate 通过。纯合同且没有 UI/route/数据库
变化时不单独声称完成浏览器、真实切换或 G2。

实施结果（2026-08-24）：`packages/contracts/src/market-source-arbitration.ts` 已实现显式有序来源
策略、精确 provider symbol/canonical scope、独立 sequence cursor、服务端新鲜度和精确十进制
价格仲裁。主源通过时按优先级选择；主源不可用时，备源必须获得唯一实时共识或另一个 provider
的 fresh reference 才能接管。对抗性 RED 证明旧实现会误选 2 对 2 冲突价格簇，修复后并列冲突簇
全部 unavailable；候选不能用自身历史价自证，晚于评估时刻才收到的事件也不再被判为 fresh。

新增 14 项仲裁合同测试，连同行情合同、流状态、route 和 Runtime admission 定向测试 46/46；
全量 `npm test` 1378/1378、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository
secret scan（3073 个候选文件）、production dependency audit 0 和 `git diff --check` 均通过。
代码提交为 `ef18d71`。本切片不包含 adapter、网络、数据库、route 或 UI 消费，不声称真实故障
切换、延迟目标或 G2 已完成；T2.3b 继续等待 P-01/P-03 和 provider fixture。

## 12. T2.11a Runtime 已收盘 K 线与 cadence 准入

真实 stream adapter 尚未确定时，当前 Runtime 仍必须先关闭两条已知的不安全路径：把 provider
返回的当前未收盘 K 线当成完整决策依据，以及在 feed 长时间未推进时继续自动开新仓。

- `evaluatedAt` 由 Worker 注入，域层不读取系统时钟；浏览器不能提交 freshness。
- 所有 K 线先做数值、OHLC、时间和顺序严格校验；随后只保留 `closeTime <= evaluatedAt` 的已收盘项。
- 决策至少需要两根已收盘 K 线；当前未收盘尾项可以被安全忽略，不能成为 snapshot、决策或幂等键。
- 只接受 Runtime 已支持并能换算毫秒的 timeframe。未知周期不猜默认值，quality 为 `invalid`。
- 对连续 24/7 加密 K 线，`ageMs = evaluatedAt - latestClosedAt`；当
  `ageMs >= timeframeMs + 30_000` 时为 `stale`，否则为 `fresh`。30 秒只容纳当前 15 秒轮询和
  provider 收盘落盘延迟，不替代 stream 的 500ms latency 目标。
- `stale/invalid` 只能阻断 `enter_long/enter_short`；已有仓位的退出意图继续由确定性策略与风险规则
  计算，不能因为新开仓 Gate 失败而被吞掉。
- 七阶段 `market_data` evidence 必须记录 `quality/ageMs/staleAfterMs/latestClosedAt`；结论不得在
  stale/invalid 时声称行情完整且可开仓。
- 共享卡级决策轮和逐组合准入使用同一派生状态，防止不同客户对同一根 K 线得到相互矛盾的行情资格。

T2.11a 是当前 candle cadence 的必要安全 Gate，不证明 stream sequence、接收延迟、主备源或 G2。
T2.11b 必须在真实 adapter 确定后把 T2.2 的 event envelope/连接状态与本 Gate 合并。

实施结果（2026-08-24）：`packages/domain/src/runtime/market-admission.ts` 提供无 I/O 的已收盘过滤
与 cadence 判定，`strategy-runtime-worker` 已同时接入官方现货和硬关闭的遗留隔离路径；后者没有
因此解除永续硬关闭。引擎要求 `marketData` 为服务端输入，并复核 timeframe 与本次决策 K 线
`closeTime`，缺失、错配、未来、未知周期或越界时间均失败关闭。七阶段 evidence 记录派生质量；
stale 新开仓形成可查询拒绝，已有仓位退出不受阻断。新增 7 项专项测试，PostgreSQL Runtime
22/22 和全量 1364/1364 通过；真实 stream 综合准入仍由 T2.11b 完成。
精确提交 `9403899` 已在 `ssh an-saas` 的 Node 22.21.1 容器完成三端 production build；该切片
没有页面、认证或路由变化，因此未新增浏览器验收声明，仍沿用“最终可部署产物重跑三端登录”的 Gate。
