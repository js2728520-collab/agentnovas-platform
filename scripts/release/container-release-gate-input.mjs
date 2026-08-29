import path from "node:path";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${label} invalid`);
  }
  return value;
}

export function validatedContainerName(value) {
  const normalized = requiredString(value, "container name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new Error("container name invalid");
  }
  return normalized;
}

export function validatedReleaseImage(value, label) {
  const normalized = requiredString(value, label);
  const tagged = /^[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
  if (!tagged.test(normalized) || /:latest$/i.test(normalized)) {
    throw new Error(`${label} must use an explicit non-latest tag or sha256 digest`);
  }
  return normalized;
}

export function validatedAbsoluteMountSource(value, label) {
  const normalized = requiredString(value, label);
  if (!path.isAbsolute(normalized)) throw new Error(`${label} must be an absolute path`);
  if (normalized.length > 500 || normalized.includes(",") || normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error(`${label} invalid`);
  }
  return normalized;
}
