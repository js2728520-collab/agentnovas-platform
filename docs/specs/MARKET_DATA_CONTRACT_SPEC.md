# 多市场行情统一合同规格

状态：`TARGET/PARTIAL_CURRENT`；T2.1a/T2.1b 为当前实施切片，真实供应商接入与主备切换仍受 P-01/P-03 阻断
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

- 时间无效、接收早于交易时间且超过允许时钟偏差、阈值无效：`invalid`，禁止开仓。
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

- RED/GREEN 定向合同：`node --test --experimental-strip-types tests/market-data-contract.test.mjs tests/market-route-contract.test.mjs`
- 既有行情回归：`node --test --experimental-strip-types tests/market-content-freshness.test.mjs tests/market-data-snapshots.test.mjs tests/market-route-contract.test.mjs`
- 全量：`npm test`
- 类型：`./node_modules/.bin/tsc --noEmit`
- Lint：`npm run lint`
- 架构/安全：`npm run quality:all && npm run quality:secret-scan && npm audit --omit=dev --audit-level=high`
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
