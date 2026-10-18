# Security guidance for this repository

<!-- Read by the security-guidance plugin's model-backed reviews. Combined cap
     across all locations is 8 KB. Keep it to rules specific to THIS repo — the
     plugin already carries a general vulnerability checklist. -->

## Data handling
- Never log request bodies, `email`, `password`, `token`, or any `*_secret` field at any
  level.
- TODO: point at your data-classification doc and name the fields that must be redacted.

## Authorization
- Only `requireSession` (apps/api/src/auth/middleware.ts) reads the session cookie or the
  `Authorization` header. A route or helper that reads either directly bypasses the rule
  `csrfGuard` relies on (bearer present → cookie ignored) and reopens CSRF.
- Routes that change state use POST, PUT, PATCH, or DELETE, never GET. `csrfGuard` checks
  only those methods, and `SameSite=Lax` sends the cookie on cross-site GET navigations.

## Cryptography
- Token and signature comparison uses a constant-time function, never `===` or `==`.
- No homemade crypto. Use the platform library.

## Dependencies
- A new runtime dependency is a finding unless the diff includes a justification comment.
- Any package with a postinstall script is a finding.
