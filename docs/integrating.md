# Pointing an app at whaloc

Wired together, the whole WhatsApp path — register a number, send, watch it go `sent` →
`delivered` → `read`, receive a reply, moderate a template — runs offline in your own
docker-compose: no Meta app, no phone number, no public tunnel for webhooks.

There are only two moving parts. Your app calls whaloc instead of `graph.facebook.com`, and
whaloc calls your app's webhook receiver instead of Meta's servers calling it. Everything below
is about making those two directions agree.

## 1. Run whaloc beside your app

```yaml
services:
  app:
    build: .
    environment:
      # See §2. The version segment is mandatory.
      GRAPH_API_BASE_URL: http://whaloc:8080/v25.0
      META_APP_SECRET: dev-app-secret
      META_WEBHOOK_VERIFY_TOKEN: dev-verify-token

  whaloc:
    image: ghcr.io/dgadelha/whaloc:latest
    ports: ["3010:8080"]
    environment:
      # The URL whaloc puts in media descriptors. It has to resolve *inside* the compose
      # network, because it is your app — not your browser — that fetches that absolute URL.
      # The web UI resolves media on its own origin, so this does not break previews.
      WHALOC_PUBLIC_URL: http://whaloc:8080
      # Where Meta would POST: your app's webhook receiver, by service name.
      WHALOC_WEBHOOK_URL: http://app:3001/meta-webhooks
      WHALOC_APP_SECRET: dev-app-secret # = the app's Meta app secret
      WHALOC_WEBHOOK_VERIFY_TOKEN: dev-verify-token # = the app's verify token
      # Runs the hub.challenge handshake at boot, so the logs say immediately whether the
      # receiver is up and agrees on the token.
      WHALOC_VERIFY_ON_START: "true"
      # Optional: keep conversations, templates and media across restarts. Without it the
      # volume below only ever holds media bytes.
      # WHALOC_DB_PATH: /data/whaloc.db
    volumes:
      - whaloc_data:/data
    depends_on:
      app:
        condition: service_healthy

volumes:
  whaloc_data:
```

The boot handshake is a **single attempt**, and an app under a watch-mode runner can take 10–20 s
to serve its first request — ungated, a cold `docker compose up` logs `webhook handshake failed`
and nothing else is wrong. Either gate whaloc on a healthcheck of the receiver, as above, or
ignore the boot failure and re-run the handshake whenever you like: `POST
http://localhost:3010/api/webhook/handshake`, or the "Verify webhook" button in the UI.

A healthcheck that proves the receiver is really answering handshakes:

```yaml
app:
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3001/meta-webhooks?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=ok"]
    interval: 30s
    start_period: 60s
    start_interval: 2s
```

The UI is then on <http://localhost:3010> (any free host port will do — whaloc always listens on
8080 inside the container).

## 2. Point the app at whaloc

```yaml
GRAPH_API_BASE_URL: http://whaloc:8080/v25.0
```

The **version segment is mandatory**. Cloud API clients typically strip a trailing slash from the
base URL and concatenate `/{id}` paths onto it — they never insert a version — so a base URL
without one produces `http://whaloc:8080/573542517421694/messages`, which whaloc does not route.
whaloc mounts the same router under **every** `/v<major>.<minor>` prefix, so `v25.0`, `v23.0` or
`v99.9` all work; pick the one your app would use against Meta.

Set it for every service that talks to the Graph API — the API process, outbound workers, media
downloaders. A shared env anchor (`x-base-env: &base-env`) is the least error-prone way.

## 3. Which value has to match which

| whaloc                        | your app                                       | Must match because                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHALOC_APP_SECRET`           | the Meta **app secret** the receiver verifies   | whaloc signs `X-Hub-Signature-256` with it; a receiver that fails closed answers 401 on every delivery                                                                                                        |
| `WHALOC_WEBHOOK_VERIFY_TOKEN` | the receiver's **verify token**                 | `GET <receiver>` compares the token before echoing `hub.challenge`, else 403                                                                                                                                  |
| `WHALOC_WEBHOOK_URL`          | the receiver's service name + port + route      | e.g. `http://app:3001/meta-webhooks` — from inside the compose network, not `localhost`                                                                                                                       |
| `WHALOC_PUBLIC_URL`           | whatever fetches media                          | It is the host in every media descriptor URL; if a worker downloads media, that URL must resolve for the worker                                                                                                |
| `GRAPH_API_BASE_URL`          | —                                               | Must be whaloc's URL **with a version segment** (§2)                                                                                                                                                          |
| `WHALOC_APP_ID`               | the app's Meta **app ID**                       | Only cosmetic: it is the app ID `GET /{waba}/subscribed_apps` reports back. Setting them to the same value makes that round trip read like production; left unset, whaloc derives a stable ID instead          |

The **access token is irrelevant**: whaloc accepts any non-empty bearer token and never looks at
its contents, so whatever your app stores, encrypts and sends is fine. Set `WHALOC_TOKENS` if you
_want_ tokens to be checked — see "Error simulation" in the [README](../README.md).

## The three surfaces

whaloc serves all three on one port:

| Surface                       | Mount                                | Who uses it                                                              |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Graph API mock                | `/v25.0/…` (any `/v<major>.<minor>`) | Your app, in place of `graph.facebook.com`                               |
| Control-plane API + WebSocket | `/api/…`, `/api/ws`                  | The UI, and your test scripts: simulate the user side, inspect the state  |
| Web UI                        | `/`                                  | You: be the WhatsApp user, moderate templates, read the delivery log      |

Your app should only ever know about the first one. Anything the "WhatsApp user" does — replying,
reacting, reading — is the control plane's job, whether you drive it from the UI or from a test.

## The seeded IDs

With the default `WHALOC_SEED`, every ID is derived deterministically from the seed's natural
keys, so they are the same on every machine and after every `POST /api/reset`:

| Entity          | Id                                                    |
| --------------- | ----------------------------------------------------- |
| WABA            | `666635535888644`                                     |
| Phone number    | `573542517421694` (`+55 11 91234-5678`)               |
| Template        | `355867425910125` (`hello_whaloc` / `en`, `APPROVED`) |
| Seeded contacts | `5571990000001` (Ana, BSUID `BR.ENT.AnaSouza01`), `5571990000002` (Bruno, BSUID `BR.BrunoLima01`) |

They are also printed at boot (`seed applied`) and shown with copy buttons in the UI's
**Settings** view. Treat them as a **contract**: a downstream compose file that seeds its own
database with these IDs keeps working across whaloc versions, and if they ever have to change, it
will be a deliberate, documented change (they are covered by tests). Point a custom `WHALOC_SEED`
at your own IDs if you would rather pin them yourself.

## Smoke test

Everything here talks to whaloc directly — no assumptions about your app's own API. Run your
app's equivalents alongside once these pass.

**1 — bring it up and read the boot lines.**

```sh
docker compose up -d
docker compose logs whaloc | grep -E "seed applied|handshake"
```

`webhook handshake succeeded` means the receiver is reachable and the verify token matches.
`seed applied` carries the IDs above.

**2 — send a message through the Graph surface.** This is the call your app makes; making it by
hand first separates "whaloc is wired up" from "my app is wired up".

```sh
curl -sS -X POST http://localhost:3010/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer any-non-empty-token' \
  -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"hello from whaloc"}}'
```

The answer is Meta's: `{"messaging_product":"whatsapp","contacts":[…],"messages":[{"id":"wamid.…"}]}`.
The seeded template needs nothing created or approved either:

```sh
curl -sS -X POST http://localhost:3010/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer any-non-empty-token' \
  -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"template","template":{"name":"hello_whaloc","language":{"code":"en"}}}'
```

**3 — watch the webhooks land.** Two deliveries follow each send: `sent` immediately and
`delivered` about 800 ms later.

```sh
curl -s 'http://localhost:3010/api/webhook-deliveries?limit=5'
```

Each row carries the exact signed bytes, the target URL and your receiver's response status — a
`200` here and a signature error in your app's logs means the app secret does not match. The
**Webhooks** view of the UI shows the same log, expandable, with a redeliver button. Your
outbound message is in **Chats**, under the seeded phone number, with its status ticks.

**4 — reply as the user.** Type in the chat composer, or drive it from a script:

```sh
curl -sS -X POST http://localhost:3010/api/inbound \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"oi!"}}'
```

The inbound webhook goes to your receiver exactly as Meta's would, signed the same way.

**5 — exercise the rest of the ladder.** `read` is manual by default: the "mark read" action on
an outbound message emits the `read` status webhook, and "fail…" emits a `failed` status with a
real Meta error code (131049, 131026, 131047, 130472). Add `read:<ms>` to `WHALOC_STATUS_DELAYS`
if you would rather automate it.

## Notes and limits

- **Templates take the long way round.** A template your app submits arrives at
  `POST /v25.0/{wabaId}/message_templates`; whaloc creates it `PENDING` and auto-approves after
  `WHALOC_TEMPLATE_AUTO_APPROVE` (2 s), emitting `message_template_status_update`. A template
  send only works once the row is `APPROVED` — on whaloc's side _and_ in whatever your app stores
  about it. Set the variable to `off` to review templates by hand in the UI instead.
- **…except the seeded one.** The default seed ships `hello_whaloc` (`en`, `UTILITY`, no
  parameters) as `APPROVED` at boot — no review, no webhook, no timer — so a template send has
  something to aim at on a cold stack. Its ID is derived from
  `template:{wabaId}:{name}:{language}`, and is therefore as stable as the WABA and phone number
  IDs. For a template the real contract is **name + language**: a send goes out as
  `{name, language:{code}}`, never as the numeric ID, so renaming `hello_whaloc` or changing its
  language breaks a consumer that pre-seeded it exactly like an ID change would — at send time,
  with `132001`.
- **Media round-trips.** Uploads go to `POST /v25.0/{phoneNumberId}/media`; downloads take Meta's
  two hops (`GET /v25.0/{mediaId}?phone_number_id=…` → the `url` it returns), with `Range`
  supported and never a redirect, which is what a streaming downloader needs. The `url` is built
  from `WHALOC_PUBLIC_URL` — get that wrong and downloads fail from inside the network while
  previews still work in your browser. `DELETE /v25.0/{mediaId}` removes an object and its bytes,
  after which the ID answers the missing-object envelope — the shortest way to rehearse your
  "this media is gone" path.
- **Handles come from the Upload API.** If your app uploads a template header or a profile picture
  the way Meta documents it — `POST /v25.0/{appId}/uploads`, then `POST /v25.0/upload:{id}` with
  the bytes, then the `h` it answers — that works here unchanged, and `{appId}` accepts whatever
  `META_APP_ID` you are configured with. whaloc additionally takes a plain media ID in
  `profile_picture_handle`, which is one call instead of three if you are writing the setup script
  yourself.
- **Nothing is throttled, delayed or dropped by default** beyond the configured status ladder, so
  a client-side timeout is never in play. To exercise retry and backoff paths, arm a deterministic
  rule in **Settings → Error injection** (e.g. `rate_limit_429` with `Retry-After` and
  `X-Business-Use-Case-Usage`, for the next N sends). Nothing ever fails unless a rule says so.
- **whaloc's control plane is unauthenticated.** Publishing its port is for you, not for a shared
  environment.
- **The seeded number is registered** (`status: CONNECTED`), which is what lets it send. whaloc
  models the registration ladder, so a number can leave that state:
  `POST /v25.0/{phoneNumberId}/deregister` makes every send answer `133010` — a deliberate way to
  test how your app handles a deregistered number — and `POST /v25.0/{phoneNumberId}/register`
  puts it back. Numbers added in the UI's **Settings** view are `CONNECTED` from the start; a
  number created through `POST /v25.0/{wabaId}/phone_numbers` has to be verified and registered
  first ([SPEC §4](SPEC.md)).
- **State is in memory by default.** Uncomment `WHALOC_DB_PATH` above to keep it on the
  `whaloc_data` volume; either way the seeded IDs stay the same, so a phone number your app
  registered keeps pointing at something real after a whaloc restart. Pending timers (a scheduled
  `delivered`, an auto-approval) are dropped on restart by design.
- **A stale whaloc image fails with seed errors, not image errors.** The default seed lives in the
  image, so after a whaloc update an old image can hand you `132001` on the seeded template (or
  `code 100` / `subcode 33` on an ID) with nothing pointing at the image version. Repull or
  rebuild is the first thing to check when seeded entities "disappear".
