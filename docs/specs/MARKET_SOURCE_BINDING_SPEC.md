# 行情源选择与策略绑定合同规格

状态：`TARGET/PARTIAL_CURRENT`；T2.4a 只交付 provider-independent 纯合同，持久化、API、UI 与 Runtime 接入属于 T2.4b
日期：2026-08-24
上位真源：`../product/PRD.md` 第 6 节与第 14 节；`MARKET_DATA_CONTRACT_SPEC.md`；ADR-0004、ADR-0018、ADR-0021

## 1. 目标

为“行情源跟随交易账户”与“独立选择行情源”建立同一套严格、可版本化、失败关闭的合同，使每个策略版本可以关联一个不可变的已解析行情源绑定，同时保持以下边界：

- 策略 DSL V1–V3 继续只描述交易逻辑，不加入 provider、账户、连接或授权字段。
- 浏览器只表达选择意图，不能声明 provider 已授权、已配置、健康、可读或可开仓。
- 服务端使用账户归属事实与 provider-market capability 快照解析选择。
- 解析结果是客户/部署侧 binding instance，引用具体策略版本、canonical market/instrument、
  provider symbol 和 capability 版本；它不是作者策略版本全局唯一的数据源。
- 绑定只允许 `display` 或 `research` 用途，永远不授予订单、资金或 live execution 权限。
- 选择失败不静默回退公共源；Coinbase fallback 与真实 provider 优先级属于 T2.5/P-01。

T2.4a 不增加数据库、route、UI、网络或真实 provider，也不宣称 M-04、G2 或真实主备切换完成。

## 2. 需求与开放项

### 2.1 已确认

1. 加密行情源可以跟随用户交易账户，也可以由用户独立选择。
2. 每个策略可以绑定不同数据源。
3. provider symbol 只是 canonical instrument 的映射，不能作为跨 provider 主键。
4. 陈旧、非法或完整性未确认的行情不得触发自动新开仓。
5. 真实订单仍由确定性 Execution Service 与独立 named Gate 控制。

### 2.2 T2.4a 的范围决定

- 选择只有 `account_aligned` 与 `independent` 两种显式模式；没有隐藏默认模式。
- `account_aligned` 请求携带账户 ID，服务端必须核对账户归属、状态、只读能力和 provider 一致性。
- `independent` 请求携带 provider ID，不接受账户作为旁路输入。
- capability 快照固定 provider、market、instrument、provider symbol、授权类型、用途和版本；不冻结瞬时 health、latency、sequence 或连接状态。
- `customer_account` capability 必须绑定精确账户；独立模式不能复用客户账户授权。
- 解析后的绑定同时带 source-policy fingerprint 与 binding-instance fingerprint；前者描述可共享的
  行情计算政策，后者描述客户/策略版本关联事实。
- 绑定失败返回稳定 blocked reason；结构错误、未知字段和无界输入在 normalizer 边界直接拒绝。

### 2.3 仍需确认或后续设计

- P-01：真实交易所优先级、账户一致源与独立选择冲突规则、Coinbase fallback 精确顺序。
- Exchange account 与 market-data provider 的权威映射和真实 capability registry。
- 绑定最终落在作者策略版本、客户部署版本还是两层同时保存的产品语义。
- ADR-0018 共享决策轮身份加入 binding/policy fingerprint 的迁移方案。
- 历史策略版本、回测、验证、deployment 和 market snapshot 的 `legacy_unpinned` 兼容方案。

这些开放项阻断 T2.4b 的持久化与 Runtime 接入，不阻断 T2.4a 的纯合同。

## 3. 合同模型

### 3.1 选择意图

```ts
type MarketSourceSelection =
  | { mode: "account_aligned"; accountId: string }
  | { mode: "independent"; providerId: string };
```

选择意图不得携带 provider symbol、授权、健康、连接、用途、endpoint、credential、fallback、`quality` 或 `canOpenPosition`。这些字段只能来自服务端可信目录和运行状态。

### 3.2 服务端安全快照

账户快照只包含解析所需事实：

```ts
type MarketSourceAccountSnapshot = {
  accountId: string;
  ownerUserId: string;
  providerId: string;
  status: "pending" | "active" | "disconnected" | "revoked";
  canRead: boolean;
};
```

capability 快照不包含秘密、endpoint 或原始授权正文：

```ts
type MarketSourceCapabilitySnapshot = {
  capabilityVersionId: string;
  providerId: string;
  marketId: string;
  instrumentId: string;
  providerSymbol: string;
  authorization: "public" | "licensed" | "customer_account";
  usage: Array<"display" | "research" | "execution">;
  configured: boolean;
  sourceAccountId: string | null;
};
```

`customer_account` 必须提供 `sourceAccountId`；`public/licensed` 必须为 null。调用方必须从已认证
Session、账户仓储和受控 provider registry 构造快照。浏览器提交同形对象不构成可信事实。

### 3.3 已解析绑定

```ts
type ResolvedMarketSourceBinding = {
  contractVersion: 1;
  strategyVersionId: string;
  selectionMode: "account_aligned" | "independent";
  accountId: string | null;
  providerId: string;
  marketId: string;
  instrumentId: string;
  providerSymbol: string;
  requestedUsage: "display" | "research";
  authorization: "public" | "licensed" | "customer_account";
  capabilityVersionId: string;
  sourceAccountId: string | null;
  authorizesOrders: false;
  fingerprintVersion: 1;
  sourcePolicyFingerprint: string;
  bindingInstanceFingerprint: string;
};
```

两个 fingerprint 都使用固定 domain tag、fingerprint version 和 JSON tuple 字节布局计算 SHA-256，
不依赖对象字段插入顺序：

```text
source policy v1 = SHA-256(JSON([
  "agentnovas.market-source-policy", 1,
  providerId, marketId, instrumentId, providerSymbol, requestedUsage,
  authorization, capabilityVersionId, sourceAccountId
]))

binding instance v1 = SHA-256(JSON([
  "agentnovas.market-source-binding-instance", 1,
  strategyVersionId, selectionMode, accountId, sourcePolicyFingerprint
]))
```

policy fingerprint 排除 requester、普通 accountId、选择模式、configured、health、时间、延迟和
sequence；平台 public/licensed 同政策可跨客户复用，customer-account 因 `sourceAccountId` 必须
隔离。instance fingerprint 用于持久化 provenance/idempotency，不能作为共享决策轮 policy。
调用方不得对未规范化浏览器 JSON 直接哈希。T2.5 增加有序 fallback、阈值或 adapter contract
revision 时必须升级 policy fingerprint 版本，不能静默修改 v1 tuple。

## 4. 解析与失败关闭规则

1. 所有顶层与嵌套对象使用 exact-field 校验；未知字段、缺失字段、数组、空字符串、控制字符和超长 ID 拒绝。
2. market/instrument/provider ID 复用 `normalizeMarketDataId`；provider symbol 复用 T2.3 的有界 symbol normalizer，不拆字符串猜 market、quote 或 exchange。
3. `requestedUsage` 只接受 `display` 或 `research`。`execution` 即使出现在 capability 中也不能通过本合同请求。
4. capability 缺失、未配置、scope 不匹配或不包含请求用途时返回 blocked，不创建 binding。
5. `account_aligned` 必须同时满足：账户存在、属于当前用户、ID 匹配、状态为 active、`canRead=true`、账户 provider 与 capability provider 一致。
6. `independent` 必须满足请求 provider 与 capability provider 一致，且账户输入必须为 null。
7. `customer_account` capability 只允许 `account_aligned`，且 `sourceAccountId` 必须与选择账户精确
   一致；public/licensed capability 不得夹带账户作用域。
8. 任何 blocked 结果都必须保持 `binding=null` 且不含任何 fingerprint，不得隐式改用公共源或平台默认源。
9. 解析成功只证明选择在该 capability 快照下可绑定。Runtime 仍须重验账户撤销/可读状态，并执行
   T2.2/T2.3 的 sequence、freshness、price integrity、当前健康和 stale Gate。
10. `authorizesOrders` 固定为 false；本合同不能替代账户交易权限、风控、named live Gate、Execution Service 或资金 Gate。
11. 退出、撤单和事故处置不得简单复用“禁止新开仓”的结果；由 Runtime/Execution 合同独立处理。

稳定 blocked reason 至少包括：

- `account_required`
- `account_not_allowed`
- `account_mismatch`
- `account_owner_mismatch`
- `account_unavailable`
- `source_unavailable`
- `source_not_configured`
- `source_account_required`
- `source_account_mismatch`
- `provider_mismatch`
- `scope_mismatch`
- `usage_unsupported`

## 5. 与策略版本、部署和 Runtime 的后续边界

T2.4b 采用三层证据链，具体数据库设计在 P-01 与产品语义确认后冻结：

1. 作者策略版本保持 provider-free；客户选择版本或 deployment 保存选源意图，不得写进
   `specification_json` DSL。若产品最终要求作者策略携带建议源，必须是独立版本化字段，不能成为
   所有客户唯一 resolved binding。
2. deployment binding version 保存账户解析后的实际 provider/source policy、policy fingerprint
   与 instance fingerprint；账户或 provider 配置变化不得静默改写既有 deployment。
3. Runtime cycle/market snapshot 记录 round contract hash、policy fingerprint、最终 selected
   provider、quality 和数据集证据。round contract hash 必须组合策略合同、source policy 以及必要
   的引擎/准入版本，不能直接使用 instance fingerprint。

同 DSL 更换行情源后，旧回测、评分和 `STANDARD_VERIFIED` 不得自动沿用。ADR-0018 当前共享决策
轮 identity 和四列唯一约束都缺 source policy；Runtime 接入前必须让 deterministic round ID 与
唯一约束使用新的 round contract hash。只增加可空列而保留旧唯一约束仍会让同一 K 线上的不同源
互相冲突，不能作为完成方案。

历史版本只能明确标记 `legacy_unpinned`，不能补写一个无法证明的历史 provider。回滚必须恢复历史绑定原值，不能按当前账户重新解析。

## 6. 测试策略与完成标准

T2.4a RED/GREEN 覆盖：

- 两种选择模式的规范化与确定性双 fingerprint。
- 账户归属、ID、状态、只读能力与 provider 不一致。
- independent 模式夹带账户。
- provider 未配置、用途不支持、market/instrument scope 不匹配。
- 请求 execution、未知字段、超长/非法 ID、非法 provider symbol、重复 usage。
- 两个虚构 provider 的等价路径，证明没有 Binance/Coinbase 特判。
- 输入对象不被修改；blocked 结果永远不含 binding/fingerprint。
- policy 语义变化会改变 policy 与 instance fingerprint；仅客户/策略 provenance 变化只改变
  instance fingerprint；字段顺序、set-like usage 顺序和可规范化 symbol 空白不影响结果。
- public/licensed 同政策跨账户保留相同 policy fingerprint；两个 customer-account 源按账户隔离。
- 固定 golden digest 锁住两个 v1 tuple；任何字节布局变化必须升级 fingerprint version。

验证命令：

```bash
node --test --experimental-strip-types tests/market-source-binding.test.mjs
node --test --experimental-strip-types tests/market-data-contract.test.mjs tests/market-stream-state.test.mjs tests/market-source-arbitration.test.mjs tests/market-source-binding.test.mjs
npm test
./node_modules/.bin/tsc --noEmit
npm run lint
npm run quality:boundaries
npm run quality:key-custody
npm run quality:secret-scan
npm audit --omit=dev --audit-level=high
```

纯合同没有 route、UI、数据库或运行时消费变化时，不单独把浏览器、真实 provider 或 G2 记为本切片证据；完整阶段收口仍须在最新 production 产物重跑三端登录和相关行情旅程。
