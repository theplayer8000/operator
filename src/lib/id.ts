// ID generation for user-created records.
//
// crypto.randomUUID() only exists in a secure context (localhost or HTTPS).
// Operator is reached over Tailscale at a bare IP (http://100.x.x.x:5173),
// which browsers treat as insecure — so calling it directly throws and takes
// down whichever page fired it. Everything that mints an ID goes through here.

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
