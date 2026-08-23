import assert from "node:assert/strict";
import test from "node:test";

import { toCanonicalSpotSymbol } from "../packages/domain/src/execution/intent-translation.ts";
import { officialTradingHallStrategies } from "../packages/contracts/src/trading-hall.ts";

// 策略规格写 BTCUSDT，执行意图要求 BTC/USDT。两边各自都自洽，接在一起必然抛
// INTENT_SYMBOL_INVALID——五处意外 fail-closed 里的第四处。

test("三张官方卡的每个品种都能归一", () => {
  // 有一个转不了，那张卡的实盘就是死路。
  for (const definition of officialTradingHallStrategies) {
    for (const symbol of definition.symbols) {
      const canonical = toCanonicalSpotSymbol(symbol);
      assert.match(canonical, /^[A-Z0-9]+\/USDT$/, `${symbol} 归一成了 ${canonical}`);
      assert.equal(canonical.replace("/", ""), symbol.toUpperCase());
    }
  }
});

test("已经是规范写法的原样返回，大小写与空白归一", () => {
  assert.equal(toCanonicalSpotSymbol("BTC/USDT"), "BTC/USDT");
  assert.equal(toCanonicalSpotSymbol("  btc/usdt "), "BTC/USDT");
  assert.equal(toCanonicalSpotSymbol("btcusdt"), "BTC/USDT");
});

// 断言错误码而不是 message：调用方靠 code 分流，message 是给人看的。
// assert.throws 的正则匹配的是 message，用它来断言错误身份会在改文案时静默失效。
function rejects(symbol) {
  assert.throws(() => toCanonicalSpotSymbol(symbol), (error) => {
    assert.equal(error.code, "INTENT_SYMBOL_INVALID", `${JSON.stringify(symbol)} 的错误码不对`);
    return true;
  }, `${JSON.stringify(symbol)} 应被拒绝`);
}

test("识别不出计价资产时抛错，不猜", () => {
  // 猜错的后果是把订单发到一个不存在或不相干的交易对上。
  for (const bad of ["BTC", "XYZ", "USDT", "", "   "]) rejects(bad);
});

test("多于一个斜杠的写法被拒绝", () => {
  for (const bad of ["BTC/USDT/EXTRA", "/USDT", "BTC/"]) rejects(bad);
});

test("计价资产之间没有互为后缀的——新增时必须重新检查", () => {
  // 一旦有一个是另一个的后缀，先匹配到哪个就决定切在哪里，而 find 返回第一个。
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH"];
  for (const a of quotes) {
    for (const b of quotes) {
      if (a === b) continue;
      assert.ok(!a.endsWith(b), `${a} 以 ${b} 结尾，匹配顺序会变成隐式规则`);
    }
  }
});
