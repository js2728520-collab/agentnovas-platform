export const aiRequestLimit = { perMinute: 10, perDay: 100 } as const;
export const aiConversationLimit = { perMinute: 10, active: 50 } as const;

const potentialSecretPatterns = [
  /\bsk-(?:proj-)?[a-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|secret(?:[_ -]?key)?|password|passwd|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b0x[a-f0-9]{64}\b/i,
];

export function containsPotentialSecret(value: string) {
  return potentialSecretPatterns.some((pattern) => pattern.test(value));
}

export function normalizeAiMessage(value: unknown) {
  if (typeof value !== "string") throw new Error("请输入对话内容");
  const message = value.trim();
  if (!message) throw new Error("请输入对话内容");
  if (message.length > 2_000) throw new Error("单条消息不能超过 2000 个字符");
  if (containsPotentialSecret(message)) throw new Error("检测到疑似密钥、密码或令牌，请移除敏感信息后再发送");
  return message;
}
