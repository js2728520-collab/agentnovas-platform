export const RESEND_SENDER_DOMAIN = "mail.agentnovas.com";

const senderByCategory: Record<string, string> = {
  account: `account@${RESEND_SENDER_DOMAIN}`,
  deposit: `notice@${RESEND_SENDER_DOMAIN}`,
  operations: `operations@${RESEND_SENDER_DOMAIN}`,
};

export function resendSenderForCategory(category: "account" | "deposit" | "operations") {
  return senderByCategory[category];
}

export function publicEmailIntegrationStatus(input: {
  configured: boolean;
  senderDomainVerified: boolean;
  apiKeyPresent: boolean;
  lastTestAt?: string | null;
}) {
  return {
    provider: "resend",
    senderDomain: RESEND_SENDER_DOMAIN,
    configured: input.configured,
    senderDomainVerified: input.senderDomainVerified,
    apiKeyPresent: input.apiKeyPresent,
    lastTestAt: input.lastTestAt ?? null,
  };
}

export function notificationChannelStatus(input: { configured: boolean; verified: boolean }) {
  if (!input.configured) return { status: "unconfigured" as const, canSend: false };
  if (!input.verified) return { status: "pending_verification" as const, canSend: false };
  return { status: "ready" as const, canSend: true };
}

