import {
	contactListResponseSchema,
	conversationListResponseSchema,
	importResponseSchema,
	stateResponseSchema,
	webhookDeliveryListResponseSchema,
	type ControlError,
	type WsEvent,
} from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { output, ZodType } from "zod";
import { SNAPSHOT_SCHEMA_VERSION, type StateSnapshot } from "../domain/index.ts";
import { anyString, readJson, stringContaining, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";
import { snapshotFilename } from "./snapshot-routes.ts";

/**
 * State export and import through `app.request()` (SPEC §5).
 *
 * The fixture is the real composed app, so a snapshot is taken from — and loaded back into —
 * an actual database with actual media bytes behind the storage adapter. The round trip is the
 * point: what a colleague receives has to *be* the whaloc it left.
 */
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

describe("state export/import", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp({
			WHALOC_TEMPLATE_AUTO_APPROVE: "off",
			WHALOC_STATUS_DELAYS: "sent:0,delivered:800",
		});
	});

	afterEach(async () => {
		await fixture.close();
	});

	async function parseBody<TSchema extends ZodType>(schema: TSchema, response: Response): Promise<output<TSchema>> {
		const body: unknown = await response.json();

		return schema.parse(body);
	}

	async function get<TSchema extends ZodType>(schema: TSchema, path: string): Promise<output<TSchema>> {
		return parseBody(schema, await fixture.app.request(path));
	}

	async function settle(): Promise<void> {
		await fixture.services.domain.tasks.whenIdle();
	}

	async function exportSnapshot(query = ""): Promise<StateSnapshot> {
		const response = await fixture.app.request(`/api/export${query}`);

		expect(response.status).toBe(200);

		return readJson<StateSnapshot>(response);
	}

	/** Posts a snapshot as a JSON body, the way a script would. */
	async function importSnapshot(snapshot: unknown): Promise<Response> {
		return fixture.app.request("/api/import", {
			method: "POST",
			body: JSON.stringify(snapshot),
			headers: { "content-type": "application/json" },
		});
	}

	async function simulateInbound(body = "Hello"): Promise<void> {
		await fixture.app.request("/api/inbound", {
			method: "POST",
			body: JSON.stringify({
				phoneNumberId: fixture.phoneNumberId,
				from: "16505551234",
				type: "text",
				text: { body },
			}),
			headers: { "content-type": "application/json" },
		});
		await settle();
	}

	/** Uploads an image and answers with its media id. */
	async function uploadMedia(): Promise<string> {
		const form = new FormData();

		form.set("phoneNumberId", fixture.phoneNumberId);
		form.set("file", new File([IMAGE_BYTES], "photo.png", { type: "image/png" }));

		const response = await fixture.app.request("/api/inbound-media", { method: "POST", body: form });
		const body = await readJson<{ data: { id: string } }>(response);

		return body.data.id;
	}

	describe("GET /api/export", () => {
		it("serves the whole state as one downloadable file", async () => {
			const response = await fixture.app.request("/api/export");
			const snapshot = await readJson<StateSnapshot>(response);

			expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
			expect(response.headers.get("content-disposition")).toBe(
				`attachment; filename="${snapshotFilename(snapshot.exportedAt)}"`,
			);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(snapshot).toMatchObject({
				schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				whalocVersion: stringMatching(/^\d+\.\d+\.\d+$/),
				exportedAt: stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			});
			expect(snapshot.tables.wabas).toEqual([
				{ id: fixture.wabaId, name: "whaloc Test Business", subscribed_at: null, created_at: anyString() },
			]);
			expect(snapshot.tables.phone_numbers[0]).toMatchObject({ id: fixture.phoneNumberId, status: "CONNECTED" });
			expect(snapshot.tables.contacts.map(contact => contact.wa_id)).toEqual(["5571990000001", "5571990000002"]);
			// The seeded template is APPROVED from the first instant (SPEC §7).
			expect(snapshot.tables.templates[0]).toMatchObject({ name: "hello_whaloc", status: "APPROVED" });
		});

		it("names the file after the moment it was taken", () => {
			expect(snapshotFilename("2026-09-01T17:45:12.345Z")).toBe("whaloc-snapshot-20260901T174512Z.json");
		});

		it("leaves the delivery log out unless it is asked for", async () => {
			await simulateInbound();

			const deliveries = await get(webhookDeliveryListResponseSchema, "/api/webhook-deliveries");

			const withoutLog = await exportSnapshot();
			const withLog = await exportSnapshot("?include=deliveries");

			expect(deliveries.data.length).toBeGreaterThan(0);
			expect(withoutLog.tables.webhook_deliveries).toEqual([]);
			expect(withLog.tables.webhook_deliveries).toHaveLength(deliveries.data.length);
		});

		it("inlines each media object's bytes next to its row", async () => {
			await uploadMedia();

			const snapshot = await exportSnapshot();

			expect(snapshot.tables.media).toHaveLength(1);
			expect(snapshot.mediaObjects).toEqual([
				{ storageKey: snapshot.tables.media[0]!.storage_key, bytes: Buffer.from(IMAGE_BYTES).toString("base64") },
			]);
		});

		/** The golden rule (SPEC): two exports of the same state differ only in their timestamp. */
		it("orders every table deterministically", async () => {
			await simulateInbound("one");
			await simulateInbound("two");
			await uploadMedia();

			const first = await exportSnapshot();
			const second = await exportSnapshot();

			expect(JSON.stringify({ ...second, exportedAt: first.exportedAt })).toBe(JSON.stringify(first));
		});

		it("exports a media row whose bytes are gone as an empty object", async () => {
			await uploadMedia();

			const stored = await fixture.services.repositories.media.listAll();

			await fixture.services.mediaStorage.delete(stored[0]!.storageKey);

			const snapshot = await exportSnapshot();

			expect(snapshot.tables.media).toHaveLength(1);
			expect(snapshot.mediaObjects[0]!.bytes).toBeNull();
		});
	});

	describe("POST /api/import", () => {
		/**
		 * A state that is deliberately *not* the seed: the seeded WABA is gone and another one
		 * has taken its place, so an import that re-applied `WHALOC_SEED` would be obvious.
		 */
		async function captureNonSeededSnapshot(): Promise<{ snapshot: StateSnapshot; wabaId: string }> {
			await simulateInbound("before the export");

			const created = await fixture.app.request("/api/wabas", {
				method: "POST",
				body: JSON.stringify({ name: "Imported Business" }),
				headers: { "content-type": "application/json" },
			});
			const { data: waba } = await readJson<{ data: { id: string } }>(created);

			await fixture.app.request(`/api/wabas/${fixture.wabaId}`, { method: "DELETE" });

			return { snapshot: await exportSnapshot(), wabaId: waba.id };
		}

		it("replaces every piece of state, and does not re-apply the seed", async () => {
			const { snapshot, wabaId } = await captureNonSeededSnapshot();

			// Back to the seed, so the import has something different to overwrite.
			await fixture.app.request("/api/reset", { method: "POST" });

			const seeded = await get(stateResponseSchema, "/api/state");

			expect(seeded.wabas[0]!.id).toBe(fixture.wabaId);

			const response = await importSnapshot(snapshot);

			expect(response.status).toBe(200);

			const { data } = await parseBody(importResponseSchema, response);

			expect(data.state.wabas).toHaveLength(1);
			expect(data.state.wabas[0]).toMatchObject({ id: wabaId, name: "Imported Business" });

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas.map(candidate => candidate.id)).toEqual([wabaId]);
		});

		it("reports what it loaded", async () => {
			await simulateInbound();
			await uploadMedia();

			const snapshot = await exportSnapshot("?include=deliveries");
			const { data } = await parseBody(importResponseSchema, await importSnapshot(snapshot));

			expect(data.summary).toMatchObject({
				schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				exportedAt: snapshot.exportedAt,
				counts: {
					wabas: 1,
					phoneNumbers: 1,
					contacts: 3,
					templates: 1,
					messages: 1,
					media: 1,
					webhookDeliveries: snapshot.tables.webhook_deliveries.length,
					injectionRules: 0,
					expiredTokens: 0,
				},
				mediaObjects: { restored: 1, missing: 0, bytes: IMAGE_BYTES.byteLength },
			});
		});

		it("takes a multipart upload, the way the UI's file picker sends it", async () => {
			await simulateInbound("in the snapshot");

			const snapshot = await exportSnapshot();

			await fixture.app.request("/api/reset", { method: "POST" });

			const form = new FormData();

			form.set("file", new File([JSON.stringify(snapshot)], "whaloc-snapshot.json", { type: "application/json" }));

			const response = await fixture.app.request("/api/import", { method: "POST", body: form });

			expect(response.status).toBe(200);

			const conversations = await get(conversationListResponseSchema, "/api/conversations");

			expect(conversations.data[0]).toMatchObject({ messageCount: 1 });
		});

		it("refuses a body that claims to be multipart and is not", async () => {
			const response = await fixture.app.request("/api/import", {
				method: "POST",
				body: "not a multipart body at all",
				headers: { "content-type": "multipart/form-data; boundary=nope" },
			});
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(400);
			expect(body.error.code).toBe("invalid_upload");
		});

		it("refuses a multipart body with no file part", async () => {
			const form = new FormData();

			form.set("snapshot", "oops");

			const response = await fixture.app.request("/api/import", { method: "POST", body: form });

			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(400);
			expect(body.error.code).toBe("invalid_upload");
		});

		it("refuses a snapshot written by a newer whaloc, without touching anything", async () => {
			const snapshot = await exportSnapshot();
			const response = await importSnapshot({ ...snapshot, schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 });

			expect(response.status).toBe(400);
			expect(await readJson<ControlError>(response)).toEqual({
				error: { message: stringContaining("written by a newer whaloc"), code: "snapshot_too_new" },
			});

			const contacts = await get(contactListResponseSchema, "/api/contacts");

			expect(contacts.data).toHaveLength(2);
		});

		it.each([
			["an empty object", {}],
			["a JSON array", []],
			[
				"a snapshot with no tables",
				{ schemaVersion: 1, whalocVersion: "0.0.0", exportedAt: "2026-09-01T00:00:00.000Z" },
			],
		])("refuses %s", async (_name, candidate) => {
			const response = await importSnapshot(candidate);
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(400);
			expect(body.error.code).toBe("invalid_snapshot");
		});

		it("refuses a row whose column would not survive the trip, naming it", async () => {
			const snapshot = await exportSnapshot();
			const broken = {
				...snapshot,
				tables: {
					...snapshot.tables,
					phone_numbers: [{ ...snapshot.tables.phone_numbers[0]!, status: "SLEEPING" }],
				},
			};

			const response = await importSnapshot(broken);
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(400);
			expect(body.error.message).toContain("tables.phone_numbers.0.status");

			// Nothing was deleted: validation happens before any row is touched.
			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas[0]!.phoneNumbers).toHaveLength(1);
		});

		it("restores the media bytes through the storage backend, Range reads included", async () => {
			const mediaId = await uploadMedia();
			const snapshot = await exportSnapshot();

			// A reset deletes the bytes as well as the rows, so this proves the import wrote them.
			await fixture.app.request("/api/reset", { method: "POST" });

			const wiped = await fixture.services.repositories.media.listAll();
			const imported = await importSnapshot(snapshot);

			expect(wiped).toEqual([]);
			expect(imported.status).toBe(200);

			const descriptor = await fixture.app.request(`/v25.0/${mediaId}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});
			const { url, sha256 } = await readJson<{ url: string; sha256: string }>(descriptor);
			const byteUrl = new URL(url);
			const whole = await fixture.app.request(byteUrl.pathname);
			const ranged = await fixture.app.request(byteUrl.pathname, { headers: { range: "bytes=8-11" } });

			expect(descriptor.status).toBe(200);
			expect(sha256).toBe(snapshot.tables.media[0]!.sha256);
			expect(new Uint8Array(await whole.arrayBuffer())).toEqual(IMAGE_BYTES);
			expect(ranged.status).toBe(206);
			expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(IMAGE_BYTES.slice(8, 12));
		});

		/** The stale-object cleanup must not delete the keys the snapshot is bringing back. */
		it("is idempotent: importing the same snapshot twice keeps the media", async () => {
			await uploadMedia();

			const snapshot = await exportSnapshot();

			const first = await importSnapshot(snapshot);
			const second = await importSnapshot(snapshot);

			expect(first.status).toBe(200);
			expect(second.status).toBe(200);

			const again = await exportSnapshot();

			expect(again.mediaObjects[0]!.bytes).toBe(Buffer.from(IMAGE_BYTES).toString("base64"));
		});

		it("counts a media row whose bytes never made it into the file", async () => {
			await uploadMedia();

			const stored = await fixture.services.repositories.media.listAll();

			await fixture.services.mediaStorage.delete(stored[0]!.storageKey);

			const snapshot = await exportSnapshot();
			const { data } = await parseBody(importResponseSchema, await importSnapshot(snapshot));

			expect(data.summary.mediaObjects).toEqual({ restored: 0, missing: 1, bytes: 0 });
		});

		it("cancels the ladders that were still running", async () => {
			const snapshot = await exportSnapshot();

			await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ messaging_product: "whatsapp", to: "16505551234", type: "text", text: { body: "Hi" } }),
			});
			await settle();

			expect(fixture.services.domain.statusLadder.pendingCount).toBe(1);

			await importSnapshot(snapshot);

			expect(fixture.services.domain.statusLadder.pendingCount).toBe(0);
		});

		it("publishes state.imported so a connected UI reloads", async () => {
			const events: WsEvent[] = [];
			const unsubscribe = fixture.services.domain.events.subscribe(event => {
				events.push(event);
			});
			const snapshot = await exportSnapshot();

			await importSnapshot(snapshot);
			unsubscribe();

			const imported = events.at(-1);

			expect(imported?.type).toBe("state.imported");
			expect(imported?.type === "state.imported" && imported.payload.state.wabas[0]?.id).toBe(fixture.wabaId);
		});

		it("carries the state a snapshot describes, down to the columns the API cannot set", async () => {
			// A pending verification code and a webhook subscription: two things only the Graph
			// surface produces, and neither is seedable (SPEC §2.19-§2.20, §4).
			await fixture.app.request(`/v25.0/${fixture.wabaId}/subscribed_apps`, {
				method: "POST",
				headers: TEST_AUTH_HEADERS,
			});
			await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/request_code`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ code_method: "SMS", language: "en_US" }),
			});

			const before = await get(stateResponseSchema, "/api/state");
			const snapshot = await exportSnapshot();

			await fixture.app.request("/api/reset", { method: "POST" });
			await importSnapshot(snapshot);

			const after = await get(stateResponseSchema, "/api/state");

			expect(after.wabas[0]!.subscribedAt).toBe(before.wabas[0]!.subscribedAt);
			expect(after.wabas[0]!.phoneNumbers[0]!.pendingVerification).toEqual(
				before.wabas[0]!.phoneNumbers[0]!.pendingVerification,
			);
			expect(after.wabas[0]!.phoneNumbers[0]!.pendingVerification).not.toBeNull();
		});
	});
});
