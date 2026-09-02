# Working on whaloc

whaloc emulates the Meta WhatsApp Cloud API. Product knowledge lives in
[README.md](README.md); the behavioral contract is [docs/SPEC.md](docs/SPEC.md) — **SPEC wins**
whenever code, docs or a request disagree with it. This file is what you need to work on the
code without re-deriving the project's rules.

## Commands

```sh
npm ci                # install exactly what package-lock.json pins
npm run dev           # server :8080 (native TS, watch) + Vite :5173, via concurrently
npm test              # vitest, all packages
npm run lint          # ESLint (typescript-eslint strict + unicorn + prettier)
npm run typecheck     # tsc --noEmit, per package
npm run format:check  # prettier (markdown and YAML included)
npm run build         # shared → server → web, in that order (see "Build order")
```

Scope any script with `--workspace @whaloc/server|shared|web`. The S3 storage specs are opt-in:
they skip without `WHALOC_TEST_S3_ENDPOINT` (see README → Development for the one-line MinIO).
npm only — no pnpm/yarn; corepack is not needed.

## Non-negotiable invariants

- **Deterministic by default.** Nothing random, no time-based surprises: clocks, schedulers and
  RNG are injected (`domain/scheduler.ts`, the `RandomBytes` parameter in `domain/ids.ts`).
  A feature that needs chance must be an explicit, inspectable rule instead.
- **Seeded IDs are a public contract.** `DEFAULT_SEED`'s natural keys (packages/server/src/config/seed.ts)
  derive the documented WABA/phone/template IDs. Changing any of them breaks downstream setups
  silently — tests pin the IDs on purpose.
- **Meta fidelity is evidence-based.** Webhook payloads are tested structurally against
  `docs/fixtures/webhooks/` — fixtures are transcribed from Meta's references or captured
  traffic, never invented. Graph errors use Meta's envelope; an unknown object ID is
  `400` / `code 100` / `error_subcode 33` (never 404). Deliberate divergences exist only if
  SPEC argues them explicitly.
- **Webhook bodies are signed over the exact bytes sent.** `domain/meta-json.ts` serializes
  once (with Meta's `\uXXXX` escaping) and that string is both the HMAC input and the wire
  body. Never re-serialize between signing and sending.
- **Migrations are append-only** (`db/migrations.ts`): add the next number, never edit an
  existing one. New columns need defaults that keep seeded/existing rows behaving identically.

## Architecture rules

Three npm workspaces: `packages/shared` (zod contracts for the control plane + WS, imported by
both sides), `packages/server` (Hono), `packages/web` (React 19 + Vite, a pure client of
`/api` + `/api/ws`).

Server layering, strictly: `graph-api/` and `control-api/` routes do parsing, validation and
HTTP mapping only; `domain/` services own behavior and never import Hono; `db/repositories/`
own all SQL (Kysely over `node:sqlite` via the in-repo dialect); nothing outside `storage/`
touches the filesystem or S3. Wiring happens in `composition.ts` via constructor injection —
plain factories, no DI framework. The Graph surface's error mapping lives in one `onError`
(`graph-api/meta-error-envelope.ts`); the control plane has its own plainer error shape.

## Build order and the `development` condition

Dev, typecheck and tests resolve `@whaloc/shared` to its **source** through the `development`
export condition; builds resolve `dist/`. That is why the root `build` script names the three
packages in order — npm has no topological ordering. If a build fails with TS2307 on
`@whaloc/shared`, build `shared` first.

## Style

- Node 24 runs the TS sources directly: code must stay erasable — no enums, namespaces or
  parameter properties — and relative imports carry their `.ts` extension.
- Prettier: tabs, width 120, double quotes. Kebab-case filenames. Let `npm run format` settle
  arguments.
- User-facing text (UI strings, docs, error messages) writes "ID"/"IDs"; wire and field names
  (`wa_id`, `message_id`, JSON keys, route segments) keep their real casing, backticked in prose.
- Comments state constraints the code can't ("why"), never narrate a change or restate the next
  line. Doc comments follow the existing voice — read a few before writing one.

## Testing conventions

Route-level tests go through `app.request()` on the composed test app
(`packages/server/src/testing/test-app.ts`, in-memory DB + scratch media). Domain timing uses
the injectable scheduler, not real sleeps. Webhook delivery tests run against the local capture
server helper. New behavior ships with tests; a bug fix pins the corrected behavior. The full
gate is what CI runs: lint, typecheck, test, build — plus `format:check`.

## Gotchas

- `node:sqlite` still emits an ExperimentalWarning on Node 24 — runtime scripts and the vitest
  config already pass `--disable-warning=ExperimentalWarning`; keep it when adding entry points.
- Never edit `docs/meta-openapi/*.yaml` — they are Meta's vendored specs (reference material,
  Meta Platform Terms, known to contain their own defects).
- The web dev server (Vite :5173) proxies `/api`, `/api/ws`, `/v*.*` and `/whaloc-media`; the
  server's own `/` serves the built bundle only after `npm run build`.
- The Docker publish workflow needs the `DOCKER_HUB_USERNAME` variable **and**
  `DOCKER_HUB_TOKEN` secret to include Docker Hub; with either absent it publishes GHCR only,
  by design.
