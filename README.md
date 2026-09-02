# whaloc

[![CI](https://github.com/dgadelha/whaloc/actions/workflows/ci.yml/badge.svg)](https://github.com/dgadelha/whaloc/actions/workflows/ci.yml)
[![Docker](https://github.com/dgadelha/whaloc/actions/workflows/docker.yml/badge.svg)](https://github.com/dgadelha/whaloc/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

whaloc is a local emulator of the **Meta WhatsApp Cloud API (Graph API v25.0)** in a single
Docker image. It plays Meta's whole side of a WhatsApp integration — accepting sends, minting
Meta-shaped `wamid`s, walking messages up the status ladder, moderating templates, storing media
and **POSTing signed webhooks back to your app** — so an application that talks to the Cloud API
runs entirely offline: no Meta app, no business number, no public tunnel, no shared sandbox that
somebody else's test just reset. Point your app's `GRAPH_API_BASE_URL` at whaloc, open the web
UI, and be the WhatsApp user on the other side of the conversation.

It is **deterministic by default**: nothing fails, drops or changes state on its own, and
everything interesting — a read receipt, a rate limit, an expired token, a template rejection,
a number change — happens because you asked for it, from the UI or from a test.

What is in the box:

- **The Graph surface your app already calls** — messages of every type, media upload, deletion
  and the two-hop download with `Range`, the resumable Upload API that mints real
  `header_handle`s, templates with Meta's filters and cursors, phone-number management, the
  business profile, `subscribed_apps` — answering with Meta's exact envelopes, `fbtrace_id` and
  error codes.
- **Signed webhooks, and the log to prove it.** Inbound messages, statuses, template and quality
  events, all `X-Hub-Signature-256`-signed over the exact bytes sent. Every attempt is stored,
  inspectable and redeliverable.
- **A chat-style web UI** where you act as the WhatsApp user: reply, react, send media and
  location, mark delivered/read, fail a message with a real Meta error code, approve or reject a
  template as a moderator would.
- **Deterministic error simulation** — a bearer-token registry whose tokens you can expire,
  injection rules (`always`, `next N`, `every Nth`) with Meta's rate-limit envelopes and
  throttling headers, and media that expires on a TTL.
- **Real edges to test against**: the phone-number registration ladder (a deregistered number
  answers `133010`), business-scoped user IDs and `user_changed_number`, media in a directory or
  in **S3**, and whole-state **export/import** so a reproduction is one JSON file.
- **A control-plane API + WebSocket** for tests, so everything the UI can do, a script can do.
- Configured **entirely through environment variables**, seeded deterministically: the same IDs
  on every machine, every run.

Three surfaces share **one port**:

| Surface                       | Mount                                | Purpose                                                                 |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Graph API mock                | `/v25.0/…` (any `/v<major>.<minor>`) | The endpoints the app under test calls                                  |
| Control-plane API + WebSocket | `/api/…`, `/api/ws`                  | Inspect state and simulate the user side, from the UI or tests          |
| Web UI                        | `/` (static React bundle)            | Chat-style UI: be the WhatsApp user, moderate templates, watch webhooks |

Full behavioral contract: [docs/SPEC.md](docs/SPEC.md). Wiring it into your own compose stack:
[docs/integrating.md](docs/integrating.md).

**Contents** — [Quickstart](#quickstart) · [Configuration](#configuration) ·
[Graph API coverage](#graph-api-coverage) · [Identities](#identities-and-number-changes) ·
[Error simulation](#error-simulation) · [Control plane](#control-plane) · [Webhooks](#webhooks) ·
[Web UI](#web-ui) · [Development](#development) · [Contributing](#contributing) ·
[Acknowledgments](#acknowledgments) · [License](#license)

## Quickstart

```sh
docker run --rm -p 8080:8080 \
  -e WHALOC_WEBHOOK_URL=http://host.docker.internal:3001/meta-webhooks \
  -e WHALOC_APP_SECRET=dev-app-secret \
  -e WHALOC_WEBHOOK_VERIFY_TOKEN=dev-verify-token \
  -e WHALOC_VERIFY_ON_START=true \
  ghcr.io/dgadelha/whaloc:latest
```

The image is published to both registries — `ghcr.io/dgadelha/whaloc` and
[`dgadelha/whaloc` on Docker Hub](https://hub.docker.com/r/dgadelha/whaloc) — use whichever
your environment pulls faster.

Open <http://localhost:8080> for the UI and point the app under test at
`GRAPH_API_BASE_URL=http://localhost:8080/v25.0` (from another container on the same compose
network: `http://whaloc:8080/v25.0`). Seeded IDs are **derived deterministically** — the same on
every machine, every run, and treated as a stable contract — so the commands below work verbatim
against a fresh whaloc; they are also logged at boot (`seed applied`) and shown, with copy
buttons, in the UI's **Settings** view.

Sending a message needs nothing but a bearer token — any non-empty one is accepted:

```sh
curl -X POST http://localhost:8080/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"olá"}}'
```

The seed also ships one **approved, zero-parameter template**, `hello_whaloc`, so a
`type: "template"` send works on a cold whaloc too — nothing to create, nothing to approve:

```sh
curl -X POST http://localhost:8080/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"template","template":{"name":"hello_whaloc","language":{"code":"en"}}}'
```

`WHALOC_SEED` can carry as many templates as you like (`templates: [{name, language?, category?,
parameterFormat?, components?}]` per WABA, see [SPEC §7](docs/SPEC.md)); every one of them is
`APPROVED` from the first instant, because a seed describes templates that exist already.

The repository ships a **standalone demo** — whaloc plus a webhook receiver that verifies
`X-Hub-Signature-256` and logs every delivery:

```sh
docker compose up            # UI on :8080
docker compose logs -f webhook-echo
```

See [docker-compose.yml](docker-compose.yml); it is also the shortest example of the environment
a real integration needs, and [docs/integrating.md](docs/integrating.md) is the long form —
pointing your own app at whaloc, which values have to match which, and a smoke test. The image is
published by [`.github/workflows/docker.yml`](.github/workflows/docker.yml) (`latest` and
`sha-<short>` from `main`, the semver ladder from a `v*` tag, `linux/amd64` + `linux/arm64`) with
full SLSA provenance and an SBOM attached to the image index, plus GitHub-signed build
attestations — verifiable with
`gh attestation verify oci://ghcr.io/dgadelha/whaloc:latest --owner dgadelha`.

### State and the `/data` volume

The default database is `:memory:` — every restart starts from the seed. Mount a volume and set
`WHALOC_DB_PATH` to keep WABAs, conversations, templates and media across restarts:

```sh
docker run -d --name whaloc -p 8080:8080 \
  -v whaloc-data:/data -e WHALOC_DB_PATH=/data/whaloc.db \
  ghcr.io/dgadelha/whaloc:latest
```

`/data` is a declared volume and media bytes live in `/data/media` either way. The container runs
as the unprivileged `node` user (uid 1000), which a fresh named volume inherits; a **bind** mount
keeps the host's ownership, so `chown 1000:1000` the host directory (or accept read-only media).

### Media storage: a directory, or S3

By default the bytes behind every uploaded image, video and document go to `WHALOC_MEDIA_DIR`.
Set `WHALOC_MEDIA_BACKEND=s3` and they go to an **S3-compatible bucket** instead — MinIO, R2,
Ceph or AWS itself — which is what you want when whaloc runs more than once against the same
state, or when a container that may be recreated must not take the media with it.

```yaml
services:
  minio:
    image: minio/minio
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: whaloc
      MINIO_ROOT_PASSWORD: whaloc-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: ["minio-data:/data"]

  # whaloc never creates the bucket; this makes it once and exits.
  minio-bucket:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >-
      sh -c "mc alias set local http://minio:9000 whaloc whaloc-secret &&
             mc mb --ignore-existing local/whaloc-media"

  whaloc:
    image: ghcr.io/dgadelha/whaloc:latest
    depends_on: [minio-bucket]
    ports: ["8080:8080"]
    environment:
      WHALOC_MEDIA_BACKEND: s3
      WHALOC_S3_ENDPOINT: http://minio:9000
      WHALOC_S3_BUCKET: whaloc-media
      WHALOC_S3_REGION: us-east-1
      WHALOC_S3_ACCESS_KEY_ID: whaloc
      WHALOC_S3_SECRET_ACCESS_KEY: whaloc-secret

volumes:
  minio-data:
```

Notes worth knowing:

- **The bucket has to exist.** whaloc reads and writes objects; it does not manage buckets.
- Leave both key variables unset and the AWS SDK's **default credential chain** applies (a
  profile, an instance role, `AWS_*` variables) — setting only one of them is an error, not a
  request for the chain.
- `WHALOC_S3_FORCE_PATH_STYLE` defaults to `true` as soon as an endpoint is configured, because
  that is how MinIO and friends address a bucket; AWS itself gets virtual-host style.
- Object keys are the same flat, opaque names the local backend uses as filenames, so the two
  backends are interchangeable — including through an **export/import** (see below).
- Everything else is unchanged: the two-hop download, `Range` requests, the ~100 MiB cap and
  `WHALOC_MEDIA_TTL_SECONDS` all behave identically. Only where the bytes rest differs.

### State snapshots: export and import

A whaloc's whole world fits in one JSON file — every WABA, phone number (pending verification
codes and business profiles included), contact, template, conversation, message, media row **and
the media bytes themselves**, base64-inlined. Send the file to a colleague and the whaloc it
lands in is the one it left, which is what makes a reproduction shareable.

```sh
curl -sOJ http://localhost:8080/api/export                        # whaloc-snapshot-<ts>.json
curl -s 'http://localhost:8080/api/export?include=deliveries' -o snapshot.json
curl -sX POST http://localhost:8080/api/import \
  -F file=@snapshot.json                                          # or: -H 'Content-Type: application/json' --data-binary @snapshot.json
```

Both are in **Settings → Danger zone** too: an Export button (the browser saves the file) and an
Import picker behind a confirmation.

- **An import replaces everything**, and the seed is **not** re-applied afterwards: the snapshot
  _is_ the state, IDs and all. `POST /api/reset` is still the way back to `WHALOC_SEED`.
- It is **validated before anything is deleted**, and refuses a snapshot written by a newer
  whaloc (there is a schema version in the envelope) rather than half-loading it. The database
  swap itself is one transaction.
- The bytes go back in **through whichever storage backend is configured now**, so a snapshot
  taken from a local-backed whaloc restores into an S3-backed one and the other way round.
- The **delivery log is left out** unless `?include=deliveries` asks for it: it is traffic rather
  than state, and by far the biggest table.
- Base64 costs about a third in size over the raw bytes. That is the deliberate trade — media in
  a whaloc is a handful of test images, and a snapshot that only half-restores is worse than a
  large one. Skip a huge media library rather than expecting a 500 MB file to be pleasant.
- Rows come out in a deterministic order, so two exports of the same state differ only in their
  `exportedAt`.

## Configuration

Environment variables only, parsed once at boot: an invalid environment prints **every** problem
and exits. Blank values count as unset (an empty `WHALOC_WEBHOOK_URL=` in a compose file disables
webhooks rather than failing), and values are trimmed.

| Var                            | Default                                              | Purpose                                                                                             |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WHALOC_PORT`                  | `8080`                                               | Listen port (the `HEALTHCHECK` follows it)                                                          |
| `WHALOC_HOST`                  | `0.0.0.0`                                            | Bind address                                                                                        |
| `WHALOC_PUBLIC_URL`            | `http://localhost:8080`                              | Base for generated media URLs and `paging.next` — must be reachable **by whoever downloads media**  |
| `WHALOC_WEBHOOK_URL`           | _unset → webhooks disabled (warns)_                  | Target for webhook POSTs, e.g. `http://meta-webhook-receiver:3001/meta-webhooks`                    |
| `WHALOC_APP_SECRET`            | _unset → deliveries unsigned (warns)_                | HMAC key for `X-Hub-Signature-256`                                                                  |
| `WHALOC_WEBHOOK_VERIFY_TOKEN`  | _unset_                                              | Token echoed in the `hub.challenge` handshake                                                       |
| `WHALOC_VERIFY_ON_START`       | `false`                                              | Run that handshake at boot                                                                          |
| `WHALOC_APP_ID`                | _derived from the name, stable across restarts_      | The app ID `subscribed_apps` reports — set it to the app's `META_APP_ID` when that matters          |
| `WHALOC_SEED`                  | 1 WABA + 1 phone number + 2 contacts + 1 template    | JSON array of WABAs (see [SPEC §7](docs/SPEC.md)); omitted IDs are derived deterministically        |
| `WHALOC_STATUS_DELAYS`         | `sent:0,delivered:800`                               | Status ladder timing in ms; add `read:<ms>` to automate read receipts                               |
| `WHALOC_TEMPLATE_AUTO_APPROVE` | `2000`                                               | ms until a new template is approved; `off` leaves it `PENDING` for the UI                           |
| `WHALOC_TOKENS`                | _unset → any non-empty bearer token is accepted_     | Comma-separated bearer-token registry; set it and only these tokens pass (see **Error simulation**) |
| `WHALOC_MEDIA_TTL_SECONDS`     | _unset → media never expires_                        | Seconds after which an uploaded media object is gone from the Graph surface                         |
| `WHALOC_DB_PATH`               | `:memory:`                                           | SQLite file for persistence, e.g. `/data/whaloc.db`                                                 |
| `WHALOC_MEDIA_BACKEND`         | `local`                                              | `local` (a directory) or `s3` (an S3-compatible bucket, see **Media storage**)                      |
| `WHALOC_MEDIA_DIR`             | `/data/media` in the image, `./data/media` otherwise | Media storage root, for the `local` backend                                                         |
| `WHALOC_S3_BUCKET`             | _required when the backend is `s3`_                  | Bucket the media objects live in — whaloc never creates it                                          |
| `WHALOC_S3_REGION`             | _required when the backend is `s3`_                  | Region; anything satisfies MinIO, but the SDK insists on having one                                 |
| `WHALOC_S3_ENDPOINT`           | _unset → AWS S3_                                     | Endpoint of an S3-compatible server (MinIO, R2, Ceph…)                                              |
| `WHALOC_S3_ACCESS_KEY_ID`      | _unset → the SDK's default credential chain_         | Access key; all-or-nothing with the secret below                                                    |
| `WHALOC_S3_SECRET_ACCESS_KEY`  | _unset → the SDK's default credential chain_         | Secret key                                                                                          |
| `WHALOC_S3_FORCE_PATH_STYLE`   | `true` whenever an endpoint is set                   | Path-style addressing (`<endpoint>/<bucket>/<key>`), which is what MinIO serves                     |
| `WHALOC_WEB_DIR`               | `packages/web/dist`, beside the server               | Built UI served at `/`; an absent directory just leaves `/` unrouted                                |
| `WHALOC_LOG_LEVEL`             | `info`                                               | pino level (`fatal`…`trace`, `silent`)                                                              |

## Graph API coverage

Every route is mounted under **any** `/v<major>.<minor>` prefix, takes any non-empty
`Authorization: Bearer` token, and answers failures with Meta's error envelope (including
`fbtrace_id`; an unknown object ID is a `400` with `code: 100, error_subcode: 33`, which is what
consumers key media-expiry and deregistration detection on).

| Route                                                    | Notes                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /{id}`                                              | Dispatches by store: phone number (lifecycle fields included), WABA, template, or media descriptor (with `?phone_number_id=`); honors `fields`                                                                                |
| `POST /{phone-number-id}/messages`                       | `text`, `template`, `image`, `video`, `audio`, `document`, `sticker`, `interactive`, `location`, `reaction`, `contacts`; addressed by `to` (MSISDN) or `recipient` (BSUID); optional `biz_opaque_callback_data` (≤ 512 chars) |
| `POST /{phone-number-id}/messages` (`status:"read"`)     | The read receipt Meta overloads the send path with → `{"success":true}`; marks that **inbound** message read, and `typing_indicator` raises a typing indicator with it                                                        |
| `POST /{phone-number-id}/media`                          | Streamed multipart upload → `{"id":"<digits>"}`, ~100 MiB cap                                                                                                                                                                 |
| `DELETE /{media-id}`                                     | Deletes the object and its bytes → `{"success":true}`; afterwards the ID is `400` / `100` / `33` and the byte URL 404s, so "this media is gone" is one call away                                                              |
| `GET /whaloc-media/{token}`                              | The byte endpoint the descriptor points at: `Range` → `206` + `Content-Range`, never a redirect                                                                                                                               |
| `POST /{app-id}/uploads`                                 | Opens a resumable upload → `{"id":"upload:<opaque>"}`; `file_length`/`file_type`/`file_name` from the query string or the body                                                                                                |
| `POST /upload:{opaque}`                                  | Sends bytes at `file_offset` → `{"h":"<handle>"}` once the session is full, otherwise the offset it is now at                                                                                                                 |
| `GET /upload:{opaque}`                                   | `{"id":…,"file_offset":N}` — a truthful offset, so an interrupted upload knows where to resume                                                                                                                                |
| `GET /whaloc-upload/{token}`                             | The bytes behind a completed handle, with the same `Range` rules as the media one                                                                                                                                             |
| `POST /{waba-id}/message_templates`                      | Creates `PENDING`, then the approval flow (§4)                                                                                                                                                                                |
| `GET /{waba-id}/message_templates`                       | `fields`, `limit`, `after`, `before`; filters `name`, `name_or_content`, `status`, `category`, `language`; `paging.next`/`paging.previous` only when that page exists                                                         |
| `DELETE /{waba-id}/message_templates?name=&hsm_id=`      | Deletes every language; unknown → `404` envelope                                                                                                                                                                              |
| `POST /{template-id}`                                    | Edit; back to `PENDING`, re-runs approval                                                                                                                                                                                     |
| `GET /{waba-id}/phone_numbers`                           | Listing with `paging`; honors `fields`                                                                                                                                                                                        |
| `POST /{waba-id}/phone_numbers`                          | Adds an **unverified** number → `{"id":"<digits>"}`; malformed → `400`, digits already in use (any WABA) → `409`                                                                                                              |
| `POST /{phone-number-id}/request_code`                   | "Texts" a 6-digit code — derived from the ID, so it is stable and never expires; readable in the UI, never in a Graph response                                                                                                |
| `POST /{phone-number-id}/verify_code`                    | Confirms it (`VERIFIED`, and `UNVERIFIED` → `PENDING`); a wrong or absent code is the `(#100)` envelope                                                                                                                       |
| `POST /{phone-number-id}/register`                       | `CONNECTED` — the number can send from here on; an unverified one is `133006`                                                                                                                                                 |
| `POST /{phone-number-id}/deregister`                     | `DISCONNECTED`; sends answer `133010` until it is registered again                                                                                                                                                            |
| `GET\|POST /{phone-number-id}/whatsapp_business_profile` | The profile a number publishes: `about`, `address`, `description`, `email`, `websites` (max 2), `vertical`, `profile_picture_url`. A `POST` merges, an empty value clears                                                     |
| `POST\|GET\|DELETE /{waba-id}/subscribed_apps`           | Subscribe whaloc's own app to a WABA's webhooks, read it back, unsubscribe. One implicit app; delivery does not depend on it                                                                                                  |

Template sends are validated against the stored components — a parameter-count mismatch is the
real `132000`, a template that is not `APPROVED` (or does not exist) is `132001`.

**`biz_opaque_callback_data`** is stored on the send and comes back on **every** status webhook for
that message — `sent`, `delivered`, `read`, `failed`, whether the ladder or a button raised it — as
`statuses[].biz_opaque_callback_data`. It is never echoed on the send response, because Meta does
not echo it there either.

### Resumable uploads and handles

Meta's Upload API is where a real `header_handle` comes from, and whaloc runs the same three calls:

```sh
BASE=http://localhost:8080/v25.0
AUTH="Authorization: Bearer dev-token"
APP=$(curl -s http://localhost:8080/api/state | jq -r .app.id)

SESSION=$(curl -s -X POST -H "$AUTH" \
  "$BASE/$APP/uploads?file_length=$(wc -c < logo.png)&file_type=image/png&file_name=logo.png" | jq -r .id)

HANDLE=$(curl -s -X POST -H "$AUTH" -H "file_offset: 0" \
  --data-binary @logo.png "$BASE/$SESSION" | jq -r .h)

curl -s -H "$AUTH" "$BASE/$SESSION"      # {"id":"upload:…","file_offset":12345}
```

The handle then goes wherever Meta takes one:

- **`profile_picture_handle`** on the business profile. A whaloc **media ID** still works there
  too — one call instead of three, and it is what the UI and the older docs use.
- **`components[].example.header_handle[]`** on a template. whaloc resolves it at create and edit
  time (an unknown handle is `(#100)`, not a header pointing at nothing) and the Templates view
  renders the header with the picture that was actually uploaded.

The `file_offset` an interrupted upload reports is truthful, and a chunk that does not land on it is
refused rather than silently overwritten. `:appId` takes whaloc's own app ID or any digit-only one —
an app under test has its own `META_APP_ID`, whaloc has one app either way, and refusing would be an
obstacle with nothing behind it.

A read receipt (`{"messaging_product":"whatsapp","status":"read","message_id":"wamid…"}`) moves
the user's message to `read` and emits **no** webhook — Meta reports statuses for outbound
messages only. Adding `"typing_indicator":{"type":"text"}` marks it read _and_ puts a typing
bubble in the UI, which comes down after Meta's 25-second window or as soon as the next outbound
message goes out. Both live in memory: a restart drops them, like every other timer.

**Only a `CONNECTED` phone number can send** (error `133010` otherwise), which is how a
deregistered number is reproduced. Seeded numbers — and numbers created through the control plane
or the UI — are `CONNECTED` and verified from the start, so nothing that worked before the
registration ladder existed has to change; only a number created through
`POST /{waba-id}/phone_numbers` walks it. The ladder is documented in
[SPEC §4](docs/SPEC.md).

Flows are out of scope.

## Identities and number changes

A contact is a phone number, and may **also** be a business-scoped user ID (BSUID) — Meta's
`BR.ENT.4KgQ2wJ8` / `US.4KgQ2wJ8` form. Give one to a contact in Settings (or through
`POST/PATCH /api/contacts`, `userId`) and whaloc reports it everywhere Meta does:

| Where            | Field                                                          |
| ---------------- | -------------------------------------------------------------- |
| Inbound webhooks | `contacts[].user_id` and `messages[].from_user_id`             |
| Status webhooks  | `statuses[].recipient_user_id`                                 |
| Sends            | `POST /{phone-number-id}/messages` with `recipient: "<BSUID>"` |

Each of them rides **alongside** `wa_id` / `from` / `recipient_id`, and each is absent for a
contact without a BSUID. A BSUID is unique across contacts. The default seed ships one on each
contact — `BR.ENT.AnaSouza01` and `BR.BrunoLima01`, one of each shape the pattern allows — and a
`WHALOC_SEED` contact can set its own via `userId`.

A send addressed by `recipient` is **resolved** to the contact that owns that BSUID, and the
answer echoes what was asked with the number behind it:

```json
{ "contacts": [{ "input": "BR.ENT.4KgQ2wJ8", "wa_id": "5571988887777" }] }
```

An unknown BSUID is the missing-object envelope (`400` / `100` / `33`) rather than an invented
contact: the ID says nothing about a phone number, so the conversation such a contact got would
never have received anything. A `recipient` that is not BSUID-shaped is still treated exactly
like a `to`.

**When a person changes number**, use "Number…" in Settings (or "Changed number…" in a chat
header, or `POST /api/contacts/{waId}/change-number`). The contact's `wa_id` changes in place —
name, BSUID and full history follow it — and whaloc sends Meta's system notice to every business
number that has a conversation with the contact:

```json
{
	"from": "5571988887777",
	"type": "system",
	"system": {
		"body": "User Carla Dias changed from 5571988887777 to 5571977776666",
		"wa_id": "5571977776666",
		"new_wa_id": "5571977776666",
		"type": "user_changed_number"
	}
}
```

Like Meta's, the notice carries **no `contacts[]` array** — the new `wa_id` is inside `system`,
which is where a consumer has to read it. The new number appears under both spellings because
Meta's webhook version decides which one it
sends, and consumers read `wa_id ?? new_wa_id`. Wamids do not change, so replies, reactions and
read receipts naming older messages keep working — but the **derived conversation ID** does
(`<phoneNumberId>:<waId>`), so anything holding one has to follow the `previousWaId` the
`contact.changed` event carries. The UI does; the open chat moves with the person.

## Error simulation

Everything whaloc does wrong, it does **on purpose**. All three switches below are off by
default, none of them is probabilistic, and each is visible in the UI — a failure nobody asked
for is a support question, and one somebody asked for and then forgot about is worse, so an
armed rule puts a pulsing badge in the top bar.

### Strict tokens

Set `WHALOC_TOKENS` to a comma-separated list and the Graph surface accepts **only** those
bearer tokens; anything else is `401` with the same `code: 190` envelope a missing token gets
(Meta does not tell a caller which mistake it made, and neither does whaloc). Leave it unset —
the default — and any non-empty token works, exactly as before.

Each registered token can then be **expired** from Settings, or from the control plane:

```sh
curl -s http://localhost:8080/api/tokens                      # masked: {"strict":true,"data":[…]}
curl -sX POST http://localhost:8080/api/tokens/<id>/expire    # → 401 / 190 / subcode 463
curl -sX POST http://localhost:8080/api/tokens/<id>/restore
```

The expired-session envelope is Meta's `error_subcode: 463`, which is what a consumer keys
"refresh my token" on. Expiry survives a restart with `WHALOC_DB_PATH`; `POST /api/reset` brings
every token back. The token values never leave the process — the API serves them masked, and
what is stored is a truncated SHA-256, so a `whaloc.db` on a volume holds no credential.

### Injection rules

A rule says **where** to fail, **when**, and **with which envelope**. Rules live in the database,
are managed from Settings or `POST /api/injection-rules`, and are cleared by `POST /api/reset`.

| Part    | Values                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target  | `messages.send`, `media.upload`, `media.resolve`, `media.download`, `templates.create`, `templates.list`, `graph.all`                                 |
| Trigger | `{"kind":"always"}`, `{"kind":"next","count":N}` (with a live countdown), `{"kind":"every","nth":N}` (fires on the Nth, 2Nth… request that rule sees) |
| Preset  | `rate_limit_429` · `throughput_131056` · `spam_rate_4` · `server_error_500` · `custom`                                                                |

```sh
curl -sX POST http://localhost:8080/api/injection-rules -H 'Content-Type: application/json' \
  -d '{"target":"messages.send","trigger":{"kind":"next","count":3},
       "preset":"rate_limit_429","retryAfterSeconds":42,"regainAccessMinutes":7}'
```

The next three sends then answer `429`:

```json
{
	"error": {
		"message": "(#130429) Rate limit hit",
		"type": "OAuthException",
		"code": 130429,
		"error_data": { "messaging_product": "whatsapp", "details": "Cloud API message throughput has been reached." },
		"fbtrace_id": "A…"
	}
}
```

with the two headers a consumer's backoff reads — `Retry-After: 42` in **seconds**, and

```
X-Business-Use-Case-Usage: {"<waba-id>":[{"type":"whatsapp","call_count":100,"total_cputime":100,
  "total_time":100,"estimated_time_to_regain_access":7}]}
```

whose `estimated_time_to_regain_access` is in **minutes**. The fourth send succeeds. The other
presets are `throughput_131056` (`400`, the business/consumer pair limit, no headers),
`spam_rate_4` (`429`, code `4`, the same two headers), `server_error_500` (`500`, code `1`) and
`custom`, where you write the envelope yourself (`{"custom":{"httpStatus":400,"code":131047,
"message":"(#131047) Re-engagement message"}}`).

Rules are evaluated in one middleware **before every handler** and **after** the bearer gate, so
an armed `graph.all` rule can never disguise a `401`. Each matching rule counts the request; the
first one whose trigger arms it answers, and a rule shadowed by an earlier one keeps its
countdown untouched. Every injection is logged at `info` with the rule that caused it.

### Media expiry

`WHALOC_MEDIA_TTL_SECONDS=5` makes an uploaded object disappear from the Graph surface five
seconds later — the boundary is inclusive. The descriptor hop answers the missing-object envelope
(`400`, `code: 100`, `error_subcode: 33`), which is exactly what consumers key expired-media
detection on, and the byte endpoint answers the plain `404` it gives an unknown token, because
that route carries no Meta envelope. The row and the bytes are still there: whaloc's own
`GET /api/media/{id}` keeps describing them, so the UI can still show what a message pointed at.

## Control plane

`/api` is whaloc's own API — the web UI and test scripts drive the "user side" through it. It has
**no authentication** (the Graph surface next door accepts any bearer token), so do not expose the
port to a network you do not trust. Request and response schemas live in
`packages/shared/src/control-plane/`, imported by both the server and the UI.

| Endpoint                                                               | What it does                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /api/health`                                       | Liveness (the root alias is what the Docker `HEALTHCHECK` hits)                                                                                                                                                                                    |
| `GET /api/state`                                                       | WABAs, phone numbers (with their lifecycle and any pending verification code), configured behavior, webhook target status                                                                                                                          |
| `POST /api/reset`                                                      | Wipe every table **and** the stored media, then re-apply the seed                                                                                                                                                                                  |
| `GET /api/export?include=deliveries`                                   | The whole state as one downloadable JSON file, media bytes included (see **State snapshots**)                                                                                                                                                      |
| `POST /api/import`                                                     | Replace all state with such a file — JSON body or a `multipart/form-data` upload                                                                                                                                                                   |
| `GET/POST /api/contacts`, `PATCH /api/contacts/{waId}`                 | The WhatsApp users on the other side, with their optional business-scoped user ID                                                                                                                                                                  |
| `POST /api/contacts/{waId}/change-number`                              | The person moved: the contact and its history follow, and `user_changed_number` goes out                                                                                                                                                           |
| `GET /api/conversations?phoneNumberId=`                                | One row per contact, with the last message                                                                                                                                                                                                         |
| `GET /api/conversations/{id}/messages`                                 | Paginated history, newest last                                                                                                                                                                                                                     |
| `POST /api/inbound`                                                    | Simulate a user message: text, media, `interactive` replies, `button`, location, contacts, reaction, `unsupported`; plus the context riders (`referral`, `forwarded`, `frequentlyForwarded`, `referredProduct`)                                    |
| `POST /api/inbound-media`                                              | Multipart upload used by an inbound media message                                                                                                                                                                                                  |
| `GET /api/media/{id}`                                                  | The descriptor behind a media ID, so the UI can preview it                                                                                                                                                                                         |
| `GET /api/uploads?handle=`                                             | The same for a resumable-upload handle, which is what a template's `example.header_handle` carries                                                                                                                                                 |
| `POST /api/messages/{id}/status`                                       | Manual `delivered` / `read` / `failed` (with an error preset)                                                                                                                                                                                      |
| `GET /api/message-error-presets`                                       | The failure codes that action accepts, with Meta's wording                                                                                                                                                                                         |
| `GET /api/typing?phoneNumberId=`                                       | The typing indicators the app under test currently has up (read-only — only it can raise one)                                                                                                                                                      |
| `GET /api/templates?status=&category=&language=&name=&search=`         | Templates with their status and quality score, narrowed by the same filters the Graph listing takes                                                                                                                                                |
| `POST /api/templates/{id}/approve\|reject\|pause\|disable\|quality`    | The moderation whaloc performs on Meta's behalf; each transition emits its webhook                                                                                                                                                                 |
| `POST /api/phone-numbers/{id}/quality`                                 | Set quality/throughput, optionally emitting `phone_number_quality_update`                                                                                                                                                                          |
| `POST /api/phone-numbers/{id}/business-profile`                        | The business profile, as Settings edits it (camelCase; a blank field clears it)                                                                                                                                                                    |
| `GET/POST /api/injection-rules`, `DELETE /api/injection-rules/{id}`    | Deterministic error injection: target, trigger, preset (see **Error simulation**)                                                                                                                                                                  |
| `GET /api/tokens`, `POST /api/tokens/{id}/expire\|restore`             | The `WHALOC_TOKENS` registry, masked; expire one to get `401` / `190` / subcode `463`                                                                                                                                                              |
| `GET/POST /api/wabas`, `PATCH\|DELETE /api/wabas/{id}`                 | WABAs at runtime; `POST` takes an optional `id` so the account can match a production one; a delete cascades to phone numbers, messages, media and templates                                                                                       |
| `GET/POST /api/phone-numbers`, `PATCH\|DELETE /api/phone-numbers/{id}` | Numbers under a WABA — created here they are `CONNECTED` and can send immediately; `POST` takes an optional `id` too                                                                                                                               |
| `GET /api/webhook-deliveries?limit=&before=`                           | The delivery log, newest first                                                                                                                                                                                                                     |
| `POST /api/webhook-deliveries/{id}/redeliver`                          | Replay a stored body, re-signed now                                                                                                                                                                                                                |
| `POST /api/webhook/handshake`, `POST /api/webhook/raw`                 | Run the `hub.challenge` handshake; send arbitrary (still signed) JSON                                                                                                                                                                              |
| `POST /api/webhook/account-update`                                     | Emit `account_update` for a WABA: `VERIFIED_ACCOUNT`, `DISABLED_UPDATE`, `ACCOUNT_RESTRICTION` (with `restriction_info`), `ACCOUNT_DELETED`, `ACCOUNT_VIOLATION` — an event only, no state change                                                  |
| `POST /api/webhook/business-capability-update`                         | Emit `business_capability_update` with `max_daily_conversation_per_phone` and `max_phone_numbers_per_business` — likewise an event only                                                                                                            |
| `GET /api/ws`                                                          | WebSocket: `message.created`, `message.status_changed`, `typing.changed`, `template.changed`, `webhook.delivery`, `contact.changed`, `waba.changed`, `phone_number.changed`, `injection.changed`, `token.changed`, `state.reset`, `state.imported` |

## Webhooks

whaloc delivers webhooks to `WHALOC_WEBHOOK_URL` with `Content-Type: application/json`,
`User-Agent: facebookexternalua` and — when `WHALOC_APP_SECRET` is set — `X-Hub-Signature-256`.
The body is serialized once with Meta's `\uXXXX` escaping and **those exact bytes are what is
signed and sent**, so a receiver that verifies the signature the way Meta documents it accepts
whaloc's payloads unchanged. `docs/fixtures/webhooks/` holds the captured Meta samples the
payload builders are tested against.

The events it can send: inbound messages of every type (including `unsupported`, and with the
click-to-WhatsApp `referral` and the forwarded/`referred_product` context riders), statuses,
`user_changed_number`, `message_template_status_update`, `message_template_quality_update`,
`phone_number_quality_update`, `account_update`, `business_capability_update`, and anything at all
through `POST /api/webhook/raw`.

The last two are **account-level and emission-only**: sending `ACCOUNT_RESTRICTION` does not put
whaloc into a restricted state, and the capability numbers are not a quota. What they exist for is
your webhook handler — inventing state Meta would then contradict (a whaloc that refused to send
"because it is restricted") would cost more than it buys. Trigger them per WABA in **Settings →
Accounts**, or from the control plane.

Four behaviors are worth knowing about:

- **Every attempt is logged**, browsable through `GET /api/webhook-deliveries`. Retries are
  separate rows: 3 attempts at 0 s / 2 s / 10 s, on a 5xx or a network error only.
- **With `WHALOC_WEBHOOK_URL` unset, deliveries are skipped but still logged** — the row carries
  the payload and headers that would have gone out (`skipped: true`, empty `url`), so the UI is
  useful before an integration exists. `POST /api/webhook-deliveries/:id/redeliver` replays a
  stored body, re-signed with the secret configured at that moment.
- **Timers live in memory.** A pending status ladder or template approval is dropped on restart
  (SPEC §4); nothing is replayed at boot.
- **`POST /api/reset` is a full wipe**: every table is emptied _and the stored media files are
  deleted_, then `WHALOC_SEED` is applied again. Seeded IDs are derived deterministically, so
  they survive the reset and a configured `GRAPH_API_BASE_URL` keeps working. `POST /api/import`
  is the same wipe **without** the re-seed — see **State snapshots**.

## Web UI

The React bundle is served at `/` by the same port as everything else, with a SPA fallback that
never shadows `/api`, `/v*.*`, `/whaloc-media` or `/health`. Four views, all live over `/api/ws`
and none of them polling.

One **top bar** frames them: the brand, the scope, the four tabs and the live indicators, with
the content full width underneath. The scope is a breadcrumb — **WABA ▾ / number ▾** — and it
goes exactly as deep as the view needs it: Chats is scoped to a number, Templates to an account,
Webhooks and Settings to nothing at all. Each segment is a menu of what exists, ending in the
action that creates the next one ("Create WABA…", "Add number…" — the same dialogs Settings
uses), so a whaloc with nothing in it can be filled in from the bar.

The scope lives in the **URL**, so a deep link and a reload land where you left off:

| View      | Route                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| Chats     | `/w/{waba-id}/p/{phone-number-id}/chats/{contact-wa-id}` (the last two segments optional) |
| Templates | `/w/{waba-id}/templates`                                                                  |
| Webhooks  | `/webhooks`                                                                               |
| Settings  | `/settings`                                                                               |

`/` and the bare `/chats` and `/templates` redirect into the scope this browser used last (or the
first WABA that has a number). A path naming a WABA or a number that is gone — deleted here, in
another tab, or by a reset — redirects to the closest scope that still exists and says so, and a
deletion arriving over the WebSocket moves the URL the same way.

- **Chats** — the conversations of a phone number, rendered like a messenger with day separators
  and status ticks. The header carries the contact's BSUID when it has one, and the
  "Changed number…" action that emits Meta's `user_changed_number` (the open conversation follows
  the person). The composer acts as the **WhatsApp user**: text, media (uploaded, then
  rendered inline), location, reactions, interactive button/list replies, template button
  payloads, contact cards, and an **unsupported** message (Meta's `131051` placeholder for a poll
  or whatever WhatsApp ships next). A collapsed **Extras** panel under the type tabs adds the
  context riders to any of them — forwarded, frequently forwarded, a click-to-WhatsApp `referral`
  and a `referred_product` — and survives a type switch, because it describes how the message
  arrived rather than what is in it. Each outbound message has the manual half of the status ladder on
  it — mark delivered, mark read, or fail with one of the error presets. The other direction
  shows what the app under test did: a faint double check on the user's message once it called
  the read receipt, and a typing bubble (also `typing…` in the conversation list) while it has a
  typing indicator up.
- **Templates** — the review a Meta moderator would perform: approve, reject with
  `rejection_info`, pause, disable, push a quality update; with the components JSON beside a
  rendered preview that marks every `{{placeholder}}` and renders a media header from the
  `example.header_handle` it was created with. The filter bar (search, status, category)
  narrows the list **server-side**, through the same filters the Graph listing takes.
- **Webhooks** — the delivery log, expandable into the exact signed bytes, with redeliver, the
  `hub.challenge` handshake, and a raw payload sender.
- **Settings** — the WABA and phone-number IDs (with copy buttons, since a `GRAPH_API_BASE_URL`
  call needs them), grouped by account: add, rename and delete WABAs, add, edit and delete phone
  numbers (destructive actions are confirmed and say what goes with them), status and
  verification badges, and — while a Graph `request_code` is outstanding — the verification code
  whaloc would have texted, ready to copy into `verify_code`. Each number also carries the
  **business profile** the Graph endpoint publishes, editable in place, and each WABA says
  whether an app has subscribed to its webhooks and carries the **account webhooks** card
  (`account_update` with its five events and `restriction_info`, `business_capability_update` with
  its two limits) — both emissions only. Plus quality/throughput editing, contacts, the
  behavior the environment configured, **error injection** (arm a rule, watch its countdown, delete
  it), the **access tokens** section when `WHALOC_TOKENS` is set, and a danger zone holding the
  **state snapshot** controls (export the whole world to a file, import one back) next to the
  reset. Contacts are edited in place — profile name and business-scoped user ID — and each one
  can change number.

While any injection rule can still fire, the top bar carries a pulsing "N rules injecting errors"
badge that links straight to the rule doing it — a forgotten rule should cost seconds, not an
afternoon.

## Development

Requires **Node 24**.

```sh
npm install       # or `npm ci`, to install exactly what package-lock.json pins
npm run dev       # server on :8080 (native TypeScript, watch mode) + Vite on :5173
```

With `npm run dev` the UI is served by Vite on <http://localhost:5173>, which proxies `/api`,
`/api/ws`, `/whaloc-media` and `/v*.*` to the server; the server's own `/` stays unrouted until
`npm run build` produces a bundle for it.

| Script              | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Server watcher and Vite dev server, in parallel        |
| `npm run build`     | `tsc` for shared/server, `vite build` for web          |
| `npm test`          | vitest, per package (see the S3 note below)            |
| `npm run lint`      | ESLint (typescript-eslint strict + unicorn + prettier) |
| `npm run typecheck` | `tsc --noEmit`, per package                            |
| `npm run format`    | Prettier over the repo                                 |
| `npm start`         | Runs the built server (`npm run build` first)          |

Anything can also be run for one package with `--workspace`, e.g.
`npm run test:watch --workspace @whaloc/web`. Order matters in exactly one place: `shared` has to
be built before `server` and `web`, because a build resolves it to `dist/` — the root `build`
script therefore names the three in order rather than leaving it to npm, which runs workspace
scripts in manifest order and not topologically.

The S3 media backend is tested against a **real** S3-compatible server, so those specs are
opt-in: with `WHALOC_TEST_S3_ENDPOINT` unset they skip themselves (with a line saying so) and
`npm test` is green on a machine without Docker. CI runs them against a `minio` service
container; locally it takes one command:

```sh
docker run -d --name whaloc-minio -p 9000:9000 \
  -e MINIO_ROOT_USER=whaloc -e MINIO_ROOT_PASSWORD=whaloc-secret minio/minio:edge-cicd
WHALOC_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm test --workspace @whaloc/server
```

The bucket (`whaloc-test`) is created by the spec itself. `minio/minio:edge-cicd` is the tag
MinIO publishes for CI — its `CMD` already starts the server, which is what a GitHub Actions
service container needs, since those cannot pass a command.

| Package           | What it is                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| `packages/shared` | zod schemas and types shared by the server and the web UI               |
| `packages/server` | Hono app: Graph API mock, control-plane API + WebSocket, static UI host |
| `packages/web`    | React 19 + Vite UI, a pure client of the control-plane API              |

The server runs its TypeScript sources directly (`node --experimental-transform-types`), so the
code must stay erasable: no enums, namespaces or parameter properties, and relative imports keep
their `.ts` extension. Workspace packages are consumed from source in dev and test through the
`development` export condition, and from `dist/` in a build. The image needs no such flag — it
runs the `tsc` output — only `--disable-warning=ExperimentalWarning`, because `node:sqlite` is
still flagged in Node 24.

```sh
docker build -t whaloc:local .          # non-root, HEALTHCHECK on /health
docker compose up                       # the demo above, against the published image
```

The S3 client is the one heavy dependency in the image (about 26 MB of the total): it ships
either way, because which media backend runs is an environment variable and not a build flag.

## Contributing

Issues and pull requests are welcome. Three things keep whaloc trustworthy, and a change is
measured against them:

- **[docs/SPEC.md](docs/SPEC.md) is the behavioral contract.** Meta-facing behavior — envelopes,
  error codes, webhook shapes, pagination semantics — should match what Meta actually does, and
  the captured samples and fixtures under `docs/fixtures/` are the evidence. A faithful quirk
  beats a tidy invention.
- **Deterministic by default.** Nothing fails, drops or changes state randomly; every failure is
  asked for. A feature that needs chance should be an explicit, inspectable rule instead.
- **Seeded IDs are a stable contract.** Downstream setups pin them (see the note on
  `DEFAULT_SEED`); changing a seed's natural keys changes the derived IDs and breaks those setups
  silently.

`npm install && npm test` is the whole loop (see [Development](#development)); `npm run lint`,
`npm run typecheck` and `npm run format:check` are what CI runs. New behavior comes with tests —
route-level through `app.request()`, webhook payloads asserted against fixtures.

## Acknowledgments

whaloc owes its shape to [**fdarian/whap**](https://github.com/fdarian/whap), an MIT-licensed
WhatsApp Cloud API mock that got there first: the split between a control plane and a UI that is
a pure client of it, the WebSocket event bus behind that, and — most concretely — its approach to
Meta's `X-Hub-Signature-256`. Meta escapes every code point above U+007F as `\uXXXX` _before_
hashing and signs exactly the bytes it sends, which is the kind of detail you discover by losing
an afternoon to it. whap had already lost that afternoon; whaloc's
`packages/server/src/domain/meta-json.ts` is a port of its
`src/server/middleware/hmac-signature.ts` (`Bun.CryptoHasher` swapped for `node:crypto`), and
whap's test vectors are carried over unchanged in the spec beside it.

whaloc diverges deliberately: a web UI instead of a TUI, Meta-faithful error envelopes
everywhere, deterministic behavior with no random failures, media, and configuration through the
environment only. Thanks to [@fdarian](https://github.com/fdarian) all the same.

The WhatsApp Cloud API is Meta's; whaloc is an independent reimplementation for local
development, unaffiliated with and unendorsed by Meta. The specs vendored under
`docs/meta-openapi/` are Meta's own, published under the
[Meta Platform Terms](https://developers.facebook.com/terms) and kept here for reference; the MIT
license below covers whaloc's code and documentation, not them.

## License

[MIT](LICENSE).
