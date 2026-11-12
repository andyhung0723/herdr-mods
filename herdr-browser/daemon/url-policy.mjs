const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:", "data:"]);

// Scheme-less input ("localhost:3000", "example.com") defaults to http://.
// file:, chrome:, edge:, javascript: etc. are rejected: they would let any
// caller of the daemon read local files or reach privileged browser pages.
export function normalizeNavigationUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("URL is required");

  const hasAuthorityScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const isOpaqueAllowed = /^(about|data):/i.test(raw);
  const candidate = hasAuthorityScheme || isOpaqueAllowed ? raw : `http://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" (allowed: ${[...ALLOWED_PROTOCOLS].join(", ")})`);
  }
  return parsed.href;
}
