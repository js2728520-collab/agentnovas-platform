export const CLIENT_LEGAL_GATE_EXEMPT_ROUTES = new Set([
  "/api/access/me/effective",
  "/api/account/password",
  "/api/account/profile",
  "/api/account/sessions",
  "/api/membership/legal-consent",
]);

export function clientRouteRequiresLegalConsent(pathname: string) {
  return pathname.startsWith("/api/")
    && !pathname.startsWith("/api/auth/")
    && !CLIENT_LEGAL_GATE_EXEMPT_ROUTES.has(pathname);
}
