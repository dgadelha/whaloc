import { serve, type ServerType } from "@hono/node-server";
import { wsEventSchema, type WsEvent } from "@whaloc/shared";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { readJson } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The control-plane WebSocket end to end (SPEC §5): a real server on an ephemeral port, a real
 * browser-style `WebSocket` client (Node 24 ships one), and the events a UI would react to.
 *
 * `app.request()` cannot exercise this — the upgrade is handled by the Node adapter, not by
 * the Hono app — so this is the one spec that listens on a socket.
 */
describe("GET /api/ws", () => {
	let fixture: TestApp;
	let server: ServerType;
	let webSocketServer: WebSocketServer;
	let baseUrl: string;
	const clients: WebSocket[] = [];

	beforeEach(async () => {
		fixture = await createTestApp();
		webSocketServer = new WebSocketServer({ noServer: true });
		server = await new Promise<ServerType>(resolve => {
			const created = serve(
				{ fetch: fixture.app.fetch, hostname: "127.0.0.1", port: 0, websocket: { server: webSocketServer } },
				() => {
					resolve(created);
				},
			);
		});
		baseUrl = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.close();
		}

		webSocketServer.close();
		await new Promise<void>(resolve => {
			server.close(() => {
				resolve();
			});
		});
		await fixture.close();
	});

	/** Connects a client and hands back the events it receives, in order. */
	async function connect(): Promise<WsEvent[]> {
		const received: WsEvent[] = [];
		const client = new WebSocket(`ws://${baseUrl}/api/ws`);

		clients.push(client);
		client.addEventListener("message", event => {
			const frame: unknown = JSON.parse(String(event.data));

			received.push(wsEventSchema.parse(frame));
		});

		await new Promise<void>((resolve, reject) => {
			client.addEventListener("open", () => {
				resolve();
			});
			client.addEventListener("error", () => {
				reject(new Error("the websocket connection failed"));
			});
		});

		return received;
	}

	/** Waits for the client to have received `count` events (or gives up). */
	async function waitFor(received: WsEvent[], count: number): Promise<void> {
		await expect.poll(() => received.length, { timeout: 2000 }).toBeGreaterThanOrEqual(count);
	}

	async function simulateInbound(body: string): Promise<Response> {
		return fixture.app.request("/api/inbound", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				phoneNumberId: fixture.phoneNumberId,
				from: "16505551234",
				type: "text",
				text: { body },
			}),
		});
	}

	it("pushes message.created to a connected client", async () => {
		const received = await connect();

		await simulateInbound("Does it come in blue?");
		// The contact is new, so it is announced too, and the (skipped) webhook delivery is
		// logged and announced right after.
		await waitFor(received, 3);

		expect(received.map(event => event.type)).toEqual(["contact.changed", "message.created", "webhook.delivery"]);
		expect(received[1]).toMatchObject({
			payload: { message: { direction: "inbound", payload: { text: { body: "Does it come in blue?" } } } },
		});
	});

	it("fans the same event out to every client", async () => {
		const first = await connect();
		const second = await connect();

		await simulateInbound("Hi");
		await waitFor(first, 2);
		await waitFor(second, 2);

		expect(first[1]).toEqual(second[1]);
		expect(first[1]!.type).toBe("message.created");
	});

	it("stops writing to a client that disconnected, and keeps serving the others", async () => {
		const staying = await connect();
		const leaving = await connect();
		const [, leavingClient] = clients;

		leavingClient!.close();
		await expect.poll(() => leavingClient!.readyState, { timeout: 2000 }).toBe(WebSocket.CLOSED);

		await simulateInbound("still here");
		await waitFor(staying, 1);

		expect(leaving).toHaveLength(0);
		expect(staying.some(event => event.type === "message.created")).toBe(true);
	});

	/**
	 * A read receipt with a typing indicator is two frames: the inbound message moving to
	 * `read`, and the indicator going up (SPEC §2.18). Neither has a webhook behind it.
	 */
	it("pushes message.status_changed and typing.changed for a read receipt", async () => {
		const inbound = await simulateInbound("Anyone there?");
		const received = await readJson<{ data: { id: string } }>(inbound);
		const events = await connect();

		await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				messaging_product: "whatsapp",
				status: "read",
				message_id: received.data.id,
				typing_indicator: { type: "text" },
			}),
		});
		await waitFor(events, 2);

		expect(events.map(event => event.type)).toEqual(["message.status_changed", "typing.changed"]);
		expect(events[0]).toMatchObject({ payload: { message: { status: "read" }, previousStatus: "delivered" } });
		expect(events[1]).toMatchObject({
			payload: { typing: { phoneNumberId: fixture.phoneNumberId, contactWaId: "16505551234" } },
		});
	});

	it("pushes state.reset when the control plane wipes everything", async () => {
		const received = await connect();

		await fixture.app.request("/api/reset", { method: "POST" });
		await waitFor(received, 1);

		expect(received.at(-1)!.type).toBe("state.reset");
	});
});
