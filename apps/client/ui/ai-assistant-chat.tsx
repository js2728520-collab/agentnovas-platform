"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./ai-assistant-chat.module.css";

import { consumeAiEventStream } from "./ai-sse";
import { AiMessageContent } from "./ai-message-content";

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
  model?: string | null;
  savedStrategyId?: string | null;
  createdAt: string;
};

type PendingAiRequest = {
  conversationId: string;
  content: string;
  idempotencyKey: string;
  temporaryMessageId: string;
};

type AiCancellation = {
  state?: "cancelled" | "succeeded" | "failed";
  creditsDisposition?: "released" | "settled";
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

function apiErrorCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code || "");
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

export default function AiAssistantChat({
  title,
  onOpenStrategies,
}: {
  title: string;
  onOpenStrategies?: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [suggestedAction, setSuggestedAction] = useState<"strategy" | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeInferenceRequestId, setActiveInferenceRequestId] = useState("");
  const [promptMessageId, setPromptMessageId] = useState("");
  const [savingStrategyMessageId, setSavingStrategyMessageId] = useState("");
  const [savedStrategyMessageIds, setSavedStrategyMessageIds] = useState<Record<string, string>>({});
  const [strategySaveNotices, setStrategySaveNotices] = useState<Record<string, string>>({});
  const [retryRequest, setRetryRequest] = useState<PendingAiRequest | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const activeInferenceRequestIdRef = useRef("");
  const cancelRequestedRef = useRef(false);
  const currentRequestRef = useRef<PendingAiRequest | null>(null);
  const persistedUserMessageIdsRef = useRef(new Set<string>());
  const active = conversations.find((item) => item.id === activeId) || null;
  const prompts = ["BTC 当前行情与风险如何？", "解释我的持仓风险", "当前跟随策略有哪些？", "帮我生成一个策略"];

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, streamingText]);

  async function loadConversation(id: string) {
    setActiveId(id);
    setError("");
    setNotice("");
    setRetryRequest(null);
    setSuggestedAction(null);
    setPromptMessageId("");
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { messages?: Message[] } | null;
    if (!response.ok) throw new Error(apiError(payload, "对话加载失败"));
    const loadedMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    persistedUserMessageIdsRef.current = new Set(loadedMessages.filter((message) => message.role === "user").map((message) => message.id));
    setMessages(loadedMessages);
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
    persistedUserMessageIdsRef.current = new Set();
    setMessages([]);
    setActiveId(payload.conversation.id);
    setSuggestedAction(null);
    setPromptMessageId("");
    setRetryRequest(null);
    setNotice("");
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
          const loadedMessages = Array.isArray(detail?.messages) ? detail.messages : [];
          persistedUserMessageIdsRef.current = new Set(loadedMessages.filter((message) => message.role === "user").map((message) => message.id));
          setMessages(loadedMessages);
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
          persistedUserMessageIdsRef.current = new Set();
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
    if (sending || cancelling) return;
    setError("");
    try {
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建对话失败");
    }
  }

  async function selectConversation(id: string) {
    if (id === activeId || sending || cancelling) return;
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
    if (!activeId || sending || cancelling) return;
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
    persistedUserMessageIdsRef.current = new Set();
    setMessages([]);
    setPromptMessageId("");
    if (remaining[0]) await loadConversation(remaining[0].id).catch(() => undefined);
    else await createConversation().catch(() => undefined);
  }

  async function send(contentOverride?: string, retry?: PendingAiRequest) {
    const content = (retry?.content ?? contentOverride ?? question).trim();
    const conversationId = retry?.conversationId ?? activeId;
    if (!content || sending || cancelling || !conversationId) return;
    const freshIdempotencyKey = retry ? "" : crypto.randomUUID();
    const pendingRequest: PendingAiRequest = retry ?? {
      conversationId,
      content,
      idempotencyKey: freshIdempotencyKey,
      temporaryMessageId: `pending-${freshIdempotencyKey}`,
    };
    const temporaryId = pendingRequest.temporaryMessageId;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    currentRequestRef.current = pendingRequest;
    cancelRequestedRef.current = false;
    activeInferenceRequestIdRef.current = "";
    setActiveInferenceRequestId("");
    if (!retry && contentOverride === undefined) setQuestion("");
    setError("");
    setNotice("");
    setRetryRequest(null);
    setSuggestedAction(null);
    setPromptMessageId("");
    setSending(true);
    setStreamingText("");
    if (!retry) {
      setMessages((items) => [...items, {
        id: temporaryId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      }]);
    }
    let response: Response | null = null;
    let completed = false;
    let terminalError = false;
    let requestStillProcessing = false;
    let userMessagePersisted = false;
    try {
      response = await fetch(`/api/ai/conversations/${encodeURIComponent(pendingRequest.conversationId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": pendingRequest.idempotencyKey },
        body: JSON.stringify({ message: pendingRequest.content }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        requestStillProcessing = response.status === 409 && apiErrorCode(payload) === "AI_REQUEST_IN_PROGRESS";
        throw new Error(apiError(payload, `AI 服务返回 ${response.status}`));
      }
      await consumeAiEventStream(response, (event, data) => {
        if (event === "meta") {
          const saved = data.userMessage as Message | undefined;
          if (saved) {
            const firstPersistence = !persistedUserMessageIdsRef.current.has(saved.id);
            persistedUserMessageIdsRef.current.add(saved.id);
            userMessagePersisted = true;
            setMessages((items) => items.map((item) => item.id === temporaryId ? saved : item));
            if (firstPersistence) {
              setConversations((items) => items.map((item) => item.id === pendingRequest.conversationId
                ? { ...item, messageCount: item.messageCount + 1, lastMessageAt: saved.createdAt }
                : item));
            }
          }
          if (typeof data.inferenceRequestId === "string" && data.inferenceRequestId) {
            activeInferenceRequestIdRef.current = data.inferenceRequestId;
            setActiveInferenceRequestId(data.inferenceRequestId);
          }
          if (typeof data.title === "string") {
            setConversations((items) => items.map((item) => item.id === pendingRequest.conversationId ? { ...item, title: data.title as string } : item));
          }
        } else if (event === "delta" && typeof data.text === "string") {
          setStreamingText((value) => value + data.text);
        } else if (event === "done") {
          completed = true;
          const saved = data.message as Message | undefined;
          if (saved) {
            setMessages((items) => [...items, saved]);
            setPromptMessageId(saved.id);
          }
          setStreamingText("");
          setSuggestedAction(data.suggestedAction === "strategy" ? "strategy" : null);
          setConversations((items) => items.map((item) => item.id === pendingRequest.conversationId
            ? { ...item, messageCount: item.messageCount + 1, lastMessageAt: saved?.createdAt || new Date().toISOString() }
            : item));
        } else if (event === "error") {
          terminalError = true;
          throw new Error(String(data.message || "AI 回复暂时不可用"));
        }
      });
      if (!completed) throw new Error("AI 响应在完成确认前中断");
      setRetryRequest(null);
    } catch (caught) {
      setStreamingText("");
      if (cancelRequestedRef.current) {
        setRetryRequest(null);
        setError("");
        if (!userMessagePersisted) {
          setMessages((items) => items.filter((item) => item.id !== temporaryId));
        }
        return;
      }
      if (completed) {
        setRetryRequest(null);
        setError("");
        return;
      }
      const ambiguous = !response || requestStillProcessing || (response.ok && !terminalError && !completed);
      if (ambiguous) {
        setRetryRequest(pendingRequest);
        setError("请求结果尚未确认。请重试原请求以查询同一结果；系统会复用请求标识，不会再次调用模型或重复扣费。");
      } else {
        if (!userMessagePersisted) {
          setMessages((items) => items.filter((item) => item.id !== temporaryId));
        }
        setError(caught instanceof Error ? caught.message : "AI 回复暂时不可用");
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      currentRequestRef.current = null;
      activeInferenceRequestIdRef.current = "";
      setActiveInferenceRequestId("");
      setSending(false);
    }
  }

  async function cancelGeneration() {
    const inferenceRequestId = activeInferenceRequestIdRef.current;
    const pendingRequest = currentRequestRef.current;
    if (!sending || cancelling || !inferenceRequestId || !pendingRequest) return;
    setCancelling(true);
    setError("");
    setNotice("");
    setStreamingText("");
    setRetryRequest(null);
    cancelRequestedRef.current = true;
    requestControllerRef.current?.abort(new DOMException("cancelled by customer", "AbortError"));
    try {
      const response = await fetch(`/api/ai/inferences/${encodeURIComponent(inferenceRequestId)}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `cancel-${crypto.randomUUID()}` },
      });
      const payload = await response.json().catch(() => null) as { inference?: AiCancellation } | null;
      if (!response.ok || !payload?.inference?.state) {
        throw new Error(apiError(payload, "取消结果暂未确认，请稍后重试原请求查询最终状态"));
      }
      if (payload.inference.state === "succeeded") {
        await loadConversation(pendingRequest.conversationId);
        setNotice("回复已在取消前完成，已加载最终结果；Credits 按实际用量结算。");
      } else if (payload.inference.state === "cancelled") {
        setNotice("生成已取消，Credits 预留已释放；已发送的问题仍保留在当前会话中。");
      } else {
        setNotice("请求已经结束且 Credits 预留已释放，可重新发起问题。");
      }
    } catch (caught) {
      cancelRequestedRef.current = false;
      setRetryRequest(pendingRequest);
      setError(caught instanceof Error ? caught.message : "取消结果暂未确认，请稍后重试原请求查询最终状态");
    } finally {
      setCancelling(false);
    }
  }

  async function saveStrategy(messageId: string) {
    if (!activeId || savingStrategyMessageId || savedStrategyMessageIds[messageId]) return;
    setError("");
    setSavingStrategyMessageId(messageId);
    try {
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(messageId)}/strategy`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { strategy?: { id?: string }; message?: string; warnings?: string[] } | null;
      if (!response.ok || !payload?.strategy?.id) throw new Error(apiError(payload, "策略保存失败"));
      const strategyId = payload.strategy.id;
      setSavedStrategyMessageIds((current) => ({ ...current, [messageId]: strategyId }));
      setStrategySaveNotices((current) => ({
        ...current,
        [messageId]: payload.warnings?.length
          ? `已保存；兼容提示：${payload.warnings.join("；")}`
          : payload.message || "已保存到我的策略",
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "策略保存失败");
    } finally {
      setSavingStrategyMessageId("");
    }
  }

  return <>
    <div className={styles.pageHead}><div><h1>{title}</h1><p>与你的 AI 量化团队持续对话，历史由服务端安全保存</p></div></div>
    <div className={styles.workspace}>
      <aside className={styles.history}>
        <header><div><b>对话记录</b><small>仅当前账号可见</small></div><button type="button" onClick={() => void newConversation()} disabled={sending || cancelling}>＋ 新建对话</button></header>
        <div className={styles.historyList} aria-label="AI 对话列表">
          {conversations.map((item) => <button key={item.id} className={item.id === activeId ? styles.active : undefined} type="button" onClick={() => void selectConversation(item.id)} aria-current={item.id === activeId ? "page" : undefined}><i>{item.purpose === "strategy" ? "策" : "AI"}</i><span><b>{item.title}</b><small>{formatRelative(item.lastMessageAt)} · {item.messageCount} 条消息</small></span><em>›</em></button>)}
          {!loading && !conversations.length && <p className={styles.empty}>还没有对话</p>}
        </div>
        <footer><span><i />持久化对话服务</span><small>不会执行交易</small></footer>
      </aside>
      <section className={styles.main} aria-busy={loading || sending || cancelling}>
        <header className={styles.pageHead}><div><span className={styles.eyebrow}>AI CONSULTATION</span><h2>AI 助手</h2><p>行情分析、决策解读、平台与会员规则问答。回答只基于服务端的行情快照、决策轮记录与平台合同事实。</p></div><div className={styles.headerActions}>{sending && activeInferenceRequestId && <button className={styles.cancel} type="button" disabled={cancelling} onClick={() => void cancelGeneration()}>{cancelling ? "正在取消…" : "取消生成"}</button>}<span className={styles.status}><i />{cancelling ? "正在取消" : sending ? "回复生成中" : "平台模型服务"}</span></div></header>
        <div className={styles.current}><span>当前会话</span><b>{active?.title || "新对话"}</b><small>市场分析 · 风险解释 · 策略研究</small>{active && <button className={styles.archive} type="button" onClick={() => void archiveConversation()}>归档</button>}</div>
        {error && <div className={styles.error} role="alert"><span>{error}</span>{retryRequest && <button type="button" disabled={sending} onClick={() => void send(undefined, retryRequest)}>{sending ? "正在查询原请求…" : "重试原请求"}</button>}</div>}
        {notice && <div className={styles.notice} role="status">{notice}</div>}
        <div className={styles.messages} aria-live="polite">
          {loading && <div className={styles.empty}>正在加载对话…</div>}
          {!loading && !messages.length && <div className={styles.empty}><b>开始一段真实对话</b><span>可以咨询行情依据、持仓风险，或讨论一个待回测策略。</span></div>}
          {messages.map((message) => <article className={message.role === "user" ? styles.messageUser : undefined} key={message.id}><i>{message.role === "user" ? "我" : "AI"}</i><div><b>{message.role === "user" ? "我" : "AI 团队"}</b>{message.role === "assistant" ? <AiMessageContent content={message.content} autoPrompt={message.id === promptMessageId} onAnswer={(answer) => void send(answer)} onSaveStrategy={() => void saveStrategy(message.id)} strategySaveNotice={strategySaveNotices[message.id]} strategySaveState={savedStrategyMessageIds[message.id] || message.savedStrategyId ? "saved" : savingStrategyMessageId === message.id ? "saving" : "idle"} /> : <p>{message.content}</p>}<small>{message.generationMode === "guided_rules" ? "平台规则引导 · " : message.model ? `${message.model} · ` : ""}{formatRelative(message.createdAt)}</small></div></article>)}
          {sending && <article className={styles.streaming}><i>AI</i><div><b>AI 助手</b>{streamingText ? <AiMessageContent content={streamingText} streaming /> : <div className={styles.generatingDots} role="status"><span>正在生成回复</span><i /><i /><i /></div>}<small>正在分析当前会话…</small></div></article>}
          {suggestedAction === "strategy" && <button type="button" className={styles.openStrategy} onClick={onOpenStrategies}>前往策略工作室创建可回测规则 →</button>}
          <div ref={messageEndRef} />
        </div>
        <section className={styles.prompts}><header><b>快速问题</b><span>点击填入输入框</span></header><div>{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)} disabled={sending || cancelling}>{prompt}<i>→</i></button>)}</div></section>
        <label className={styles.composer}><textarea aria-label="AI 对话内容" maxLength={2_000} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="输入你想咨询的问题…" disabled={sending || cancelling || loading} /><button type="button" onClick={() => void send()} disabled={sending || cancelling || loading || !question.trim()}>发送问题 →</button></label>
        <small className={styles.disclaimer}>请勿提交 API Key、密码、私钥或令牌。AI 内容仅用于信息与策略研究，不构成投资建议。</small>
      </section>
    </div>
  </>;
}
