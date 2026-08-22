export type AiStreamEvent = "meta" | "delta" | "done" | "error";

function responseErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
}

export async function consumeAiEventStream(
  response: Response,
  onEvent: (event: AiStreamEvent, data: Record<string, unknown>) => void,
) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(responseErrorMessage(payload, `AI 服务返回 ${response.status}`));
  }
  if (!response.body) throw new Error("浏览器不支持流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function consumeFrame(frame: string) {
    const lines = frame.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event:"));
    const event = eventLine?.slice(6).trim() as AiStreamEvent | undefined;
    const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!event || !dataText || !["meta", "delta", "done", "error"].includes(event)) return;
    const data = JSON.parse(dataText) as Record<string, unknown>;
    onEvent(event, data);
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer.trim());
}
