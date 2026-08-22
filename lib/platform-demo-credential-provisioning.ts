import type { Pool } from "pg";

import { encryptIntegrationSecret } from "./integration-credentials.ts";
import type { PlatformDemoProvider } from "./platform-demo-adapters.ts";

type ProviderCredential = {
  label: string;
  apiKey: string;
  secret: string;
  passphrase?: string;
};

export type PlatformDemoCredentialInput = Partial<Record<PlatformDemoProvider, ProviderCredential>>;

const PROVIDERS: PlatformDemoProvider[] = ["okx", "binance", "bybit"];
const STRATEGIES = ["ai_conservative", "ai_balanced", "ai_aggressive"] as const;

function credentialValue(value: unknown, code: string, maximum = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  const hasControlCharacter = [...text].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (text.length < 8 || text.length > maximum || hasControlCharacter) {
    throw new Error(code);
  }
  return text;
}

function normalizedCredentials(input: PlatformDemoCredentialInput) {
  const supplied = PROVIDERS.filter((provider) => input[provider] !== undefined);
  if (!supplied.length) throw new Error("PLATFORM_DEMO_CREDENTIALS_EMPTY");
  return supplied.map((provider) => {
    const credential = input[provider]!;
    const label = typeof credential.label === "string" ? credential.label.trim() : "";
    if (label.length < 3 || label.length > 80) throw new Error("PLATFORM_DEMO_LABEL_INVALID");
    const passphrase = credential.passphrase === undefined ? undefined
      : credentialValue(credential.passphrase, "PLATFORM_DEMO_PASSPHRASE_INVALID", 256);
    if (provider === "okx" && !passphrase) throw new Error("PLATFORM_DEMO_OKX_PASSPHRASE_REQUIRED");
    if (provider !== "okx" && passphrase) throw new Error("PLATFORM_DEMO_PASSPHRASE_UNSUPPORTED");
    return {
      provider,
      label,
      apiKey: credentialValue(credential.apiKey, "PLATFORM_DEMO_CREDENTIAL_INVALID"),
      secret: credentialValue(credential.secret, "PLATFORM_DEMO_CREDENTIAL_INVALID"),
      passphrase,
    };
  });
}

export async function provisionPlatformDemoCredentials(
  pool: Pool,
  input: PlatformDemoCredentialInput,
  dependencies: { encryptSecret?: (value: string) => Promise<string> } = {},
) {
  const credentials = normalizedCredentials(input);
  const encryptSecret = dependencies.encryptSecret ?? encryptIntegrationSecret;
  const encrypted = await Promise.all(credentials.map(async (credential) => ({
    provider: credential.provider,
    label: credential.label,
    apiKeyCiphertext: await encryptSecret(credential.apiKey),
    secretCiphertext: await encryptSecret(credential.secret),
    passphraseCiphertext: credential.passphrase ? await encryptSecret(credential.passphrase) : null,
  })));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:platform-demo-credential-provisioning:v1', 0))");
    const actors = await client.query<{ id: string }>(`
      SELECT id FROM users
      WHERE role='hq_admin' AND status='active'
      ORDER BY created_at,id
      FOR UPDATE
    `);
    if (actors.rowCount !== 1) throw new Error("PLATFORM_DEMO_CREDENTIAL_ACTOR_NOT_UNIQUE");
    const actorUserId = actors.rows[0].id;
    for (const credential of encrypted) {
      const before = (await client.query<{
        id: string;
        enabled: boolean;
        kill_switch_enabled: boolean;
        last_verification_status: string | null;
      }>(`
        SELECT id,enabled,kill_switch_enabled,last_verification_status
        FROM platform_demo_accounts WHERE provider=$1 FOR UPDATE
      `, [credential.provider])).rows[0];
      const account = (await client.query<{ id: string }>(`
        INSERT INTO platform_demo_accounts(
          id,provider,label,api_key_ciphertext,secret_ciphertext,passphrase_ciphertext,
          enabled,kill_switch_enabled,updated_by,last_verified_at,last_verification_status
        ) VALUES($1,$2,$3,$4,$5,$6,false,true,$7,NULL,NULL)
        ON CONFLICT(provider) DO UPDATE SET
          label=EXCLUDED.label,
          api_key_ciphertext=EXCLUDED.api_key_ciphertext,
          secret_ciphertext=EXCLUDED.secret_ciphertext,
          passphrase_ciphertext=EXCLUDED.passphrase_ciphertext,
          enabled=false,
          kill_switch_enabled=true,
          updated_by=EXCLUDED.updated_by,
          last_verified_at=NULL,
          last_verification_status=NULL,
          updated_at=now()
        RETURNING id
      `, [
        crypto.randomUUID(), credential.provider, credential.label,
        credential.apiKeyCiphertext, credential.secretCiphertext,
        credential.passphraseCiphertext, actorUserId,
      ])).rows[0];
      for (const strategyCode of STRATEGIES) {
        await client.query(`
          INSERT INTO platform_demo_card_controls(
            provider,strategy_code,kill_switch_enabled,updated_by,updated_at
          ) VALUES($1,$2,true,$3,now())
          ON CONFLICT(provider,strategy_code) DO UPDATE SET
            kill_switch_enabled=true,updated_by=EXCLUDED.updated_by,updated_at=now()
        `, [credential.provider, strategyCode, actorUserId]);
      }
      await client.query(`
        INSERT INTO audit_logs(
          id,actor_user_id,action,subject_type,subject_id,before_json,after_json
        ) VALUES($1,$2,'system.platform_demo_credentials_provisioned','platform_demo_account',$3,$4,$5)
      `, [crypto.randomUUID(), actorUserId, account.id, JSON.stringify(before ? {
        existed: true,
        enabled: before.enabled,
        killSwitchEnabled: before.kill_switch_enabled,
        verificationStatus: before.last_verification_status,
      } : { existed: false }), JSON.stringify({
        provider: credential.provider,
        enabled: false,
        killSwitchEnabled: true,
        verificationStatus: null,
        hasApiKey: true,
        hasSecret: true,
        hasPassphrase: Boolean(credential.passphraseCiphertext),
        cardKillSwitchesEnabled: true,
      })]);
    }
    await client.query("COMMIT");
    return {
      ok: true as const,
      actorUserId,
      providers: encrypted.map((credential) => credential.provider).sort(),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
