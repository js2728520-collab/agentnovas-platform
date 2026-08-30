import type { Pool } from "pg";

import { loadBrokerPrivateKey, processSecretEnvelope } from "./ai-secret-broker.ts";
import {
  claimSecretCommand,
  completeSecretCommand,
  failSecretCommand,
} from "./ai-secret-broker-repository.ts";

export async function processNextSecretCommand(pool: Pool, input: {
  brokerInstanceId: string;
  brokerPrivateKeyPath: string;
  managedDirectory: string;
}) {
  const claimed = await claimSecretCommand(pool,{ brokerInstanceId: input.brokerInstanceId });
  if (!claimed) return { processed: false };
  try {
    const brokerPrivateKeyPem = await loadBrokerPrivateKey(input.brokerPrivateKeyPath);
    const receipt = await processSecretEnvelope(claimed.command,{
      brokerPrivateKeyPem,
      managedDirectory: input.managedDirectory,
      brokerInstanceId: input.brokerInstanceId,
    });
    await completeSecretCommand(pool,{
      brokerInstanceId: input.brokerInstanceId,
      fencingToken: claimed.fencingToken,
      receipt,
    });
    return { processed: true,status: "succeeded" as const,commandId: claimed.command.commandId };
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "AI_SECRET_BROKER_FAILED";
    await failSecretCommand(pool,{
      commandId: claimed.command.commandId,
      brokerInstanceId: input.brokerInstanceId,
      fencingToken: claimed.fencingToken,
      errorCode,
    });
    return { processed: true,status: "failed" as const,commandId: claimed.command.commandId,errorCode };
  }
}
