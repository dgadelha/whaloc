# whaloc — WhatsApp Cloud API local emulator

whaloc is a local emulator of the **Meta WhatsApp Cloud API (Graph API v25.0)**, distributed as a single Docker image, configured entirely through **environment variables**. It exists so that apps integrating with the WhatsApp Cloud API can run fully offline in docker-compose: the app points `GRAPH_API_BASE_URL` at whaloc, and whaloc plays Meta's side of the conversation, including delivering signed webhooks back to the app.

It ships three surfaces on **one port**:

| Surface | Mount | Purpose |
|---|---|---|
| Graph API mock | `/:version{v\d+\.\d+}/...` (any version, e.g. `/v25.0`) | The endpoints the app under test calls |
| Control-plane API + WebSocket | `/api/...`, `/api/ws` | What the web UI (and tests/scripts) use to inspect state and simulate the "user side" |
| Web UI | `/` (static React bundle) | Chat-style UI to act as WhatsApp users, manage templates, inspect webhooks |

Design inspiration: [fdarian/whap](https://github.com/fdarian/whap), MIT (control-plane + UI-as-pure-client + WS event bus + HMAC approach), but web UI instead of TUI, Meta-faithful envelopes, deterministic behavior (no random failures), media support, and env-only configuration.

**Golden rule: deterministic by default.** Nothing fails or changes state randomly. Failures, rejections, and read receipts are triggered explicitly (UI/control-plane) or by documented configuration.

---

## 1. Consumer contract (fidelity requirements)

These are hard requirements, derived from the Meta adapters of a real production consumer of the Cloud API and from captured traffic between it and Meta. "The consumer" below is that class of client: an application that talks to the Graph API the way a production integration does. Violating any of these breaks such a consumer in subtle ways — usually not at the call that is wrong, but three hops later.

1. **Base URL includes the version**: the consumer sets `GRAPH_API_BASE_URL=http://whaloc:8080/v25.0` and appends `/{id}` paths to it. whaloc must accept **any** `/v\d+\.\d+` prefix (mount the same router for all).
2. **wamids** are opaque non-empty strings; generate Meta-shaped ones: `wamid.` + base64 (e.g. `wamid.HBgN...==`). Never reuse; unique per message.
3. **Media IDs must be digit-only strings, max 32 chars** (consumer validates `/^\d{1,32}$/` before calling). Template IDs should also be numeric strings (Meta emits them as JSON **numbers** in webhooks — stay ≤ 2^53).
4. **Error envelope** is Meta's, always:
   ```json
   {"error":{"message":"(#132000) ...","type":"OAuthException","code":132000,"error_subcode":33,"error_data":{"messaging_product":"whatsapp","details":"..."},"fbtrace_id":"A..."}}
   ```
   (`error_subcode`/`error_data` only when applicable; always include `fbtrace_id`, generated.)
   **Unknown object ID → HTTP 400 with `code:100, error_subcode:33`** ("object missing"), *not* 404. The consumer keys expired-media and deregistered-phone detection on exactly this.
5. **Pagination** (`GET /{wabaId}/message_templates`): return `paging.cursors.{before,after}` always; include `paging.next` **only when another page actually follows** — the consumer stops paging when `next` is absent. `paging.previous` is the mirror image (present only when a page precedes this one) and is what a `before` cursor is read off; a page is always served oldest first, whichever cursor asked for it.
6. **Send response** shape:
   ```json
   {"messaging_product":"whatsapp","contacts":[{"input":"<to>","wa_id":"<waid>"}],"messages":[{"id":"wamid...","message_status":"accepted"}]}
   ```
   `messages` must be non-empty; consumer reads only `messages[0].id`.
7. **Media download is two hops**: `GET /{media-id}?phone_number_id=...` → `{url, mime_type, sha256, file_size}`; then the consumer GETs that `url` directly (any host) with `Authorization: Bearer`, `Accept-Encoding: identity`, optional `Range`. The byte endpoint must support **Range** (206 + `Content-Range`), set `Content-Type`/`Content-Length`, and **never redirect** (3xx is treated as an error by the consumer). Build the `url` from `WHALOC_PUBLIC_URL` so it is reachable from other containers.
8. **Media upload** is streamed multipart with an injected first part `messaging_product=whatsapp`, then the consumer's parts `file` (binary) and `type` (mime string). `Content-Length` may be present or chunked. Respond `{"id":"<digits>"}`.
9. **Auth**: accept any non-empty `Bearer` token (consumer stores per-WABA tokens; never validates content). Missing/empty Authorization on Graph routes → 401 with `code:190` OAuthException envelope. **Strict mode** (`WHALOC_TOKENS`, §4): with a registry configured, only the listed tokens pass — an unregistered one is the *same* 401/190 envelope, and one marked expired through the control plane is 401 / 190 / **subcode 463** with no `error_data`. The byte endpoint stays outside the gate (§2.12).
10. **Timeouts**: consumer aborts JSON calls at 10 s. Don't add artificial latency by default.
11. **Rate-limit / throttling headers** the consumer parses when present: `Retry-After` (delta-seconds or HTTP-date) and `X-Business-Use-Case-Usage` (JSON; `estimated_time_to_regain_access` in minutes). Also log-only: `x-fb-request-id`. Emitted on injected 429s (§4, "Error simulation"); not needed on happy path.
12. **Webhook signature**: every webhook POST carries `X-Hub-Signature-256: sha256=<HMAC-SHA256(rawBody, WHALOC_APP_SECRET)>`, where **the HMAC input is byte-identical to the body actually sent**. Meta escapes every code point > U+007F as `\uXXXX` in the JSON it signs — reproduce that (serialize once with the escaping, use the same string/buffer for both body and HMAC). Port the approach (and test vectors) from whap's `src/server/middleware/hmac-signature.ts`, replacing `Bun.CryptoHasher` with `node:crypto`.
13. **Webhook handshake**: the consumer's receiver implements `GET /meta-webhooks?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` → echoes challenge. whaloc must be able to *initiate* this handshake (on demand from UI/control-plane, and optionally at startup) using `WHALOC_WEBHOOK_VERIFY_TOKEN`, and report the result.
14. **Status webhook timestamps** are strings of unix **seconds**. Inbound message timestamps likewise.
15. `POST /{phoneNumberId}/messages` may address the recipient via `to` (MSISDN, digits) **or** `recipient` (business-scoped user ID — **BSUID** — `^[A-Z]{2}\.(ENT\.)?[0-9A-Za-z]{1,128}$`). Contacts are modeled primarily by `wa_id` and may *also* carry a BSUID (`contacts.user_id`, unique when set, never seeded). A `recipient` that matches the pattern is **resolved** to the contact that owns it — the answer echoes `contacts:[{input:<bsuid>, wa_id:<contact wa_id>}]` — and an unknown BSUID is the missing-object envelope (§1.4), because a BSUID says nothing about a phone number and inventing a contact for one produces a conversation nothing can reach. A `recipient` that is not BSUID-shaped is treated exactly like a `to`. A contact with a BSUID also carries it through the webhooks: `contacts[].user_id` and `messages[].from_user_id` on inbound events, `statuses[].recipient_user_id` on statuses — always *alongside* `wa_id`/`from`/`recipient_id`, and always absent for a contact that has none.

### Response samples (from production traffic)

Send success (HTTP 200) — the frame of a captured response, re-minted over a synthetic number so no real one is published:

```json
{"messaging_product":"whatsapp","contacts":[{"input":"5511912345678","wa_id":"5511912345678"}],"messages":[{"id":"wamid.HBgNNTUxMTkxMjM0NTY3OBUCABEYEjYzNEQzNzJFQjhDMkNENzU5OQA=","message_status":"accepted"}]}
```

Template param mismatch (HTTP 400):

```json
{"error":{"message":"(#132000) Number of parameters does not match the expected number of params","code":132000,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"body: number of localizable_params (1) does not match the expected number of params (3)"},"fbtrace_id":"AOnodi98JaYHcSTvVvrOtJs"}}
```

### Canonical webhook payload fixtures

`docs/fixtures/webhooks/*.json` holds verbatim v25.0 webhook payloads captured from Meta's webhook references: inbound text, inbound image, status `sent` (with `conversation` + `pricing`), status `failed` (error 131049 with `href`), `message_template_status_update` APPROVED and REJECTED (with `rejection_info`), `message_template_quality_update`, `phone_number_quality_update`. whaloc's webhook builders must produce payloads structurally identical to these.

Six more are Meta's **documented samples** rather than captured traffic, and say so here: `system-user-changed-number.json` (see below), `referral-message.json` (a click-to-WhatsApp inbound, §5), `unsupported-message.json` (a message type this version cannot represent, §5), `account-update.json` and `account-restriction.json` (§3), and `business-capability-update.json` (§3).

Notable fixture facts:
- Envelope: `{object:"whatsapp_business_account", entry:[{id:"<wabaId>", time?, changes:[{value, field}]}]}`.
- Inbound `value`: `messaging_product`, `metadata:{display_phone_number (digits, no +), phone_number_id}`, `contacts:[{profile:{name}, wa_id}]`, `messages:[...]`.
- Inbound media node is named after the type: `{type:"image", image:{id, mime_type, sha256, url, caption?}}`. `url` is the byte URL the descriptor hop would hand out, so Meta's two download paths (fetch the node's `url`, or resolve the id first) land on the same place. An `audio` node always carries `voice` and a `sticker` node always carries `animated`, both booleans, because Meta puts them on every node of their type — and on no other type.
- **`sha256` is base64**, like Meta's (`SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=`), not hex: it appears in the webhook node, the descriptor hop and the control plane's inspector, and a consumer that decodes it to compare against its own hash of the downloaded bytes has to get 32 bytes back. The encoding is decided once, at the `MediaStorage` boundary (§6).
- Status value: `statuses:[{id, status, timestamp, recipient_id, conversation?:{id, expiration_timestamp?, origin:{type}}, pricing?:{billable, pricing_model:"PMP", type:"regular", category}, biz_opaque_callback_data?, errors?:[{code, title, message, error_data:{details}, href}]}]`.
- Context riders (§5) on an inbound message: `referral` rides **top-level**, `forwarded` / `frequently_forwarded` / `referred_product` ride **inside `context`** — merged with the `{from, id}` quote a reply produces, because Meta sends a forwarded reply as one `context` holding both halves. An `unsupported` message has no type node at all: `type:"unsupported"` plus an `errors[]` entry is the whole message.
- Template status update `value`: `{event:"APPROVED"|"REJECTED"|"PENDING"|"DELETED"|..., message_template_id:<number>, message_template_name, message_template_language, reason:"NONE"|..., message_template_category, disable_info?:{disable_date}, other_info?:{title, description}, rejection_info?:{reason, recommendation}}`. `other_info` rides on the transitions that **lock** a template — a pause (`title:"FIRST_PAUSE"`) and a disable (`title:"DISABLED"`) — and `disable_info.disable_date` (a string of Unix seconds) rides on the disable alone. A `DELETED` event reports **`reason: null`**, not the `"NONE"` string every other transition sends: Meta is explicit that a template scheduled for deletion changes that field's type.
- Template quality update `value`: `{previous_quality_score, new_quality_score, message_template_id:<number>, message_template_name, message_template_language}`.
- Phone quality update `value`: `{display_phone_number, event:"THROUGHPUT_UPGRADE"|..., old_limit?, current_limit, max_daily_conversations_per_business}`. `old_limit` appears only when the tier actually moved, which is what Meta says about it. `max_daily_conversations_per_business` carries the same tier as `current_limit` and is sent always: Meta removes `current_limit` in February 2026 and replaces it with this field, so sending both means a consumer written against either spelling keeps working across the cutover.
- System event (`system-user-changed-number.json`): a `messages` change whose message is `{from:<old wa_id>, id, timestamp, type:"system", system:{body, wa_id, new_wa_id, type:"user_changed_number"}}`. **There is no `contacts[]` array** — Meta's system-messages reference is explicit that "unlike other incoming messages webhooks, system **messages** webhooks don't include a `contacts` array", so the new `wa_id` is only in `system`, which is where a consumer has to read it. (whaloc sent one until the conformance audit; an app that keyed off it would have passed here and failed against Meta.) The new number appears under both spellings on purpose — Meta's webhook version decides which one it sends (`new_wa_id` on the older payloads, `wa_id` on the current ones) and the consumer reads `system.wa_id ?? system.new_wa_id`. `body` is Meta's own wording, `User ` prefix included.
- The BSUID keys (`contacts[].user_id`, `messages[].from_user_id`, `statuses[].recipient_user_id`) are **absent** from every captured fixture, because they came from contacts without one. They are additive: the payload of a contact that has a BSUID is its fixture plus exactly those keys, which is what the builder specs assert.

### Meta OpenAPI references

The v25.0 OpenAPI specs are vendored under `docs/meta-openapi/`. They define: `POST /{Phone-Number-ID}/messages`, `GET|POST /{WABA-ID}/message_templates` (+ `DELETE` with `name`/`hsm_id` query), `GET|POST /{TEMPLATE_ID}`, `GET /{WhatsApp-Account-Number-ID}`, `GET|POST /{WABA-ID}`, `GET /{WABA-ID}/phone_numbers`, media download. Use them to shape request validation, but the consumer contract above wins any conflict.

---

## 2. Graph API mock — MVP endpoint behavior

All routes live under `/:version{v\d+\.\d+}`. IDs are looked up across entity stores; the same `GET /:id` path serves phone numbers, WABAs, media, and templates — **dispatch by which store contains the ID**. Unknown ID → 400 `code:100, error_subcode:33`.

| # | Route | Behavior |
|---|---|---|
| 1 | `GET /:id` where `id` = phone number | Honor `fields` (default all): `verified_name`, `display_phone_number` (formatted, e.g. `+55 11 91234-5678` — non-blank!), `quality_rating` (`GREEN\|YELLOW\|RED\|UNKNOWN`), `throughput:{level:"STANDARD"\|"HIGH"}`, `status`, `code_verification_status`, `name_status`, `id` |
| 2 | `GET /:id` where `id` = WABA | `fields=id` → `{id}`; also support `name` |
| 3 | `GET /:id` where `id` = media (`?phone_number_id=` present) | `{url:"<WHALOC_PUBLIC_URL>/whaloc-media/<opaque token>", mime_type, sha256, file_size, id, messaging_product:"whatsapp"}` |
| 4 | `GET /:id` where `id` = template | `id, name, language, status, category, components` (honor `fields`) |
| 5 | `POST /:phoneNumberId/messages` | Validate envelope (zod), resolve the recipient (§1.15: `to`, or `recipient` for a BSUID), store message, respond per §1.6, schedule status ladder (§4). Message `type`: `text`, `template`, `image`, `video`, `audio`, `document`, `sticker`, `interactive`, `location`, `reaction`, `contacts`. **`biz_opaque_callback_data`** is an optional string the caller attaches to the send: stored on the message row, **never** echoed on the send response, and reported as `statuses[].biz_opaque_callback_data` on **every** status webhook that message produces — `sent`, `delivered`, `read`, `failed`, whether the ladder or a manual transition raised it. Meta caps it at 512 characters; so does whaloc, with the `(#100)` envelope |
| 6 | `POST /:phoneNumberId/media` | Parse multipart (`messaging_product`, `file`, `type`), persist via storage adapter, respond `{id}`. Enforce ~100 MiB cap |
| 6b | `DELETE /:mediaId` (optional `?phone_number_id=`) | → `{success:true}`; the row goes and the bytes go with it through `MediaStorage`. Afterwards the descriptor hop answers the missing-object envelope (§1.4) and the byte URL 404s like an unknown token, which is how a consumer's "this media is gone" path is rehearsed without waiting out `WHALOC_MEDIA_TTL_SECONDS`. Scoped exactly like the descriptor hop: another number's object — or one already past the TTL, or an ID that is not media at all — is 400 / 100 / 33 and stays put |
| 7 | `POST /:wabaId/message_templates` | Validate `{name, language, category, components, parameter_format?}`; duplicate (name+language) → 400 error envelope; else create with `status:"PENDING"`, respond `{id, status, category}`; kick off approval flow (§4). A media header's `components[].example.header_handle[]` is **resolved** against the Upload API (§2.21) — a handle no completed session owns is `(#100)` rather than a template whose header points at nothing — and the components are stored **verbatim**, so the association is just the handle plus its `upload_sessions` row. The edit (row 9) checks the same thing |
| 8 | `GET /:wabaId/message_templates` | Honor `fields`, `limit`, `after`, `before`. Cursor pagination per §1.5: `paging.next` only when a page follows, `paging.previous` only when one precedes, both carrying the caller's own `fields` and filters. Meta's filters, all optional and all combinable: `name` (exact), `name_or_content` (substring), `status`, `category`, `language`. A value outside an enum is `(#100)` rather than an empty page. **Divergence**: `name_or_content` matches the name or the *serialized* `components` column, so a search for a component keyword (`BODY`) matches broadly — it keeps the search in SQL, which is what keeps the keyset cursors correct under a filter |
| 9 | `POST /:templateId` | Edit: accept `{components}` (also `category`), set status back to `PENDING`, respond `{success:true}`, re-run approval flow |
| 10 | `DELETE /:wabaId/message_templates?name=&hsm_id=` | Delete all languages matching; respond `{success:true}`; unknown → HTTP **404** error envelope (consumer treats 404 as idempotent success) |
| 11 | `GET /:wabaId/phone_numbers` | List `{data:[<the row-1 node>], paging}`, honoring `fields` |
| 12 | `GET /whaloc-media/:token` (no version prefix) | Byte serving per §1.7 (Range, no redirects, correct headers) |
| 13 | `POST /:wabaId/phone_numbers` | `{phone_number:^[1-9][0-9]{6,14}$, verified_name:2..75, cc?, migrate_phone_number?, preverified_id?}` → `{id}` (digits). Starts `UNVERIFIED`/`NOT_VERIFIED`, `quality_rating:"UNKNOWN"`. Malformed number → 400 code 100 `Invalid parameter: phone_number must be in E.164 format`; digits already used by **any** WABA's number → **409** code 100 `Phone number is already registered with WhatsApp Business` (`GraphMethodException`). Unknown WABA keeps whaloc's uniform 400/100/33 (§1.4) rather than the vendored spec's 404/803 |
| 14 | `POST /:phoneNumberId/request_code` | `{code_method:"SMS"\|"VOICE", language}` → `{success:true}`. Derives the 6-digit code from the ID (stable, never expires) and stores it; the code is **only** readable through the control plane — whaloc is the phone |
| 15 | `POST /:phoneNumberId/verify_code` | `{code}`; match → `code_verification_status:"VERIFIED"` (and `UNVERIFIED` → `PENDING`), clearing the pending code. Mismatch or nothing pending → 400 `(#100) Invalid parameter` with the reason in `error_data.details` |
| 16 | `POST /:phoneNumberId/register` | `{messaging_product:"whatsapp", pin?}` → `{success:true}`, `status:"CONNECTED"`, `name_status:"APPROVED"`. An unverified number → 400 code `133006` |
| 17 | `POST /:phoneNumberId/deregister` | → `{success:true}`, `status:"DISCONNECTED"` (the closest of the spec's statuses); stays verified, so registering again is one call |
| 18 | `POST /:phoneNumberId/messages` with `{status:"read", message_id}` | The **read receipt** Meta overloads the send path with (`MarkMessageRequestPayload` in messages.yaml): `status:"read"` is the discriminator, the answer is `{success:true}`, and the named **inbound** message moves to `read`. Unknown wamid — or one belonging to another number — is the missing-object envelope (§1.4); an *outbound* wamid is `(#100) Invalid parameter` saying so; a number that is not `CONNECTED` is `133010` like a send. Idempotent, and **no webhook**: Meta reports statuses for outbound messages only. Adding `typing_indicator:{type:"text"}` marks the message read *and* raises a typing indicator for that conversation (§4) |
| 19 | `GET\|POST /:phoneNumberId/whatsapp_business_profile` | **GET**: `{data:[{messaging_product:"whatsapp", about?, address?, description?, email?, profile_picture_url?, websites?, vertical?}]}`, honoring `fields` (`messaging_product` always rides along). An unset field is **absent**, which is what an empty profile looks like: `{data:[{messaging_product:"whatsapp"}]}` | **POST**: `{messaging_product:"whatsapp", ...fields}` → `{success:true}`. **Merge**: only the fields present change, and an empty string (or empty array) clears one. Limits are Meta's — `about` ≤ 139, `address` ≤ 256, `description` ≤ 512, `email` ≤ 128, at most 2 `websites` of ≤ 256, `vertical` from Meta's enum. `profile_picture_handle` takes an **upload handle** (§2.21, Meta's own currency here) **or** a whaloc media ID, and sets `profile_picture_url` to that object's byte URL; a handle is not scoped to a number (an upload session belongs to the app), a media ID still is, and a value that resolves to neither is `(#100)` rather than a silent no-op. The media ID is kept alongside the handle on purpose: it is one call instead of three, and it is what whaloc's own docs, UI and scripts have always used. Stored as a JSON column on `phone_numbers`, **not** seedable — `WHALOC_SEED` stays a description of numbers and templates, and a fresh number's profile is empty |
| 20 | `POST\|GET\|DELETE /:wabaId/subscribed_apps` | `POST` → `{success:true}`; `GET` → `{data:[{whatsapp_business_api_data:{id, name:"whaloc", link}}]}`, or `{data:[]}` when nothing is subscribed; `DELETE` → `{success:true}`, idempotent. One implicit app: its ID is `WHALOC_APP_ID` or derived deterministically, its `link` is `WHALOC_PUBLIC_URL`. **Divergence: the subscription does not gate delivery** — webhooks keep going to `WHALOC_WEBHOOK_URL` either way, because that variable is what decides where they go and a dev tool that silently stopped delivering would be a support question. The subscription is persisted per WABA (`wabas.subscribed_at`) and reported in `GET /api/state` |
| 21 | **Resumable Upload API**: `POST /:appId/uploads`, `POST /upload:<opaque>`, `GET /upload:<opaque>` | Where a real `header_handle` comes from. `POST /{appId}/uploads?file_length=&file_type=&file_name=` opens a session → `{"id":"upload:<opaque>"}` (the parameters are read from the query string *or* the body, because Meta documents one and its SDKs send the other). `POST /upload:<opaque>` with `file_offset: 0` (header, or query) and the raw bytes as the body stores them and answers `{"h":"<handle>"}`. `GET /upload:<opaque>` answers `{"id":"upload:<opaque>","file_offset":<received bytes>}` — **truthful**, so a client that lost its connection knows where to resume; a chunk that does not land exactly on the current offset is `(#100)` rather than a silent overwrite, and more bytes than `file_length` promised is refused. `:appId` accepts whaloc's own app ID (§2.20) **or any digit-only ID** — an app under test is configured with a `META_APP_ID` that has no reason to equal `WHALOC_APP_ID`, and whaloc has one app either way; anything that is not an ID at all is `(#100)`. Handles are opaque, Meta-shaped (`4::<base64 mime>:ARZ…`), and usable wherever Meta uses one: `profile_picture_handle` (§2.19) and a template's `components[].example.header_handle[]` (§2.7). Sessions and their handles live in `upload_sessions`, so a handle survives a restart with a file database; the path segment carries a literal colon, which the router matches as one segment ahead of the template edit's `POST /{id}`. **Simplification**: a chunk that is not the whole file is stored by reading what is there, concatenating and putting it back under the same key — O(n²) in chunks, fine at these sizes, and it means a partial upload survives a restart too |
| 22 | `GET /whaloc-upload/:token` (no version prefix) | The bytes behind a completed handle, with the same `Range` / no-redirect rules as §2.12. Its own token space, because a handle is not a media ID and is not scoped to a phone number. Unknown or still-incomplete → plain 404. **Divergence**: the `media.download` injection target (§4) names `/whaloc-media/{token}` only; this route is reachable through `graph.all` |

Template **send** validation: when a `template` message references a known template, validate the parameters against its components — `parameter_format:"NAMED"` templates take `parameters:[{type:"text", parameter_name, text}]`; positional take `{{1}}`-style. Mismatch → the real 132000 error (see sample). Sends of templates whose status ≠ APPROVED → error 132001 (template not found/not approved). Unknown template name: same 132001.

Message sends where the recipient equals nothing known: auto-create the contact (default profile name = the MSISDN) so the conversation shows up in the UI. **Except a BSUID** (§1.15): an unresolvable `recipient` is 400 / 100 / 33, since there is no number to create a contact under.

---

## 3. Webhook emission engine

A single **WebhookEmitter** service owns all outbound deliveries:

- Serializes payload with Meta's `\uXXXX` escaping; signs the exact bytes (§1.12); POSTs to `WHALOC_WEBHOOK_URL` with `Content-Type: application/json`, `User-Agent: facebookexternalua`.
- **Delivery log**: every attempt is persisted — payload, headers, target URL, response status/body (truncated), duration, error — and browsable in the UI. This is a first-class feature.
- Retries: on 5xx/network error, retry with short backoff (e.g. 3 attempts: 0s/2s/10s), each attempt logged. No retry on 2xx–4xx.
- Handshake action (§1.13): `GET <WHALOC_WEBHOOK_URL>?hub.mode=subscribe&hub.verify_token=...&hub.challenge=<random>` and verify the echo; expose result via control-plane; optionally run at startup (`WHALOC_VERIFY_ON_START=true`).
- Events emitted: inbound messages (all types, including `unsupported` and the context riders of §5), statuses (`sent`/`delivered`/`read`/`failed`), the `user_changed_number` **system** event (§5), `message_template_status_update` (APPROVED/REJECTED/DELETED/PENDING transitions), `message_template_quality_update`, `phone_number_quality_update` (all three quality/template events UI-triggered), the two **account-level** notices below, plus a **raw webhook** escape hatch (arbitrary JSON body from the UI, still signed).
- **`account_update`** — field `"account_update"`, value `{phone_number?, event, restriction_info?}`, `entry.id` = the chosen WABA, `entry.time` set. Events: `VERIFIED_ACCOUNT`, `DISABLED_UPDATE`, `ACCOUNT_RESTRICTION`, `ACCOUNT_DELETED`, `ACCOUNT_VIOLATION`; `restriction_info` is `[{restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION"|"RESTRICTED_BIZ_INITIATED_MESSAGING"|"RESTRICTED_CUSTOMER_INITIATED_MESSAGING", expiration?}]` and rides only on `ACCOUNT_RESTRICTION`. `phone_number` (bare digits) appears only when a number was named.
- **`business_capability_update`** — field `"business_capability_update"`, value `{max_daily_conversation_per_phone, max_phone_numbers_per_business}` as JSON numbers.
- **Both account-level events are emissions and nothing else**: no whaloc state changes when one goes out. There is no "restricted" flag behind `ACCOUNT_RESTRICTION` and no quota behind the capability numbers, because what a consumer has to get right is its *handler* — and inventing state Meta would then contradict (a whaloc that refused to send while "restricted" is a whaloc that lies about why) would cost more than it buys. Every other webhook whaloc sends describes something it actually did; these two describe something Meta decided.

## 4. Deterministic status ladder & template lifecycle

- On accepted send: emit `sent` immediately, then `delivered` after `WHALOC_STATUS_DELAYS` (default `sent:0,delivered:800`). **`read` is manual by default** (button in UI, or `read:<ms>` in the env var to automate). `failed` only ever manual (UI picks an error code from presets: 131049 engagement, 131026 undeliverable, 131047 re-engagement window, 130472 experiment; sends proper `errors[]`).
- Status webhooks for `sent`/`delivered` include `conversation` + `pricing` shaped like the fixture (conversation ID = stable hash of phone+contact+day; `origin.type`/`pricing.category` = template category lowercased, else `service`; `expiration_timestamp` = now+24h as string).
- Template create/edit → status `PENDING`; if `WHALOC_TEMPLATE_AUTO_APPROVE` (default `2000` ms) is not `off`, auto-approve after the delay and emit the webhook. UI can approve/reject (with `reason`/`rejection_info`) any PENDING template, and later pause/disable — every transition emits the webhook. A **seeded** template never enters this flow: it is `APPROVED` at boot, announces nothing and schedules no timer (§7).
- Timers must survive nothing: they are in-process `setTimeout`s; on restart pending timers are dropped (fine for a dev tool — document it).

### Typing indicators

A typing indicator belongs to a conversation and lives **only in memory**, next to those timers.
It goes up when the app under test sends `typing_indicator` on `POST /{phoneNumberId}/messages`
(§2 row 18) and comes down at the first of: Meta's **25-second** dismissal window, the next
outbound message in that conversation, a `POST /api/reset`, or a restart. Both edges are
published as `typing.changed` (§5) and readable through `GET /api/typing`; nothing about it is
persisted, and no webhook describes it.

### Phone number registration ladder & the send gate

A phone number's `status` decides whether it can send at all, and **only `CONNECTED` can**: a
`POST /{phoneNumberId}/messages` from anything else is error `133010` ("Phone number not
registered"), which is what a consumer keys deregistration detection on. The rungs (§2, rows
13–17), with nothing timed and nothing random:

| Stage | `status` | `code_verification_status` | `name_status` |
|---|---|---|---|
| seeded, or created through the control plane | `CONNECTED` | `VERIFIED` | `APPROVED` |
| created via `POST /{wabaId}/phone_numbers` | `UNVERIFIED` | `NOT_VERIFIED` | `PENDING_REVIEW` |
| …with a `preverified_id` | `PENDING` | `VERIFIED` | `PENDING_REVIEW` |
| after `verify_code` | `PENDING` | `VERIFIED` | `PENDING_REVIEW` |
| after `register` | `CONNECTED` | `VERIFIED` | `APPROVED` |
| after `deregister` | `DISCONNECTED` | `VERIFIED` | `APPROVED` |

**Everything that existed before the ladder starts at the top of that table**, which is what
keeps `WHALOC_SEED` (and every consumer configured against it) working unchanged: only a number
created through the Graph endpoint has to climb. `request_code` is accepted at any rung — asking
is harmless and it is the shortest way to see the flow in the UI — and only `verify_code` moves
anything.

### Error simulation: token registry, injection rules, media TTL

Three ways to make whaloc misbehave **on purpose**. All three are off by default, none of them
is probabilistic, and each is visible from the UI — a failure a developer did not ask for is a
support question, and a failure they *did* ask for but forgot about is worse.

**Strict tokens** (`WHALOC_TOKENS`, §1.9). Unset, whaloc is permissive and there is nothing to
list. Set to a comma-separated registry, only those tokens pass; the control plane can mark any
of them expired (`POST /api/tokens/:id/expire`, `…/restore`), which is the 401 / 190 / 463
envelope. Expiry is **persisted** — a row per expired token, keyed by a truncated SHA-256 so the
database never holds a credential — and `POST /api/reset` revives every token. The registry is
served masked (`••••••••cdef`) and the token values never leave the process.

**Injection rules.** A rule is a *target*, a *trigger* and a *response preset*, created at
runtime through the control plane and stored in the database (cleared by `POST /api/reset`).

| Part | Values |
|---|---|
| Target (endpoint class) | `messages.send` (`POST /{phoneNumberId}/messages`), `media.upload`, `media.resolve` (`GET /{mediaId}?phone_number_id=`), `media.download` (`GET /whaloc-media/{token}`), `templates.create`, `templates.list`, `graph.all` (every Graph request, the byte endpoint included) |
| Trigger | `always`; `next N` with a live countdown; `every Nth` counted off the rule's own request counter (fires on the 3rd, 6th, 9th…) |
| Preset | `rate_limit_429` (429, code `130429`, `Retry-After: <seconds>` + `X-Business-Use-Case-Usage`), `throughput_131056` (400, code `131056`, no headers), `spam_rate_4` (429, code `4`, same two headers), `server_error_500` (500, code `1`), `custom` (caller supplies http status, code, optional subcode, message, details, type) |

The usage header is Meta's, keyed by business ID, with the throttled app's quota at 100 %:

```json
{"<waba-id>":[{"type":"whatsapp","call_count":100,"total_cputime":100,"total_time":100,"estimated_time_to_regain_access":15}]}
```

`estimated_time_to_regain_access` is in **minutes** while `Retry-After` is in seconds (§1.11);
both are per-rule, defaulting to 60 s / 15 min. The header is keyed by the first WABA whaloc
knows about, and left off entirely when there is none.

Evaluation happens in **one middleware on the Graph surface, before any handler** — and after
the bearer gate, so an armed `graph.all` rule can never disguise a 401. Every rule whose target
matches has its request counter advanced; the **first one in creation order that its trigger
arms** answers, and a rule shadowed by an earlier one keeps its countdown (it has not fired). A
match short-circuits with the Meta envelope, its headers and an `info` log line. The decision is
domain (`InjectionService`); only the short-circuit is Hono.

**Media TTL** (`WHALOC_MEDIA_TTL_SECONDS`, default off). An object whose age has *reached* the
TTL — the boundary is inclusive — is gone from the Graph surface: the descriptor hop answers the
missing-object envelope (**400 / code 100 / subcode 33**, §1.4, which is what consumers key
expired-media detection on) and the byte endpoint answers the same plain 404 an unknown token
gets, because that route carries no Meta envelope. Age is measured from the row's `created_at`
against the injectable clock, so it is exact in tests. The row and the bytes stay put — only a
reset deletes those — and the control plane's `GET /api/media/:id` ignores the TTL, so whaloc's
own UI can still explain what a message's media ID pointed at.

## 5. Control-plane API (`/api`) + WebSocket

REST consumed by the web UI (and by test scripts). Suggested resources (final shapes belong to `packages/shared` zod schemas — UI and server both import them):

- `GET /api/state` — WABAs (with `subscribedAt`, §2.20), phone numbers (lifecycle fields, the pending verification code and the business profile included), the app identity `subscribed_apps` reports, behavior config, webhook target status.
- `GET/POST /api/wabas`, `PATCH/DELETE /api/wabas/:id` — WABAs at runtime; a delete cascades to phone numbers (and their conversations, messages and media bytes) and templates. Deleting the last one is allowed: an empty whaloc is a legal state.
- `GET/POST /api/phone-numbers`, `PATCH/DELETE /api/phone-numbers/:id` — numbers under a WABA. Created here they are `CONNECTED`/`VERIFIED` (the "already onboarded" path, §4); `PATCH` takes `displayPhoneNumber`/`verifiedName`; a delete cascades like the above. Duplicate digits → 409.
- **Explicit IDs.** Both creates take an optional `id` (1–32 digits, §1.3), so a WABA or a phone number can be given the one an app's production configuration already names instead of a freshly minted one; omitted, whaloc mints it. Because `GET /{id}` dispatches by whichever store holds the ID (§2), an explicit ID has to be free across **every** store — WABAs, phone numbers, media and templates — and one that is taken is a 409 naming what holds it. The Graph-side `POST /{wabaId}/phone_numbers` takes no such field: it is Meta's request shape, and Meta assigns the ID.
- `GET/POST/PATCH /api/contacts` — wa_id, profile name, and the optional **BSUID** (`userId`, §1.15): validated against Meta's pattern, unique across contacts (a duplicate is a plain 409), `null` clears it. Seedable: a `WHALOC_SEED` contact may carry `userId`, and the default seed gives both contacts one (one `ENT.` form, one without), so identity fields appear on webhooks out of the box.
- `POST /api/contacts/:waId/change-number` — `{waId, phoneNumberId?}`: the person moved. The contact's `wa_id` changes **in place** — profile name, BSUID and history follow it — and whaloc emits Meta's `user_changed_number` system event (§3) for every business number that has a conversation with the contact, or only for `phoneNumberId` when one is named. A number another contact already holds is a 409 and nothing moves; the same number is a 400. **wamids never change**, so a reaction, a reply or a read receipt naming an older message keeps resolving; the *derived* conversation IDs (`<phoneNumberId>:<waId>`) do change, which is what `contact.changed`'s `previousWaId` exists for. The system message is a webhook event only — no message row is stored for it.
- `GET /api/conversations?phoneNumberId=` / `GET /api/conversations/:id/messages` (paginated, newest last).
- `POST /api/inbound` — simulate a user message: `{phoneNumberId, from, type, ...typed payload}`; supports every inbound type: text, media (referencing an uploaded media ID or multipart upload via `POST /api/inbound-media`), interactive `button_reply`/`list_reply`, `button`, location, contacts, reaction, and **`unsupported`** — Meta's placeholder for a message this API version cannot represent (a poll, say), which goes out as `{type:"unsupported", errors:[{code:131051, title:"Message type unknown", message:"Message type unknown", error_data:{details:"Message type is currently not supported."}}], unsupported:{type:"poll_update"}}`: the v16+ error-node shape *and* the `unsupported` node naming the type Meta could not represent, which the optional `unsupportedType` picks from Meta's own list (`button`, `edit`, `order`, `poll_creation`, `poll_update`, …) and defaults to `poll_update`. It is stored as a message row so the chat shows a placeholder bubble. Every type also accepts the **context riders**, all optional and all combinable:
  - `referral` — a click-to-WhatsApp ad or post: `{source_url, source_type:"ad"|"post", source_id, headline?, body?, media_type?:"image"|"video", image_url?, video_url?, thumbnail_url?, ctwa_clid?, welcome_message?:{text}}`, written in Meta's snake_case and echoed **top-level on the message**. `welcome_message.text` is the greeting the ad pre-filled, which is how a handler tells an ad-generated opener from something the person typed.
  - `forwarded` / `frequentlyForwarded` — booleans that become `context.forwarded` / `context.frequently_forwarded`.
  - `referredProduct` — `{catalog_id, product_retailer_id}`, which rides **inside `context`**, not beside it.

  The riders merge with the `context` a `replyTo` produces rather than replacing it, so a forwarded reply about a catalog item is one `context` with `from`, `id`, `forwarded` and `referred_product` in it. Persists + emits webhook.
- `POST /api/messages/:id/status` — `{status:"read"|"delivered"|"failed", errorCode?}` manual transitions; `GET /api/message-error-presets` lists the failure presets that action accepts (code + Meta's wording), which is what the UI's "fail…" menu is built from.
- `GET /api/typing?phoneNumberId=` — the typing indicators that are up right now (§4). Read-only: an indicator is something the *app under test* declares, so the control plane serves them (for a UI that just loaded, and for assertions) but never raises one.
- `GET /api/media/:id` — the descriptor behind a media ID (`{id, url, mimeType, sha256, fileSize}`), so the UI can render an inline preview of a message whose payload only carries the ID.
- `GET /api/uploads?handle=` — the same, for a **resumable-upload handle** (§2.21): `{handle, url, mimeType, sha256, fileSize, fileName, createdAt}`, 404 when no completed session owns it. A template's `example.header_handle` carries a handle rather than a media ID, so this is what lets the Templates view preview a media header with the picture it will actually send. The handle rides in the query string because Meta's handles are full of colons.
- `GET /api/templates?wabaId=&status=&category=&language=&name=&search=` — the same filters the Graph listing takes (§2.8; `search` is `name_or_content`), applied server-side so the UI's filter bar and a consumer's filtered listing agree. `POST /api/templates/:id/approve|reject|pause|quality` (quality → quality_update webhook).
- `GET /api/webhook-deliveries?limit=&before=` / `POST /api/webhook-deliveries/:id/redeliver` / `POST /api/webhook/handshake` / `POST /api/webhook/raw`.
- `POST /api/webhook/account-update` — `{wabaId, event, phoneNumberId?, restrictionInfo?}` and `POST /api/webhook/business-capability-update` — `{wabaId, maxDailyConversationPerPhone, maxPhoneNumbersPerBusiness}`: the two account-level notices (§3), triggered from Settings per WABA the way the phone-quality one is triggered per number. Both answer with the delivery attempts, like the raw sender, and **change no whaloc state**. An unknown WABA is a 404; a `phoneNumberId` under a different WABA is a 400.
- `POST /api/phone-numbers/:id/quality` — set quality_rating/throughput + optionally emit `phone_number_quality_update`.
- `POST /api/phone-numbers/:id/business-profile` — the same profile the Graph endpoint writes (§2.19), in camelCase, with the same merge-and-clear semantics; answers with the updated number. The subscription (§2.20) has no control-plane write: only the app under test subscribes.
- `GET/POST /api/injection-rules`, `DELETE /api/injection-rules/:id` — the error-injection rules (§4). No `PATCH`: a rule is three decisions and a countdown, and deleting plus re-adding leaves no question about what happened to the counters.
- `GET /api/tokens`, `POST /api/tokens/:id/expire|restore` — the `WHALOC_TOKENS` registry (§1.9), masked. `{strict:false, data:[]}` when there is no registry, which is what the UI hides its section on.
- `POST /api/reset` — wipe all state (keep seed). Injection rules and token expiry go with it.
- `GET /api/export` — the whole state as **one downloadable JSON file** (`Content-Disposition: attachment`), so a scenario is shareable: schema version, whaloc version, `exportedAt`, every domain table as its **raw rows** (snake_case, JSON columns still TEXT — a snapshot is a database dump, not an API resource), and the bytes of every media object **and every completed upload session** (§2.21) **base64-inlined** beside their rows, so an imported template still previews its media header. Rows are ordered deterministically, so two exports of the same state differ only in the timestamp. The delivery log is left out unless `?include=deliveries` asks for it (it is traffic, not state, and by far the biggest table). Base64 costs a third in size over the raw bytes: acceptable for a dev tool whose media is a handful of test images, and the price of a file that restores completely on its own.
- `POST /api/import` — the mirror image, from a JSON body or a `multipart/form-data` upload (`file`). Validated in full first (zod, every row and enum) and **version-gated**: a snapshot from a newer whaloc is refused with a clear message rather than half-loaded. Then all state is replaced — timers cancelled like a reset, the database swapped in **one transaction**, stale media bytes deleted and the snapshot's written back **through the current storage backend**, so a local export imports into an S3-backed instance and vice versa (§6). Answers with a summary count, and publishes `state.imported` so connected UIs reload. **The seed does not re-run**: the snapshot *is* the state, IDs included — `POST /api/reset` remains the only way back to `WHALOC_SEED`. Media rows are restored verbatim, digest included, so a snapshot taken before `sha256` became base64 (§1) keeps its hex digests for those rows — the snapshot *is* the state, and re-hashing somebody else's world on the way in would be a different kind of lie. Anything uploaded afterwards is base64; re-uploading the object, or exporting from a current whaloc, settles it.
- `GET /api/health` (alias `/health` at root, for Docker HEALTHCHECK).

WebSocket `/api/ws`: server → client events `{type, payload}`: `message.created`, `message.status_changed` (a read receipt on an inbound message arrives this way — there is no separate `message.read`), `typing.changed` (`payload.typing.expiresAt === null` means it came down), `template.changed`, `webhook.delivery`, `contact.changed` (with `previousWaId` when the contact changed number, so a client can re-key what it derived from the old one), `waba.changed`, `phone_number.changed` (both carry `event:"created"|"updated"|"deleted"`; a phone number's rung on the ladder — a `request_code` included — arrives this way too), `injection.changed` (an `updated` event is published for every rule a request touched, which is what makes the UI's countdown live), `token.changed`, `state.reset`, `state.imported` (the same payload as a reset — a client drops everything and reloads either way; the two are separate because one comes back to the seed and the other to somebody else's world). UI is a pure client of REST+WS — no other coupling.

## 6. Data model & persistence

**Kysely + `node:sqlite`** (built into Node 24; no native deps, no WASM). Default DB is `:memory:`; `WHALOC_DB_PATH=/data/whaloc.db` makes state survive restarts (volume). Use Kysely's SQLite dialect surface with a thin custom driver over `node:sqlite`'s `DatabaseSync` (prefer a well-maintained npm dialect if one exists — verify on npm — else write the ~100-line driver in `packages/server/src/db/`; reuse Kysely's `SqliteAdapter`/`SqliteQueryCompiler`/`SqliteIntrospector`). Migrations run at boot (Kysely migrator, in-code migration list).

Tables (roughly): `wabas`, `phone_numbers` (`id`, waba_id, display_phone_number, verified_name, quality_rating, throughput_level), `contacts` (wa_id, profile_name, user_id — the BSUID, nullable and unique), `templates` (`id` digits, waba_id, name, language, category, parameter_format, components JSON, status, rejected_reason, quality_score), `messages` (wamid, direction, phone_number_id, contact, type, payload JSON, status, error JSON, biz_opaque_callback_data, timestamps, reply_to), `media` (`id` digits, phone_number_id, mime_type, sha256, file_size, storage_key, url_token), `upload_sessions` (`id`, app_id, file_name, file_type, file_length, received_bytes, handle unique, storage_key, sha256, url_token unique, timestamps — §2.21; one row is the whole life of an upload, which is why a handle survives a restart), `webhook_deliveries` (`id`, event_type, url, request_body, request_headers, response_status, response_body, error, attempt, duration_ms, created_at), `injection_rules` (`id` time-ordered, target, trigger_kind, trigger_count, preset, retry_after_seconds, regain_access_minutes, custom JSON, seen, matches, remaining, timestamps), `expired_tokens` (token_id = truncated SHA-256, expired_at).

**Media bytes** go through a `MediaStorage` interface (`put(stream|buffer, meta) → {storageKey, sha256, byteSize}`, `get(storageKey, {range?}) → {stream, size}`, `delete`, optional `close`), with two implementations selected by `WHALOC_MEDIA_BACKEND`:

| Backend | Implementation | Where the bytes go |
|---|---|---|
| `local` (default) | `LocalDirStorage` | one flat directory of opaque files, rooted at `WHALOC_MEDIA_DIR` (default `/data/media`, fallback `./data/media` outside Docker), created on the first upload |
| `s3` | `S3MediaStorage` | an S3-compatible bucket (`WHALOC_S3_*`), via `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` |

**Nothing outside the storage module may touch the filesystem — or the bucket.** The `@aws-sdk` dependency lives in `storage/` and nowhere else, and no caller ever learns which backend it got: that is what makes a snapshot (§5) exported from a local-backed whaloc importable into an S3-backed one.

Shared contract, enforced by one vitest suite both implementations run (`storage/media-storage-contract.ts`):

- Storage keys are flat and conservative (`^[\dA-Za-z][\w.-]{0,127}$`) — no separators, nothing to traverse with — so the same key is valid on both backends and travels inside a snapshot.
- `put` measures the SHA-256 and the byte count **while the bytes stream past**, never buffering the object: the local backend pipes to a file, the S3 one hands the stream to `lib-storage`, which sends anything under one 5 MiB part as a single `PutObject` and switches to multipart above it. A failed upload leaves nothing behind under its key (the local backend waits for its write stream to close before deleting — the descriptor is opened asynchronously, and deleting before it lands leaves a zero-byte file).
- `get` honors an inclusive byte range (the consumer's `Range`, §1.7) and always reports the size of the **whole** object — read off `Content-Range` when the answer is a slice.
- A missing object is `MediaObjectNotFoundError` from `get` and a no-op for `delete`.

The S3 side of the contract suite runs against **MinIO**: in CI as a service container, locally when `WHALOC_TEST_S3_ENDPOINT` points at one. Unset, those specs skip with a message saying how to start it — a machine without Docker still gets a green `npm test`.

## 7. Configuration (environment variables only)

Parsed once at boot with zod (fail fast, print every error). No config files.

| Var | Default | Purpose |
|---|---|---|
| `WHALOC_PORT` | `8080` | Listen port |
| `WHALOC_HOST` | `0.0.0.0` | Bind address |
| `WHALOC_PUBLIC_URL` | `http://localhost:8080` | Base for generated media URLs / paging.next |
| `WHALOC_WEBHOOK_URL` | *(unset → webhooks disabled, warn loudly)* | Target for webhook POSTs, e.g. `http://meta-webhook-receiver:3001/meta-webhooks` |
| `WHALOC_APP_SECRET` | *(unset → deliveries unsigned, warn)* | HMAC key for `X-Hub-Signature-256` |
| `WHALOC_WEBHOOK_VERIFY_TOKEN` | *(unset)* | Used for the `hub.challenge` handshake action |
| `WHALOC_VERIFY_ON_START` | `false` | Run handshake at boot |
| `WHALOC_APP_ID` | *(derived, stable)* | The app ID `subscribed_apps` reports (§2.20). Set it to the `META_APP_ID` the app under test uses; left unset it is derived deterministically, so it survives restarts |
| `WHALOC_SEED` | *(built-in default seed)* | JSON: `[{"id?","name?","phoneNumbers":[{"id?","displayPhoneNumber","verifiedName?","qualityRating?","throughputLevel?"}],"contacts?":[{"waId","name","userId?"}],"templates?":[{"id?","name","language?","category?","parameterFormat?","components?"}]}]`; omitted IDs are generated deterministically. A seeded template is **`APPROVED` from the first instant** (no review, no webhook), with `language` defaulting to `en`, `category` to `UTILITY`, `parameterFormat` to `NAMED` and `components` to a single static BODY. Default seed: 1 WABA + 1 phone number + 2 contacts + 1 zero-parameter template (`hello_whaloc` / `en`), logged at startup |
| `WHALOC_STATUS_DELAYS` | `sent:0,delivered:800` | Ladder config; add `read:<ms>` to automate read |
| `WHALOC_TEMPLATE_AUTO_APPROVE` | `2000` | ms until auto-approval; `off` = manual |
| `WHALOC_TOKENS` | *(unset → any non-empty bearer token)* | Comma-separated bearer-token registry (§1.9, §4). Set it and only these tokens pass; blank entries are dropped, duplicates rejected. Each can be expired/restored from the control plane |
| `WHALOC_MEDIA_TTL_SECONDS` | *(unset → media never expires)* | Whole seconds after which a media object is gone from the Graph surface (§4) |
| `WHALOC_DB_PATH` | `:memory:` | SQLite path for persistence |
| `WHALOC_MEDIA_BACKEND` | `local` | `local` (a directory) or `s3` (an S3-compatible bucket), §6 |
| `WHALOC_MEDIA_DIR` | `/data/media` (image) | Media storage root, for the `local` backend |
| `WHALOC_S3_BUCKET` | *(required with `s3`)* | Bucket the media objects live in; whaloc never creates it |
| `WHALOC_S3_REGION` | *(required with `s3`)* | Region; any value satisfies MinIO, but the SDK insists on one |
| `WHALOC_S3_ENDPOINT` | *(unset → AWS S3)* | Endpoint of an S3-compatible server (MinIO, R2, Ceph) |
| `WHALOC_S3_ACCESS_KEY_ID` | *(unset → SDK default chain)* | Access key; all-or-nothing with the secret below |
| `WHALOC_S3_SECRET_ACCESS_KEY` | *(unset → SDK default chain)* | Secret key |
| `WHALOC_S3_FORCE_PATH_STYLE` | `true` when an endpoint is set | Path-style addressing (`<endpoint>/<bucket>/<key>`) |
| `WHALOC_WEB_DIR` | `packages/web/dist` beside the server | Built web UI served at `/`; an absent directory just leaves `/` unrouted (dev runs the UI under Vite) |
| `WHALOC_LOG_LEVEL` | `info` | pino level |

## 8. Architecture & repo layout

npm workspace, three packages:

```
packages/
  shared/   # zod schemas + TS types for the control-plane API and WS events (imported by server & web)
  server/   # Hono app
    src/
      config/        # env parsing (zod), typed AppConfig
      logging/       # pino setup, request logging middleware
      db/            # kysely + node:sqlite dialect, migrations, repositories
      storage/       # MediaStorage interface + local-dir implementation
      domain/        # services: messages, templates, media, contacts, statuses (ladder scheduler),
                     # webhook-emitter, id generators (wamid/media/template/fbtrace), meta-json (unicode-escaping serializer + HMAC)
      graph-api/     # Hono routers mirroring Meta (routes → zod validation → domain services), meta error helpers
      control-api/   # /api routes + WS hub
      app.ts         # compose Hono app (mounts all three surfaces + static UI)
      main.ts        # entry: config → logger → db → app → listen
  web/      # React 19 + Vite + react-router; pure CSS (no Tailwind); clsx where useful
```

`npm run dev` runs the server watcher and Vite side by side through `concurrently` (npm itself
has no --parallel).

**Separation of concerns is non-negotiable**: routes do parsing/validation/HTTP mapping only; domain services hold behavior and never import Hono; repositories own SQL; the WS hub and webhook emitter are injected into services (constructor injection, plain classes/factories — no DI framework). Everything with behavior gets unit tests (vitest); the Graph routes get integration tests through `app.request()` (Hono's built-in test client) asserting exact Meta envelopes, plus webhook-delivery tests against a local capture server.

**Error handling**: one error hierarchy in the domain (`GraphApiError` carrying code/subcode/http status/details) mapped to the Meta envelope in a single Hono `onError`; control-plane errors use a plain `{error:{message,code}}` shape. Never leak stack traces in responses; always log with pino (`err` serializer), include a request ID (`x-fb-request-id`-style) in Graph responses and logs.

### Web UI shell & routes

whaloc holds several WABAs and several numbers at runtime, so the UI's frame is a **single top bar** — brand, scope, view tabs, live indicators — over full-width content. There is no sidebar.

The scope is a **breadcrumb whose depth follows the view**, and it lives in the URL:

| View      | Scope           | Route                                                            |
| --------- | --------------- | ---------------------------------------------------------------- |
| Chats     | WABA ▾ / number ▾ | `/w/:wabaId/p/:phoneNumberId/chats[/:contactWaId]`, and `/w/:wabaId/chats` for an account with no number yet |
| Templates | WABA ▾          | `/w/:wabaId/templates`                                             |
| Webhooks  | none            | `/webhooks`                                                        |
| Settings  | none            | `/settings`                                                        |

A conversation is named by its **contact**, not by the derived `<phoneNumberId>:<waId>` ID: the number is already a segment above it, and a contact that changes number moves within the same path.

The URL is the **single source of truth**. One gate resolves the path's IDs against `GET /api/state` before a view renders, then announces the result to the store; the reducer heals the store the same way through the same pure `resolveScope`, so a `waba.changed`/`phone_number.changed` deletion cannot leave the two disagreeing. Rules:

- `/`, a bare `/chats` or `/templates`, and anything unrecognised → the scope this browser used last (`localStorage`, best-effort) else the first WABA that has a number. An old-style `/chats/<phoneNumberId>:<waId>` link is carried into its scope rather than dropped.
- A path naming a WABA or a number that is gone → the closest scope that exists, plus a toast. A number that exists under a *different* account repairs the account rather than the number.
- No WABA at all → every scoped tab is disabled and the content offers "Create your first WABA"; a WABA with no number → the Chats view offers to add one. Both open the same dialogs Settings uses.

### Runtime & tooling

- **Node 24 (LTS)**, TypeScript run natively: dev = `node --watch --experimental-transform-types --disable-warning=ExperimentalWarning src/main.ts`; prod = `tsc -p tsconfig.build.json` → plain `node dist/main.js`.
- Package manager: **npm** — the one bundled with Node 24, so a clone needs nothing installed first. No `packageManager` pin (and no corepack); `engines` states the floor (`node >=24.0.0`, `npm >=11.0.0`) and the root manifest lists the three workspaces in dependency order, since npm runs workspace scripts in that order rather than topologically.
- **Hono** + `@hono/node-server` (its v2 `upgradeWebSocket` over a `noServer` `ws` server handles `/api/ws`, so `@hono/node-ws` — still pinned to node-server v1 — is not used); request bodies are validated by parsing them with the zod schemas directly.
- **zod v4**, **pino** (JSON-only — pipe through `npx pino-pretty` for colors), **kysely**, **vitest v4**, **eslint flat config + prettier**: `strictTypeChecked` + `eslint-plugin-unicorn` (all) + prettier; `.prettierrc`: tabs, width 120, double quotes, `arrowParens:"avoid"`, `trailingComma:"all"`. tsconfig: `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` (relative imports carry `.ts`), `isolatedModules`, `erasableSyntaxOnly` (no enums/namespaces — required for Node type stripping).
- React UI: React 19, react-router, plain CSS (CSS custom properties for theming; light+dark). Vite dev server proxies `/api`, `/api/ws`, `/v25.0`, `/whaloc-media` to the server.
- CI: GitHub Actions — install, lint, typecheck, test, build (all packages), docker build. Image published to `ghcr.io/dgadelha/whaloc`.

### Docker

Multi-stage: build stage (`npm ci`, build shared+server+web) → a deps stage that reruns `npm ci --omit=dev` scoped to the server workspace → runtime stage on `node:24-alpine`, non-root user, only prod deps + `dist` + web static; `HEALTHCHECK` on `/health`; `VOLUME /data`. Target image well under 300 MB.

### Compose integration (documentation deliverable)

An application under test and whaloc, side by side — the whole shape of an integration (`docs/integrating.md` is the long form):

```yaml
services:
  app:
    build: .
    environment:
      # The version segment is mandatory: consumers append `/{id}` to this base URL.
      GRAPH_API_BASE_URL: http://whaloc:8080/v25.0
      META_APP_SECRET: dev-app-secret         # = WHALOC_APP_SECRET
      META_WEBHOOK_VERIFY_TOKEN: dev-verify-token # = WHALOC_WEBHOOK_VERIFY_TOKEN

  whaloc:
    image: ghcr.io/dgadelha/whaloc:latest
    ports: ["3010:8080"]
    environment:
      # Reachable from whoever downloads media — inside the compose network, not the host.
      WHALOC_PUBLIC_URL: http://whaloc:8080
      WHALOC_WEBHOOK_URL: http://app:3001/meta-webhooks
      WHALOC_APP_SECRET: dev-app-secret
      WHALOC_WEBHOOK_VERIFY_TOKEN: dev-verify-token
```

Three values have to agree across the pair — the app secret, the verify token and the webhook URL — and the fourth, `GRAPH_API_BASE_URL`, has to carry its version segment. Everything else is independent.

---

## 9. Out of scope

**Flows** (WhatsApp Flows) are not emulated, and nothing else in this document is aspirational: everything the sections above describe is implemented.

*(Some of it arrived after the first release — phone number management (`POST /{waba}/phone_numbers`, register/verify, multi-WABA management at runtime: §2 rows 13–17, the ladder in §4, the control-plane list in §5), read receipts and typing indicators (§2 row 18, §4), the business profile and `subscribed_apps` (§2 rows 19–20), the template list filters with the `before` cursor (§2 row 8), error simulation (the strict token registry, the injection rules and the media TTL: §1.9 and §4), identity simulation (BSUIDs and the `user_changed_number` system event: §1.15 and the contact routes in §5), the S3-compatible media backend (`WHALOC_MEDIA_BACKEND`, §6–§7), state export/import (`GET /api/export`, `POST /api/import`, §5), and the batch that closed the remaining Meta gaps — media deletion (§2.6b), the Resumable Upload API and the handles it feeds to templates and business profiles (§2.21–§2.22), `biz_opaque_callback_data` (§2.5), the inbound context riders and the `unsupported` type (§5), and the two account-level webhooks (§3) — which is why those sections read as additions to a smaller core.)*
