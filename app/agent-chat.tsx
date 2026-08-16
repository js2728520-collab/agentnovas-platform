"use client";

import { useEffect, useRef, useState } from "react";

import { consumeAiEventStream } from "./ai-sse";

type Conversation = {
  id: string;
  title: string;
  purpose: "consultation" | "strategy";
  messageCount: number;
  lastMessageAt: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  generationMode?: "ai_provider" | "guided_rules" | null;
  providerName?: string | null;
  createdAt: string;
};

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
}

function formatRelative(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

export default function AgentChat({
  title,
  onOpenStrategies,
}: {
  title: string;
  onOpenStrategies: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [suggestedAction, setSuggestedAction] = useState<"strategy" | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const messageEndRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((item) => item.id === activeId) || null;
  const prompts = ["BTC 当前行情与风险如何？", "解释我的持仓风险", "当前跟随策略有哪些？", "帮我生成一个策略"];

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, streamingText]);

  async function loadConversation(id: string) {
    setActiveId(id);
    setError("");
    setSuggestedAction(null);
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { messages?: Message[] } | null;
    if (!response.ok) throw new Error(apiError(payload, "对话加载失败"));
    setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
  }

  async function createConversation() {
    const response = await fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "consultation" }),
    });
    const payload = await response.json().catch(() => null) as { conversation?: Conversation } | null;
    if (!response.ok || !payload?.conversation) throw new Error(apiError(payload, "新建对话失败"));
    setConversations((items) => [payload.conversation!, ...items]);
    setMessages([]);
    setActiveId(payload.conversation.id);
    setSuggestedAction(null);
    return payload.conversation;
  }

  useEffect(() => {
    let cancelled = false;
    async function initialLoad() {
      try {
        const response = await fetch("/api/ai/conversations", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as { conversations?: Conversation[] } | null;
        if (!response.ok) throw new Error(apiError(payload, "对话列表加载失败"));
        const items = Array.isArray(payload?.conversations) ? payload.conversations : [];
        if (cancelled) return;
        if (items[0]) {
          const detailResponse = await fetch(`/api/ai/conversations/${encodeURIComponent(items[0].id)}`, { cache: "no-store" });
          const detail = await detailResponse.json().catch(() => null) as { messages?: Message[] } | null;
          if (!detailResponse.ok) throw new Error(apiError(detail, "对话加载失败"));
          if (cancelled) return;
          setConversations(items);
          setActiveId(items[0].id);
          setMessages(Array.isArray(detail?.messages) ? detail.messages : []);
        } else {
          const createResponse = await fetch("/api/ai/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ purpose: "consultation" }),
          });
          const created = await createResponse.json().catch(() => null) as { conversation?: Conversation } | null;
          if (!createResponse.ok || !created?.conversation) throw new Error(apiError(created, "新建对话失败"));
          if (cancelled) return;
          setConversations([created.conversation]);
          setActiveId(created.conversation.id);
          setMessages([]);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "AI 对话服务暂不可用");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialLoad();
    return () => { cancelled = true; };
  }, []);

  async function newConversation() {
    if (sending) return;
    setError("");
    try {
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建对话失败");
    }
  }

  async function selectConversation(id: string) {
    if (id === activeId || sending) return;
    setLoading(true);
    try {
      await loadConversation(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "对话加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function archiveConversation() {
    if (!activeId || sending) return;
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(activeId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(apiError(payload, "归档对话失败"));
      return;
    }
    const remaining = conversations.filter((item) => item.id !== activeId);
    setConversations(remaining);
    setMessages([]);
    if (remaining[0]) await loadConversation(remaining[0].id).catch(() => undefined);
    else await createConversation().catch(() => undefined);
  }

  async function send() {
    const content = question.trim();
    if (!content || sending || !activeId) return;
    const temporaryId = `pending-${Date.now()}`;
    setQuestion("");
    setError("");
    setSuggestedAction(null);
    setSending(true);
    setStreamingText("");
    setMessages((items) => [...items, {
      id: temporaryId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    }]);
    try {
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(activeId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: content }),
      });
      await consumeAiEventStream(response, (event, data) => {
        if (event === "meta") {
          const saved = data.userMessage as Message | undefined;
          if (saved) setMessages((items) => items.map((item) => item.id === temporaryId ? saved : item));
          if (typeof data.title === "string") {
            setConversations((items) => items.map((item) => item.id === activeId ? { ...item, title: data.title as string } : item));
          }
        } else if (event === "delta" && typeof data.text === "string") {
          setStreamingText((value) => value + data.text);
        } else if (event === "done") {
          const saved = data.message as Message | undefined;
          if (saved) setMessages((items) => [...items, saved]);
          setStreamingText("");
          setSuggestedAction(data.suggestedAction === "strategy" ? "strategy" : null);
          setConversations((items) => items.map((item) => item.id === activeId
            ? { ...item, messageCount: item.messageCount + 2, lastMessageAt: new Date().toISOString() }
            : item));
        } else if (event === "error") {
          throw new Error(String(data.message || "AI 回复暂时不可用"));
        }
      });
    } catch (caught) {
      setStreamingText("");
      setError(caught instanceof Error ? caught.message : "AI 回复暂时不可用");
    } finally {
      setSending(false);
    }
  }

  return <>
    <div className="page-head"><div><h1>{title}</h1><p>与你的 AI 量化团队持续对话，历史由服务端安全保存</p></div></div>
    <div className="agent-chat-workspace">
      <aside className="agent-chat-history">
        <header><div><b>对话记录</b><small>仅当前账号可见</small></div><button type="button" onClick={() => void newConversation()} disabled={sending}>＋ 新建对话</button></header>
        <div className="agent-chat-history-list" aria-label="AI 对话列表">
          {conversations.map((item) => <button key={item.id} className={item.id === activeId ? "active" : ""} type="button" onClick={() => void selectConversation(item.id)} aria-current={item.id === activeId ? "page" : undefined}><i>{item.purpose === "strategy" ? "策" : "AI"}</i><span><b>{item.title}</b><small>{formatRelative(item.lastMessageAt)} · {item.messageCount} 条消息</small></span><em>›</em></button>)}
          {!loading && !conversations.length && <p className="agent-chat-empty">还没有对话</p>}
        </div>
        <footer><span><i />持久化对话服务</span><small>不会执行交易</small></footer>
      </aside>
      <section className="agent-chat-main" aria-busy={loading || sending}>
        <header className="agent-chat-page-head"><div><span className="eyebrow">AI CONSULTATION</span><h2>与 Agent 团队对话</h2><p>服务端结合当前账号的行情、持仓摘要和策略关系回答。</p></div><span className="agent-chat-status"><i />{sending ? "回复生成中" : "对话服务在线"}</span></header>
        <div className="agent-chat-current"><span>当前会话</span><b>{active?.title || "新对话"}</b><small>市场分析 · 风险解释 · 策略研究</small>{active && <button className="agent-chat-archive" type="button" onClick={() => void archiveConversation()}>归档</button>}</div>
        {error && <div className="agent-chat-error" role="alert">{error}</div>}
        <div className="agent-chat-messages" aria-live="polite">
          {loading && <div className="agent-chat-empty">正在加载对话…</div>}
          {!loading && !messages.length && <div className="agent-chat-empty"><b>开始一段真实对话</b><span>可以咨询行情依据、持仓风险，或讨论一个待回测策略。</span></div>}
          {messages.map((message) => <article className={message.role === "user" ? "agent-chat-message-user" : "answer"} key={message.id}><i>{message.role === "user" ? "我" : "AI"}</i><div><b>{message.role === "user" ? "我" : "AI 团队"}</b><p>{message.content}</p><small>{message.generationMode === "guided_rules" ? "平台规则引导 · " : message.providerName ? `${message.providerName} · ` : ""}{formatRelative(message.createdAt)}</small></div></article>)}
          {streamingText && <article className="answer agent-chat-streaming"><i>AI</i><div><b>AI 团队</b><p>{streamingText}<span aria-hidden="true">▋</span></p><small>正在生成…</small></div></article>}
          {suggestedAction === "strategy" && <button type="button" className="agent-chat-open-strategy" onClick={onOpenStrategies}>前往策略工作室创建可回测规则 →</button>}
          <div ref={messageEndRef} />
        </div>
        <section className="agent-chat-prompts"><header><b>快速问题</b><span>点击填入输入框</span></header><div>{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)} disabled={sending}>{prompt}<i>→</i></button>)}</div></section>
        <label className="agent-chat-composer"><textarea aria-label="AI 对话内容" maxLength={2_000} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="输入你想咨询的问题…" disabled={sending || loading} /><button type="button" onClick={() => void send()} disabled={sending || loading || !question.trim()}>{sending ? "生成中…" : "发送问题 →"}</button></label>
        <small className="agent-chat-disclaimer">请勿提交 API Key、密码、私钥或令牌。AI 内容仅用于信息与策略研究，不构成投资建议。</small>
      </section>
    </div>
  </>;
}
