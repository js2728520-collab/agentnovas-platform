/**
 * 规范化 JSON 哈希。
 *
 * 「两次请求是不是同一件事」在这个平台上要靠哈希回答：决策轮的幂等
 * （INV-8：相同 card/candle/contract 的重试必须返回同一轮）、研发步骤的检查点、
 * 策略 DSL 的合同哈希，用的都是这一个函数。
 *
 * 它必须是确定性的，因此规则写死在这里：
 * - 对象键按码位排序，键序不影响结果；
 * - `undefined` 的属性视为不存在，不参与哈希；
 * - 非有限数字（NaN / Infinity）直接抛错，不静默转成 null——
 *   它们在 JSON 里都会变成 null，会让两组不同的输入哈希相同。
 *
 * 此前叫 hashResearchStepInput，住在 lib/research-steps.ts 里和几个
 * database.query 混在一起。它本身没有任何 I/O，只是位置让整条依赖链看起来不纯。
 */

function toCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("步骤输入包含非有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(toCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${toCanonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("步骤输入包含不可序列化值");
}

/** 规范化序列化。导出供需要比对而不需要哈希的地方使用。 */
export const canonicalJson = toCanonicalJson;

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 规范化 JSON 的 SHA-256。
 *
 * 异步只是因为 WebCrypto 的 digest 是异步的——这里没有 I/O，
 * 相同输入永远得到相同输出。
 */
export async function canonicalJsonSha256(value: unknown) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(toCanonicalJson(value))));
}
