import pg from "pg";

import { recordEmailProviderReadiness } from "../lib/email-provider-readiness.ts";

if (process.env.ALLOW_EMAIL_READINESS_UPDATE !== "1") {
  throw new Error("必须显式设置 ALLOW_EMAIL_READINESS_UPDATE=1 才能更新邮件 readiness");
}
const connectionString = process.env.DATABASE_URL?.trim();
const action = process.env.EMAIL_READINESS_ACTION?.trim();
const evidenceReference = process.env.EMAIL_READINESS_EVIDENCE_REFERENCE?.trim();
if (!connectionString || !evidenceReference || (action !== "activate" && action !== "disable")) {
  throw new Error("DATABASE_URL、EMAIL_READINESS_ACTION 和 EMAIL_READINESS_EVIDENCE_REFERENCE 均为必填");
}

function explicitBoolean(name) {
  const value = process.env[name];
  if (value !== "0" && value !== "1") throw new Error(`${name} 必须显式填写 0 或 1`);
  return value === "1";
}

const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "agentnovas-email-readiness-cli",
});
try {
  const result = await recordEmailProviderReadiness(pool, {
    action,
    evidenceReference,
    senderDomainVerified: explicitBoolean("EMAIL_SENDER_DOMAIN_VERIFIED"),
    webhookVerified: explicitBoolean("EMAIL_WEBHOOK_VERIFIED"),
    templatesVerified: explicitBoolean("EMAIL_TEMPLATES_VERIFIED"),
    suppressionEnabled: explicitBoolean("EMAIL_SUPPRESSION_ENABLED"),
    inboundMailboxesVerified: explicitBoolean("EMAIL_INBOUND_MAILBOXES_VERIFIED"),
  });
  process.stdout.write(`EMAIL_PROVIDER_STATUS=${result.status}\n`);
  process.stdout.write("EMAIL_SEND_ENVIRONMENT_SWITCH=unchanged\n");
} finally {
  await pool.end();
}
