export const RESEND_SENDER_ADDRESS = "noreply@agentnovas.com";
export const RESEND_SENDER_DOMAIN = "agentnovas.com";
export const NOTIFICATION_CONTACT_ADDRESSES = Object.freeze({
  support: "support@agentnovas.com",
  security: "security@agentnovas.com",
  billing: "billing@agentnovas.com",
  operations: "operations@agentnovas.com",
});

export function resendSenderForCategory(category: "account" | "deposit" | "operations") {
  void category;
  return RESEND_SENDER_ADDRESS;
}

export function publicEmailIntegrationStatus(input: {
  configured: boolean;
  senderDomainVerified: boolean;
  apiKeyPresent: boolean;
  webhookSecretPresent?: boolean;
  allowlistPresent?: boolean;
  templatesReady?: boolean;
  suppressionReady?: boolean;
  workerEnabled?: boolean;
  sendAuthorized?: boolean;
  lastTestAt?: string | null;
  lastTestStatus?: string | null;
  lastTestErrorCode?: string | null;
  workerHeartbeatAt?: string | null;
  inboundMailboxesVerified?: boolean;
}) {
  return {
    provider: "resend",
    senderAddress: RESEND_SENDER_ADDRESS,
    senderDomain: RESEND_SENDER_DOMAIN,
    configured: input.configured,
    senderDomainVerified: input.senderDomainVerified,
    apiKeyPresent: input.apiKeyPresent,
    webhookSecretPresent: input.webhookSecretPresent ?? false,
    allowlistPresent: input.allowlistPresent ?? false,
    templatesReady: input.templatesReady ?? false,
    suppressionReady: input.suppressionReady ?? false,
    workerEnabled: input.workerEnabled ?? false,
    sendAuthorized: input.sendAuthorized ?? false,
    effectiveStatus: input.configured
      && input.senderDomainVerified
      && input.apiKeyPresent
      && input.webhookSecretPresent
      && input.allowlistPresent
      && input.templatesReady
      && input.suppressionReady
      && input.workerEnabled
      && input.sendAuthorized ? "ready" : "configured_not_sent",
    lastTestAt: input.lastTestAt ?? null,
    lastTestStatus: input.lastTestStatus ?? null,
    lastTestErrorCode: input.lastTestErrorCode ?? null,
    workerHeartbeatAt: input.workerHeartbeatAt ?? null,
    contactAddresses: NOTIFICATION_CONTACT_ADDRESSES,
    inboundMailboxesVerified: input.inboundMailboxesVerified ?? false,
  };
}

export function notificationChannelStatus(input: { configured: boolean; verified: boolean }) {
  if (!input.configured) return { status: "unconfigured" as const, canSend: false };
  if (!input.verified) return { status: "pending_verification" as const, canSend: false };
  return { status: "ready" as const, canSend: true };
}
