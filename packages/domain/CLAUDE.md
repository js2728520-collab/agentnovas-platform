# packages/domain

平台的核心业务逻辑。**这里的代码不做 I/O。**

## 为什么要有这一层

七智能体决策链、DSL 校验、回测引擎、风控闸门、费用计算是这个平台的核心资产。
它们此前散在 `lib/` 的 159 个文件里，和仓储、框架适配混在一起，只能通过起 Next
或连数据库来测。抽出来之后可以毫秒级单测，Worker 也不用 import Next。

对商业落地的意义：核心资产变得可移植、可独立验证、可被第三方审计。

## 硬规则

**1. 不 import 任何 I/O。** 具体禁止：

- `next` 及其任何子路径
- `pg`、`drizzle-orm`、任何数据库客户端
- `node:fs`、`node:net`、`node:http(s)`
- 全局 `fetch`

由 `scripts/quality/check-architecture-boundaries.mjs` 强制，CI 会失败。

**2. 需要外部数据时定义端口，不要自己去取。** 域层声明接口，基础设施层实现。

```ts
// 域层：声明需要什么
export type MarketDataPort = {
  loadCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
};

// 域层函数接收数据或端口，不自己发请求
export function runBacktest(candles: Candle[], spec: StrategyDsl): BacktestResult { … }
```

`lib/` 里的 `loadBacktestCandles`、`exchange-adapters`、`research-agent` 是适配器，
它们用注入式 fetch 发真实请求，**不属于本包**。

**3. 纯函数优先。** 相同输入必然产出相同输出。这不是风格偏好——
产品合同要求「相同 card/candle/contract 的重试必须返回同一决策轮或幂等结果」
（INV-8），只有确定性代码能兑现这条。

**4. 时间与随机数从参数进来。** 不要在域层里调 `Date.now()` 或 `Math.random()`，
否则回测与决策轮无法重放。需要时把 `now: Date` 或种子作为参数传入。

**5. 不用 TypeScript 参数属性。** 仓库用 `node --experimental-strip-types` 跑脚本与
测试，strip-only 模式不支持 `constructor(readonly x: string)`，运行时会抛
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。写成显式字段赋值。同理避开 enum、namespace
和其它需要代码生成的语法。

**6. 不 catch 后静默降级。** 数据不合格就抛，让调用方决定。
INV-6 要求未达门槛必须显式标注，域层偷偷返回一个「差不多的结果」会直接违反它。

## 与 INV 的对应

| 不变量 | 本包的责任 |
| --- | --- |
| INV-1 风控不可被模型覆盖 | 风控闸门是确定性函数，不接受任何模型输出作为入参 |
| INV-6 未达门槛必须显式标注 | 评分/准入返回明确的 `NOT_QUALIFIED`，不返回近似值 |
| INV-7 失败安全 | 数据不足时抛错，绝不用默认值补齐 |
| INV-8 七阶段固定顺序、可幂等 | 决策链是纯函数，相同输入产出相同决策轮 |
| INV-11 平台永不持有提现权限 | `OrderIntent` 不含凭证，域层无法也不应触碰密钥 |

## 执行层的缝

平台的目标形态是真实交易 + 策略跟单（见根 `CLAUDE.md`）。域层只产出
**订单意图**，不产出订单：

- `OrderIntent` 是纯值：品种、方向、数量、价格区间、止损止盈、有效期、决策轮溯源。
  它不知道交易所、不知道凭证、不知道签名。
- `ExecutionPort` 是出站端口。paper 实现已存在；GA 接入真实交易时新增 real 实现，
  **域层零改动**。

这条缝现在就要维持住。一旦域层开始感知交易所或凭证，GA 时就得重做。
