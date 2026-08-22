type DemoWorkerResult = { status: string };

export async function runDemoWorkerIteration<Result extends DemoWorkerResult>(input: {
  processNext: () => Promise<Result | null>;
  markSuccess: () => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<unknown>;
  idleDelayMs?: number;
}) {
  const result = await input.processNext();
  if (!result || result.status === "disabled") {
    await input.sleep(input.idleDelayMs ?? 5_000);
    return result;
  }
  await input.markSuccess();
  return result;
}
