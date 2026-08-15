import { requireUser, responseError } from "@/lib/session";

type ChatMessage = { role: "user" | "assistant"; text: string };

function guidedReply(message: string, specification: Record<string, unknown>) {
  const missing: string[] = [];
  if (!specification.symbol) missing.push("交易对");
  if (!specification.period) missing.push("信号周期");
  if (!specification.style) missing.push("交易风格");
  if (!specification.indicators) missing.push("成熟因子");
  if (!specification.entryRule) missing.push("入场条件");
  if (!specification.exitRule) missing.push("退出条件");
  const base = `${String(specification.symbol || "目标币种")} ${String(specification.period || "待定周期")}，采用${String(specification.style || "待定风格")}。`;
  if (missing.length) return `为了生成可回测规则，请先确认${missing.join("、")}。${base}我还会检查入场条件、退出条件、资金上限、止损止盈和最大回撤，缺少任何一项都不会进入回测。`;
  if (/新手|不知道|推荐|建议|从零/.test(message)) return `${base}建议先用保守模板：EMA20/60 判断方向，ADX14≥22 过滤弱趋势，ATR14 设置2倍移动止损，单笔风险≤0.5%，单日亏损2%熔断，最大回撤10%。先回测，再模拟盘，不使用杠杆。`;
  if (/突破|放量/.test(message)) return `${base}可研究 Donchian20 突破+成交量/MA20≥1.5+ATR14 波动过滤；连续2次假突破暂停，单笔风险≤0.4%。请补充突破后持仓和退出规则。`;
  if (/震荡|区间|反转/.test(message)) return `${base}可研究 RSI14(30/70)+Bollinger20(2)+ADX14<20 的区间模板；回到中轨分批止盈，ADX14≥25 自动停做区间。请确认是否接受这些阈值。`;
  if (/指标|因子/.test(message)) return `${base}优先从三类因子组合：趋势 EMA/ADX、波动 ATR/Bollinger、成交量 Volume/MA20。每类先选1-2个，避免指标堆叠；随后补齐明确的入场、退出与失效条件。`;
  if (/震荡|过滤/.test(message)) return `${base}已加入市场状态过滤建议：趋势策略可要求 EMA20 高于 EMA60 且成交量不低于20周期均量的85%；区间策略则用 RSI14 的30/60阈值。请确认是否接受，或提出新的阈值。`;
  if (/风险|回撤|亏损|止损/.test(message)) return `${base}当前单次资金上限 ${specification.capital || 5}%，止损 ${specification.stopLoss || 2}%，止盈 ${specification.takeProfit || 4}%，最大回撤限制 ${specification.maxDrawdown || 12}%。建议先保留这些硬边界，回测不达标时降低仓位，而不是放宽止损。`;
  return `${base}下一步请把你的入场确认、不能交易的行情、退出条件讲清楚。例如：“只在趋势和成交量同时确认时入场，连续失败3次暂停”。我会把自然语言整理成平台可以真实回测的结构化规则。`;
}

async function aiReply(message: string, conversation: ChatMessage[], specification: Record<string, unknown>) {
  const url = process.env.AI_API_URL;
  const key = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!url || !key || !model) return { text: guidedReply(message, specification), mode: "guided_rules" as const };
  const system = `你是 AgentNovas 的量化策略研究助手。你的任务不是承诺收益，而是用专业、易懂的中文把客户想法引导为可回测规则。必须依次明确：目标与经验、交易对与周期、市场状态、策略风格、数据和指标、入场条件、退出条件、仓位、止损止盈、最大回撤、暂停条件。可优先建议成熟因子：趋势 EMA/ADX、波动 ATR/Bollinger、突破 Donchian/成交量；不要堆叠指标，也不要编造行情或收益。发现规则矛盾、参数过激或无法真实回测时必须指出，并给出更稳妥的替代参数。当前结构化参数：${JSON.stringify(specification)}。每次回复不超过220字。`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...conversation.slice(-12).map((item) => ({ role: item.role, content: item.text })), { role: "user", content: message }], temperature: 0.2 }) });
  if (!response.ok) throw new Error(`AI策略服务返回 ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI策略服务没有返回有效内容");
  return { text, mode: "ai_provider" as const };
}

export async function POST(request: Request) {
  try {
    await requireUser(request, ["customer"]);
    const body = await request.json() as { message?: string; conversation?: ChatMessage[]; specification?: Record<string, unknown> };
    if (!body.message?.trim()) return Response.json({ error: "请输入策略问题" }, { status: 400 });
    const result = await aiReply(body.message.trim(), Array.isArray(body.conversation) ? body.conversation : [], body.specification || {});
    return Response.json({ ...result, disclaimer: "策略研究内容仅用于形成和回测交易规则，不构成收益承诺。" });
  } catch (error) {
    return responseError(error);
  }
}
