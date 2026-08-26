import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { sha256 } from "./auth.ts";

const CLIENT_DEVICE_COOKIE = "rc_client_device";
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_COOKIE_SECONDS = 365 * 24 * 60 * 60;

function cookieValue(request: Request, name: string) {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function clientDeviceIdentity(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
) {
  const existing = cookieValue(request, CLIENT_DEVICE_COOKIE);
  const validExisting = existing && DEVICE_TOKEN_PATTERN.test(existing) ? existing : null;
  const token = validExisting ?? randomBytes(32).toString("base64url");
  const secure = environment.NODE_ENV === "production" || new URL(request.url).protocol === "https:"
    ? "; Secure"
    : "";
  return {
    deviceHash: await sha256(token),
    isNewCookie: !validExisting,
    cookieHeader: validExisting
      ? null
      : `${CLIENT_DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DEVICE_COOKIE_SECONDS}${secure}`,
  };
}

export function clientNetworkKey(ipAddress: string | null) {
  if (!ipAddress || isIP(ipAddress) === 0) return "unattributed";
  if (isIP(ipAddress) === 4) return `ipv4:${ipAddress.split(".").slice(0, 3).join(".")}`;
  return `ipv6:${ipAddress.split(":").slice(0, 3).join(":").toLowerCase()}`;
}

export function maskNetworkAddress(ipAddress: string | null) {
  if (!ipAddress || isIP(ipAddress) === 0) return null;
  if (isIP(ipAddress) === 4) return `${ipAddress.split(".").slice(0, 3).join(".")}.x`;
  return `${ipAddress.split(":").slice(0, 3).join(":").toLowerCase()}::`;
}

export function describeClientDevice(userAgent: string | null) {
  if (!userAgent) return "未知设备";
  const bounded = userAgent.slice(0, 1_024);
  const browser = /Edg\//.test(bounded) ? "Edge"
    : /Chrome\//.test(bounded) ? "Chrome"
      : /Firefox\//.test(bounded) ? "Firefox"
        : /Safari\//.test(bounded) ? "Safari" : "浏览器";
  const system = /iPhone|iPad/.test(bounded) ? "iOS"
    : /Android/.test(bounded) ? "Android"
      : /Mac OS X|Macintosh/.test(bounded) ? "macOS"
        : /Windows/.test(bounded) ? "Windows"
          : /Linux/.test(bounded) ? "Linux" : "未知系统";
  return `${browser} · ${system}`;
}
