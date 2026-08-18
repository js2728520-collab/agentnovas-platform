type NewsItem = {
  id: string;
  title: string;
  summary: string;
  category: "快讯" | "资金流向" | "公告";
  publishedAt: string;
  source: string;
  link: string;
  live: boolean;
};

const defaultFeeds = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
];

function configuredFeeds() {
  const value = process.env.NEWS_RSS_URLS || process.env.NEWS_API_URL || "";
  const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
  return urls.length ? urls.map((url, index) => ({ url, source: `配置新闻源 ${index + 1}` })) : defaultFeeds;
}

const fallbackNews: NewsItem[] = [
  {
    id: "fallback-btc-volume",
    title: "BTC 市场成交量回升，短期波动率同步扩大",
    summary: "等待外部新闻源恢复，行情数据仍可独立刷新。",
    category: "快讯",
    publishedAt: new Date(0).toISOString(),
    source: "本地备用",
    link: "",
    live: false,
  },
  {
    id: "fallback-risk",
    title: "机构资金流显示数字资产风险偏好回暖",
    summary: "新闻源暂不可用，系统不会把备用内容当作实时事实。",
    category: "资金流向",
    publishedAt: new Date(0).toISOString(),
    source: "本地备用",
    link: "",
    live: false,
  },
  {
    id: "fallback-exchange",
    title: "主要交易所更新部分合约保证金参数",
    summary: "恢复连接后将自动替换为带原文链接的实时新闻。",
    category: "公告",
    publishedAt: new Date(0).toISOString(),
    source: "本地备用",
    link: "",
    live: false,
  },
];

function stripTags(value: string) {
  return value
    .replace(/<!\[CDATA\[/gi, "")
    .replace(/\]\]>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string) {
  return stripTags(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function pick(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeEntities(match[1]) : "";
}

function categoryFor(title: string): NewsItem["category"] {
  if (/公告|升级|参数|listing|delist|upgrade|regulat/i.test(title)) return "公告";
  if (/资金|流入|流出|institution|fund|inflow|outflow|etf/i.test(title)) return "资金流向";
  return "快讯";
}

function parseFeed(xml: string, source: string): NewsItem[] {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];
  return blocks.flatMap((match, index): NewsItem[] => {
      const block = match[1] || "";
      const title = pick(block, "title");
      const summary = pick(block, "description") || pick(block, "summary") || pick(block, "content");
      const publishedAt = pick(block, "pubDate") || pick(block, "published") || pick(block, "updated");
      const link = pick(block, "link") || block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || "";
      if (!title) return [];
      const parsedDate = new Date(publishedAt);
      return [{
        id: `${source.toLowerCase()}-${parsedDate.getTime() || Date.now()}-${index}`,
        title,
        summary: summary.slice(0, 150),
        category: categoryFor(title),
        publishedAt: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
        source,
        link,
        live: true,
      }];
    });
}

function ageLabel(value: string, now: number) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "刚刚";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

export async function GET(request: Request) {
  const coin = new URL(request.url).searchParams.get("coin")?.toUpperCase() || "";
  const now = Date.now();
  const results = await Promise.all(
    configuredFeeds().map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { accept: "application/rss+xml, application/xml, text/xml" },
          signal: AbortSignal.timeout(5500),
          cache: "no-store",
        });
        if (!response.ok) return [] as NewsItem[];
        return parseFeed(await response.text(), feed.source);
      } catch {
        return [] as NewsItem[];
      }
    }),
  );

  const fetched = results.flat();
  const ranked = [...fetched].sort((a, b) => {
    const aCoin = coin && new RegExp(`\\b${coin}\\b|${coin}USDT`, "i").test(a.title) ? 1 : 0;
    const bCoin = coin && new RegExp(`\\b${coin}\\b|${coin}USDT`, "i").test(b.title) ? 1 : 0;
    return bCoin - aCoin || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
  const items = (ranked.length ? ranked.slice(0, 12) : fallbackNews).map((item) => ({
    ...item,
    timeLabel: item.live ? ageLabel(item.publishedAt, now) : "备用提示",
  }));

  return Response.json(
    {
      source: ranked.length ? (process.env.NEWS_RSS_URLS || process.env.NEWS_API_URL ? "configured-rss" : "CoinDesk / Cointelegraph RSS") : "fallback",
      live: ranked.length > 0,
      updatedAt: new Date().toISOString(),
      items,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
