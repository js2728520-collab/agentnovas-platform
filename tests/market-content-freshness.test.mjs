import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveMarketFeedStatus,
  isRecentMarketPayload,
  marketPayloadTimestamp,
  normalizeNewsPublishedAt,
  summarizeNewsFreshness,
} from "../lib/market-content-freshness.ts";
import { GET as readMarketNews } from "../app/api/market/news/route.client.ts";

const observedAt = new Date("2026-08-21T12:00:00.000Z");

test("market feed is not live until a recent valid payload arrives", () => {
  assert.equal(deriveMarketFeedStatus({ transport: "connecting", payloadAt: null, now: observedAt }), "connecting");
  assert.equal(deriveMarketFeedStatus({ transport: "active", payloadAt: "2026-08-21T11:59:50.000Z", now: observedAt }), "live");
  assert.equal(isRecentMarketPayload("2026-08-21T11:59:50.000Z", observedAt), true);
  assert.equal(isRecentMarketPayload("2026-08-21T11:59:00.000Z", observedAt), false);
  assert.equal(marketPayloadTimestamp("not-a-date", observedAt), null);
  assert.equal(marketPayloadTimestamp("2026-08-21T12:10:00.000Z", observedAt), null);
});

test("market feed immediately stops claiming live after an error or close", () => {
  assert.equal(deriveMarketFeedStatus({ transport: "offline", payloadAt: "2026-08-21T11:59:59.000Z", now: observedAt }), "offline");
  assert.equal(deriveMarketFeedStatus({ transport: "active", payloadAt: "2026-08-21T11:59:00.000Z", now: observedAt }), "stale");
});

test("invalid RSS dates stay unknown instead of being replaced with the observation time", () => {
  assert.equal(normalizeNewsPublishedAt("not-a-date"), null);
  assert.deepEqual(summarizeNewsFreshness([null], observedAt), {
    freshness: "unknown",
    stale: true,
    newestPublishedAt: null,
  });
  assert.deepEqual(summarizeNewsFreshness(["2026-08-21T12:10:00.000Z"], observedAt), {
    freshness: "unknown",
    stale: true,
    newestPublishedAt: null,
  });
});

test("RSS feed live status depends on recent content rather than item presence", () => {
  assert.deepEqual(summarizeNewsFreshness(["2026-08-20T12:00:00.000Z"], observedAt), {
    freshness: "stale",
    stale: true,
    newestPublishedAt: "2026-08-20T12:00:00.000Z",
  });
  assert.deepEqual(summarizeNewsFreshness(["2026-08-21T11:45:00.000Z"], observedAt), {
    freshness: "fresh",
    stale: false,
    newestPublishedAt: "2026-08-21T11:45:00.000Z",
  });
});

test("news API exposes observation and content freshness without inventing bad dates", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><channel><item>
      <title>Malformed date item</title>
      <description>Timestamp must remain unknown.</description>
      <pubDate>not-a-date</pubDate>
      <link>https://example.test/item</link>
    </item></channel></rss>
  `, { status: 200, headers: { "content-type": "application/rss+xml" } });
  try {
    const response = await readMarketNews(new Request("https://agentnovas.com/api/market/news?coin=BTC"));
    const payload = await response.json();
    assert.equal(typeof payload.observedAt, "string");
    assert.equal(payload.contentFreshness, "unknown");
    assert.equal(payload.stale, true);
    assert.equal(payload.live, false);
    assert.equal(payload.items[0].publishedAt, null);
    assert.equal(payload.items[0].freshness, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Client market UI consumes freshness states and does not advertise socket-open throughput", async () => {
  const source = await readFile(new URL("../app/live-market.tsx", import.meta.url), "utf8");
  assert.match(source, /deriveMarketFeedStatus/);
  assert.match(source, /contentFreshness/);
  assert.match(source, /行情数据已过期/);
  assert.match(source, /内容已过期/);
  assert.doesNotMatch(source, /0\.1\s*秒实时|每\s*0\.1\s*秒/);
  assert.doesNotMatch(source, /onopen\s*=\s*\(\)\s*=>\s*set\w+\(["'](?:live|active)["']\)/);
  assert.match(source, /socket\.onerror\s*=.*setMarketTransport\("offline"\)/s);
});
