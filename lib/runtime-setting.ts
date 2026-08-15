import { env } from "cloudflare:workers";

export function runtimeSetting(name: string) {
  const workerValue = (env as unknown as Record<string, unknown>)[name];
  if (typeof workerValue === "string" && workerValue.length) return workerValue;
  return process.env[name];
}
