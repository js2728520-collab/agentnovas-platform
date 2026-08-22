type DemoWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export function demoExecutionWorkerConfig(environment: DemoWorkerEnvironment = process.env) {
  const processEnabled = environment.DEMO_EXECUTION_WORKER_ENABLED === "true";
  const externalWritesEnabled = environment.PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED === "true";
  return {
    processEnabled,
    externalWritesEnabled,
    executionEnabled: processEnabled && externalWritesEnabled,
  } as const;
}
