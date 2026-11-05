# Team console

The internal site where the team reviews and retries Trials and checks usage.
It is a TanStack Start app that runs on Cloudflare Workers behind Cloudflare Access.
See ADR 0004 (`docs/adr/0004-team-console-on-cloudflare-workers-behind-access.md`) for why, and `CONTEXT.md` for the terms.

## Tooling

- [Vite+](https://viteplus.dev) (`vp`) runs dev, build, format, lint, type checks and tests.
  It is pinned to an exact version in `package.json`.
- bun is the package manager, set through `devEngines`, with `bun.lock` committed.
  The app never runs on the bun runtime: dev and production both run on workerd through `@cloudflare/vite-plugin`.
- Tailwind v4 and shadcn/ui for styling (`bunx shadcn@latest add <component>` adds components).
- TanStack Query owns server data.
  Route loaders call `context.queryClient.ensureQueryData(...)` and components read the same query with `useSuspenseQuery`.

## Run

```bash
bun install
infisical run --env=dev --path=/team-console -- vp dev --port 3000
```

The page lists whether each secret is set, never its value.
Without Infisical, `vp dev` still starts and reports both secrets as missing.

## Test and check

```bash
vp check   # format, lint and type checks
vp test    # Vitest
```

`vp check --fix` formats and applies lint fixes.
Tests cover plain modules in Node, so the Cloudflare plugin is left out when Vitest runs.

## Secrets

| Name           | What it is                                                        |
| -------------- | ----------------------------------------------------------------- |
| `ADMIN_TOKEN`  | Sent to mobile/server as `x-admin-token` from server functions.   |
| `API_BASE_URL` | mobile/server's base URL: local in dev, production when deployed. |

Values live in Infisical, in the `buddy-walk` project under `/team-console`, with `dev` and `prod` environments.
Production gets them through an Infisical Secret Sync to the Worker.
Locally, `infisical run` sets them as process env, and workerd reads them because `wrangler.jsonc` lists them under `secrets.required`.
`.env.example` lists the names; real env files are gitignored.

Only server functions may read secrets (`import { env } from "cloudflare:workers"`).
The browser never sees `ADMIN_TOKEN`.

After changing `wrangler.jsonc`, run `bun run cf-typegen` to regenerate `worker-configuration.d.ts`.

## Deploy

Workers Builds deploys the `Buddy-Walk/buddy-walk` repo with `team-console` as the root directory.
A push to `main` deploys production to the `workers.dev` URL, and other branches get preview URLs.
Cloudflare Access protects both, letting in members of the `Buddy-Walk` GitHub org.

Workers Builds runs `bun run build`, then `bunx wrangler deploy` on `main` or `bunx wrangler versions upload` on other branches.
Those inherit the secrets already on the Worker, so they need the Secret Sync in place.

`bun run deploy` builds and deploys by hand with wrangler, if Workers Builds is unavailable.
