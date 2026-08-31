import type { PaymentSecretEnvelope } from "@/packages/payments/src/udun-service-management";

export type PaymentSecretConfiguration = {
  provider: "udun";
  gatewayBaseUrl: string;
  merchantId: string;
  apiKey: string;
  callbackUrl: string;
  addressRequestCoinField: "mainCoinType" | "coinType";
};

function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(value: string) {
  const body = value.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("PAYMENT_SECRET_PUBLIC_KEY_INVALID");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateConfiguration(input: PaymentSecretConfiguration) {
  if (input.provider !== "udun") throw new Error("PAYMENT_SECRET_PROVIDER_INVALID");
  if (!/^https:\/\/[^\s/]+\/?$/.test(input.gatewayBaseUrl)) throw new Error("PAYMENT_SECRET_GATEWAY_INVALID");
  if (!/^\d{1,32}$/.test(input.merchantId)) throw new Error("PAYMENT_SECRET_MERCHANT_INVALID");
  if (input.apiKey.length < 8 || input.apiKey.length > 256 || /\s/.test(input.apiKey)) throw new Error("PAYMENT_SECRET_API_KEY_INVALID");
  if (!/^https:\/\/[^\s/]+\/api\/integrations\/payments\/udun\/webhook$/.test(input.callbackUrl)) {
    throw new Error("PAYMENT_SECRET_CALLBACK_INVALID");
  }
  if (input.addressRequestCoinField !== "mainCoinType" && input.addressRequestCoinField !== "coinType") {
    throw new Error("PAYMENT_SECRET_PROTOCOL_INVALID");
  }
  return input;
}

export async function encryptPaymentSecretPayload(input: {
  keyId: string;
  publicKeyPem: string;
  configuration: PaymentSecretConfiguration;
}): Promise<PaymentSecretEnvelope> {
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(input.keyId)) throw new Error("PAYMENT_SECRET_KEY_ID_INVALID");
  const configuration = validateConfiguration(input.configuration);
  const publicKey = await crypto.subtle.importKey(
    "spki", pemBytes(input.publicKeyPem), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ version: "v1", ...configuration }));
  const [ciphertext, wrappedKey] = await Promise.all([
    crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, payload),
    crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey),
  ]);
  rawKey.fill(0);
  return {
    version: "v1", keyId: input.keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}
