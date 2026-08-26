# packages/ledger

复式记账的领域规则。**这里的代码不做 I/O。**

## 分工

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 领域规则 | `packages/ledger/src/` | 借贷平衡校验、定点小数运算 —— 纯函数 |
| 写入服务 | `lib/commercial-ledger-service.ts` | 唯一被允许写资金表的模块，持有 `PoolClient` |
| 数据库约束 | 迁移 `0022` | append-only 触发器、`DEFERRABLE` 借贷平衡、幂等唯一索引 |

**三层都要成立，缺一不可。** 数据库约束挡住「不平的账」，写入服务收敛入口挡住
「在意料之外的地方记一笔平的但错的账」，领域规则保证两边用同一套算法。

## 硬规则

**1. 金额一律用定点小数字符串，禁止 JavaScript number。**
`0.1 + 0.2 !== 0.3`。资金金额经过浮点就不再可靠，而这是要向客户收钱的依据。
所有运算走 `addDecimalStrings` / `compareDecimalStrings`。

**2. 不 import 任何 I/O。** 与 `packages/domain` 同样的约束，由
`scripts/quality/check-architecture-boundaries.mjs` 强制。

**3. 只追加，不修改。** 账本没有 update 和 delete。更正的唯一方式是写一笔
反向分录（`reversal_of_transaction_id`）。数据库触发器会拒绝任何 UPDATE/DELETE，
应用层也不该尝试。

**4. 一笔交易的分录之和必须为零，且至少两条。**
`assertBalancedPostings` 在应用层先挡一道，数据库的 `DEFERRABLE INITIALLY DEFERRED`
约束触发器在提交时再挡一道。两道都保留——应用层给出可读错误，数据库保证绝对性。

**5. 幂等键不是可选项。** 同一业务事件重试必须返回同一结果，不得重复入账。
唯一索引在 `(source_type, source_id, transaction_type, currency)` 上。

## 对应的不变量

INV-4（账本 append-only、借贷必平、幂等）。这是全平台唯一一条**已经在数据库层
完全强制**的不变量，代码层的职责是让错误在更早、更可读的地方暴露出来。
