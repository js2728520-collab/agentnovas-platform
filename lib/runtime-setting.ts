const workerEnvironment = process.env.DATABASE_URL?.trim()
  ? null
  : await import("cloudflare:workers").then(module => module.env);

export function runtimeSetting(name: string) {
  const workerValue = (workerEnvironment as unknown as Record<string, unknown> | null)?.[name];
  if (typeof workerValue === "string" && workerValue.length) return workerValue;
  return process.env[name];
}
