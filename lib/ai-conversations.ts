import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { aiConversations, aiMessages, aiUsageDaily, auditLogs } from "@/db/schema";
import { AiApiError } from "@/lib/ai-api";
import { deriveConversationTitle } from "@/lib/ai-chat-protocol";
import { aiRequestLimit } from "@/lib/ai-safety";

function publicConversation(row: typeof aiConversations.$inferSelect, messageCount = 0) {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose,
    status: row.status,
    messageCount,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicMessage(row: typeof aiMessages.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    generationMode: row.generationMode,
    providerName: row.providerName,
    createdAt: row.createdAt,
  };
}

export async function listAiConversations(userId: string) {
  const db = getDb();
  const rows = await db.select().from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), eq(aiConversations.status, "active")))
    .orderBy(desc(aiConversations.lastMessageAt))
    .limit(50);
  const ids = rows.map((row) => row.id);
  const counts = ids.length
    ? await db.select({
        conversationId: aiMessages.conversationId,
        count: sql<number>`count(*)`,
      }).from(aiMessages)
        .where(and(eq(aiMessages.userId, userId), inArray(aiMessages.conversationId, ids)))
        .groupBy(aiMessages.conversationId)
    : [];
  const countMap = new Map(counts.map((row) => [row.conversationId, Number(row.count)]));
  return rows.map((row) => publicConversation(row, countMap.get(row.id) || 0));
}

export async function getOwnedAiConversation(userId: string, conversationId: string) {
  const row = (await getDb().select().from(aiConversations).where(and(
    eq(aiConversations.id, conversationId),
    eq(aiConversations.userId, userId),
  )).limit(1))[0];
  if (!row) throw new AiApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
  return row;
}

export async function getConversationMessages(userId: string, conversationId: string) {
  const rows = await getDb().select().from(aiMessages).where(and(
    eq(aiMessages.userId, userId),
    eq(aiMessages.conversationId, conversationId),
  )).orderBy(desc(aiMessages.createdAt)).limit(100);
  return rows.reverse();
}

export async function createAiConversation(userId: string, input: Record<string, unknown>) {
  const title = String(input.title || "新对话").trim().replace(/\s+/g, " ").slice(0, 80) || "新对话";
  const purpose = input.purpose === "strategy" ? "strategy" as const : "consultation" as const;
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    userId,
    title,
    purpose,
    status: "active" as const,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().batch([
    getDb().insert(aiConversations).values(row),
    getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: userId,
      action: "ai.conversation.created",
      subjectType: "ai_conversation",
      subjectId: row.id,
      afterJson: JSON.stringify({ purpose }),
    }),
  ]);
  return publicConversation(row, 0);
}

export async function updateAiConversation(
  userId: string,
  conversationId: string,
  input: Record<string, unknown>,
) {
  const current = await getOwnedAiConversation(userId, conversationId);
  const title = input.title === undefined
    ? current.title
    : String(input.title).trim().replace(/\s+/g, " ").slice(0, 80);
  if (!title) throw new AiApiError("VALIDATION_ERROR", "对话标题不能为空", 400);
  const status = input.status === undefined
    ? current.status
    : input.status === "archived" || input.status === "active"
      ? input.status
      : null;
  if (!status) throw new AiApiError("VALIDATION_ERROR", "不支持的对话状态", 400);
  const updatedAt = new Date().toISOString();
  const next = { ...current, title, status, updatedAt };
  await getDb().batch([
    getDb().update(aiConversations).set({ title, status, updatedAt }).where(and(
      eq(aiConversations.id, conversationId),
      eq(aiConversations.userId, userId),
    )),
    getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: userId,
      action: status === "archived" ? "ai.conversation.archived" : "ai.conversation.updated",
      subjectType: "ai_conversation",
      subjectId: conversationId,
      beforeJson: JSON.stringify({ title: current.title, status: current.status }),
      afterJson: JSON.stringify({ title, status }),
    }),
  ]);
  return publicConversation(next);
}

export async function consumeAiRequestQuota(userId: string, inputChars: number) {
  const db = getDb();
  const minuteStart = new Date(Date.now() - 60_000).toISOString();
  const recent = (await db.select({ count: sql<number>`count(*)` }).from(aiMessages).where(and(
    eq(aiMessages.userId, userId),
    eq(aiMessages.role, "user"),
    gte(aiMessages.createdAt, minuteStart),
  )))[0];
  if (Number(recent?.count || 0) >= aiRequestLimit.perMinute) {
    throw new AiApiError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
  }

  const usageDate = new Date().toISOString().slice(0, 10);
  const id = `ai-usage:${userId}:${usageDate}`;
  const now = new Date().toISOString();
  await db.insert(aiUsageDaily).values({ id, userId, usageDate, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const updated = await db.update(aiUsageDaily).set({
    requestCount: sql`${aiUsageDaily.requestCount} + 1`,
    inputChars: sql`${aiUsageDaily.inputChars} + ${inputChars}`,
    updatedAt: now,
  }).where(and(
    eq(aiUsageDaily.id, id),
    lt(aiUsageDaily.requestCount, aiRequestLimit.perDay),
  )).returning({ id: aiUsageDaily.id });
  if (!updated.length) throw new AiApiError("DAILY_LIMIT_REACHED", "今日 AI 请求额度已用完", 429);
}

export async function appendUserMessage(
  userId: string,
  conversation: typeof aiConversations.$inferSelect,
  content: string,
) {
  if (conversation.status !== "active") throw new AiApiError("CONVERSATION_ARCHIVED", "已归档对话不能继续发送消息", 409);
  const now = new Date().toISOString();
  const title = conversation.title === "新对话" ? deriveConversationTitle(content) : conversation.title;
  const row = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    userId,
    role: "user" as const,
    content,
    generationMode: null,
    providerName: null,
    model: null,
    metadataJson: "{}",
    createdAt: now,
  };
  await getDb().batch([
    getDb().insert(aiMessages).values(row),
    getDb().update(aiConversations).set({ title, lastMessageAt: now, updatedAt: now }).where(and(
      eq(aiConversations.id, conversation.id),
      eq(aiConversations.userId, userId),
    )),
  ]);
  return { message: publicMessage(row), title };
}

export async function appendAssistantMessage(options: {
  userId: string;
  conversationId: string;
  content: string;
  mode: "ai_provider" | "guided_rules";
  providerName?: string;
  model?: string;
  suggestedAction?: "strategy";
}) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    conversationId: options.conversationId,
    userId: options.userId,
    role: "assistant" as const,
    content: options.content,
    generationMode: options.mode,
    providerName: options.providerName || null,
    model: options.model || null,
    metadataJson: JSON.stringify({ suggestedAction: options.suggestedAction || null }),
    createdAt: now,
  };
  const usageDate = now.slice(0, 10);
  await getDb().batch([
    getDb().insert(aiMessages).values(row),
    getDb().update(aiConversations).set({ lastMessageAt: now, updatedAt: now }).where(and(
      eq(aiConversations.id, options.conversationId),
      eq(aiConversations.userId, options.userId),
    )),
    getDb().update(aiUsageDaily).set({
      outputChars: sql`${aiUsageDaily.outputChars} + ${options.content.length}`,
      updatedAt: now,
    }).where(and(eq(aiUsageDaily.userId, options.userId), eq(aiUsageDaily.usageDate, usageDate))),
    getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: options.userId,
      action: "ai.message.completed",
      subjectType: "ai_conversation",
      subjectId: options.conversationId,
      afterJson: JSON.stringify({ mode: options.mode, outputChars: options.content.length }),
    }),
  ]);
  return publicMessage(row);
}

export async function recordAiMessageFailure(userId: string, conversationId: string) {
  await getDb().insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorUserId: userId,
    action: "ai.message.failed",
    subjectType: "ai_conversation",
    subjectId: conversationId,
    afterJson: JSON.stringify({ reason: "provider_or_runtime_error" }),
  });
}
