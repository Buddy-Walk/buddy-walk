# The Team console is its own TanStack Start app on Cloudflare Workers, behind Access

The internal pages mobile/server used to serve (`lastMetersTests.html`, then `usage.html`) move into `team-console/`, a TanStack Start app at the repo root that runs on Cloudflare Workers.
The Last Meters page had grown to about 2,000 lines of inline HTML, CSS, and script with no bundler, so it could not be split into modules, typed, or tested.

Cloudflare Access sits in front of every console URL, previews included, and lets in members of the `Buddy-Walk` GitHub org.
The browser never sees `ADMIN_TOKEN`.
Start server functions on the Worker hold it as a secret and call mobile/server with the `x-admin-token` header, so mobile/server keeps its auth and needs no CORS change.
Responses are checked against zod schemas in the server functions, so a change in mobile/server's shape fails there.

The console's secrets come from Infisical, which syncs them to the Worker in production and injects them with `infisical run` locally.
Local dev talks to a local mobile/server, and every deployed console, previews included, talks to the production API through one base URL secret, so the API host can change without touching the console.

The console uses bun as its package manager with its own lockfile, while the root and `mobile/` stay on npm until a separate migration.
It runs on workerd in dev and production, never on the bun runtime.

The public companion viewer stays on mobile/server, because the app shares its URLs with people outside the team.

## Considered Options

- **Keep the page on mobile/server and split it into static files.**
  Rejected: without a bundler, modules and types stay awkward, and the token still has to sit in the page.
- **A plain Vite SPA that holds the token in the browser.**
  Rejected: anyone with the page can read the token, and mobile/server would need the console's origin in `ALLOWED_ORIGINS`.
- **Cloudflare Pages.**
  Rejected: new work on Cloudflare goes to Workers, which is TanStack Start's Cloudflare target.
- **Nest the app inside `mobile/`.**
  Rejected: the console is not part of the mobile app and should build, lint, and deploy on its own.
