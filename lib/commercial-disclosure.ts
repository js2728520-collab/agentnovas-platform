import { createHash } from "node:crypto";

import { requiredLegalDocumentTypes } from "../packages/domain/src/commercial-membership-domain.ts";
import { commercialLegalContentSha256 } from "./commercial-legal.ts";

export type CommercialDisclosureProductIdentity = {
  operatorName: string;
  serviceRegion: string;
  supportEmail: string;
  primaryDomain: string;
};

export type NormalizedCommercialDisclosureSubmission = {
  locale: string;
  reason: string;
  productIdentity: CommercialDisclosureProductIdentity;
  documents: Array<{
    type: typeof requiredLegalDocumentTypes[number];
    contentMarkdown: string;
    contentSha256: string;
  }>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DISCLOSURE_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function bounded(value: unknown, minimum: number, maximum: number, code: string) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function normalizePrimaryDomain(value: unknown) {
  const domain = bounded(value, 3, 160, "DISCLOSURE_DOMAIN_INVALID").toLowerCase();
  if (!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("DISCLOSURE_DOMAIN_INVALID");
  }
  return domain;
}

export function normalizeCommercialDisclosureSubmission(input: unknown): NormalizedCommercialDisclosureSubmission {
  const root = record(input);
  const locale = bounded(root.locale, 2, 16, "DISCLOSURE_LOCALE_INVALID");
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new Error("DISCLOSURE_LOCALE_INVALID");
  const reason = bounded(root.reason, 3, 500, "DISCLOSURE_REASON_INVALID");

  const identityInput = record(root.productIdentity);
  const operatorName = bounded(identityInput.operatorName, 2, 160, "DISCLOSURE_IDENTITY_INCOMPLETE");
  const serviceRegion = bounded(identityInput.serviceRegion, 2, 300, "DISCLOSURE_IDENTITY_INCOMPLETE");
  const supportEmail = bounded(identityInput.supportEmail, 5, 254, "DISCLOSURE_IDENTITY_INCOMPLETE").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error("DISCLOSURE_IDENTITY_INCOMPLETE");
  const primaryDomain = normalizePrimaryDomain(identityInput.primaryDomain);

  const documentsInput = record(root.documents);
  const suppliedTypes = Object.keys(documentsInput).sort();
  const requiredTypes = [...requiredLegalDocumentTypes].sort();
  if (suppliedTypes.length !== requiredTypes.length || suppliedTypes.some((type, index) => type !== requiredTypes[index])) {
    throw new Error("DISCLOSURE_DOCUMENT_SET_INVALID");
  }
  const documents = requiredLegalDocumentTypes.map((type) => {
    const contentMarkdown = bounded(documentsInput[type], 40, 200_000, "DISCLOSURE_DOCUMENT_CONTENT_INVALID");
    return { type, contentMarkdown, contentSha256: commercialLegalContentSha256(contentMarkdown) };
  });

  return {
    locale,
    reason,
    productIdentity: { operatorName, serviceRegion, supportEmail, primaryDomain },
    documents,
  };
}

export function commercialDisclosureSnapshotHash(input: NormalizedCommercialDisclosureSubmission) {
  const canonical = JSON.stringify({
    locale: input.locale,
    productIdentity: input.productIdentity,
    documents: input.documents.map(({ type, contentSha256 }) => ({ type, contentSha256 })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
