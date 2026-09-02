import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type DatabaseHandle,
	type Repositories,
} from "../db/index.ts";
import { createMemoryMediaStorage } from "../testing/domain-harness.ts";
import type { OutboundMessageEvents, TemplateLifecycleEvents } from "./domain-events.ts";
import { MessageService } from "./message-service.ts";
import { sendMessageRequestSchema } from "./send-message-request.ts";
import { TemplateService } from "./template-service.ts";
import { UploadService } from "./upload-service.ts";

const WABA_ID = "102290129340398";
const PHONE_NUMBER_ID = "15550000100";

/**
 * The seams the status ladder and the template lifecycle implement (SPEC §4). These tests pin
 * the *contract*: the services announce every state change through them and stay unaware of
 * timers and webhooks, which is what lets a spec swap in a spy.
 */
describe("domain events", () => {
	let handle: DatabaseHandle;
	let repositories: Repositories;
	let messageEvents: OutboundMessageEvents;
	let templateEvents: TemplateLifecycleEvents;
	let uploads: UploadService;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repositories = createRepositories(handle.db);
		uploads = new UploadService({
			repositories,
			storage: createMemoryMediaStorage(),
			publicUrl: "http://localhost:9999",
			appId: "700000000000001",
			maxBytes: 1024,
		});
		await repositories.wabas.insert({ id: WABA_ID, name: "Acme" });
		await repositories.phoneNumbers.insert({
			id: PHONE_NUMBER_ID,
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
		});
		messageEvents = { onOutboundAccepted: vi.fn() };
		templateEvents = {
			onTemplateCreated: vi.fn(),
			onTemplateEdited: vi.fn(),
			onTemplateDeleted: vi.fn(),
		};
	});

	afterEach(async () => {
		await handle.close();
	});

	function createTemplate() {
		const service = new TemplateService({ repositories, events: templateEvents, uploads });

		return service.create(WABA_ID, {
			name: "order_update",
			language: "en_US",
			category: "UTILITY",
			components: [{ type: "BODY", text: "Hi" }],
			parameter_format: "POSITIONAL",
		});
	}

	it("announces an accepted send", async () => {
		const service = new MessageService({ repositories, events: messageEvents });
		const request = sendMessageRequestSchema.parse({
			messaging_product: "whatsapp",
			to: "5511912345678",
			type: "text",
			text: { body: "Hi" },
		});

		const { message } = await service.send(PHONE_NUMBER_ID, request);

		expect(messageEvents.onOutboundAccepted).toHaveBeenCalledExactlyOnceWith(message);
	});

	it("stays quiet when a send is rejected", async () => {
		const service = new MessageService({ repositories, events: messageEvents });
		const request = sendMessageRequestSchema.parse({
			messaging_product: "whatsapp",
			to: "5511912345678",
			type: "template",
			template: { name: "missing", language: { code: "en_US" } },
		});

		await expect(service.send(PHONE_NUMBER_ID, request)).rejects.toThrow();
		expect(messageEvents.onOutboundAccepted).not.toHaveBeenCalled();
	});

	it("announces a created template", async () => {
		const template = await createTemplate();

		expect(templateEvents.onTemplateCreated).toHaveBeenCalledExactlyOnceWith(template);
		expect(template.status).toBe("PENDING");
	});

	it("announces an edit, with the template already back to PENDING", async () => {
		const service = new TemplateService({ repositories, events: templateEvents, uploads });
		const created = await createTemplate();

		await repositories.templates.update(created.id, { status: "APPROVED" });

		const edited = await service.edit(created.id, { components: [{ type: "BODY", text: "Hi again" }] });

		expect(templateEvents.onTemplateEdited).toHaveBeenCalledExactlyOnceWith(edited);
		expect(edited.status).toBe("PENDING");
	});

	it("announces every language a delete removed", async () => {
		const service = new TemplateService({ repositories, events: templateEvents, uploads });
		const english = await createTemplate();

		await service.create(WABA_ID, {
			name: "order_update",
			language: "pt_BR",
			category: "UTILITY",
			components: [{ type: "BODY", text: "Oi" }],
			parameter_format: "POSITIONAL",
		});

		const deleted = await service.delete({ wabaId: WABA_ID, name: "order_update" });

		expect(deleted.map(template => template.language)).toEqual(["en_US", "pt_BR"]);
		expect(templateEvents.onTemplateDeleted).toHaveBeenCalledExactlyOnceWith(deleted);
		expect(deleted[0]?.id).toBe(english.id);
	});

	it("stays quiet when a delete matched nothing", async () => {
		const service = new TemplateService({ repositories, events: templateEvents, uploads });

		await expect(service.delete({ wabaId: WABA_ID, name: "missing" })).rejects.toThrow();
		expect(templateEvents.onTemplateDeleted).not.toHaveBeenCalled();
	});
});
