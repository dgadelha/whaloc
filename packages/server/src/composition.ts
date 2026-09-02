import type { Kysely } from "kysely";
import type { AppConfig } from "./config/index.ts";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type Database,
	type DatabaseHandle,
	type Repositories,
} from "./db/index.ts";
import {
	AccountEventService,
	applySeed,
	BusinessProfileService,
	combineOutboundMessageEvents,
	ContactService,
	ConversationService,
	createBackgroundTasks,
	createEventBus,
	InboundService,
	InjectionService,
	MediaService,
	MessageService,
	ObjectService,
	PhoneNumberService,
	ReadReceiptService,
	ResetService,
	SnapshotService,
	StateService,
	StatusLadder,
	SubscribedAppService,
	TemplateLifecycle,
	TemplateService,
	TokenRegistry,
	TypingService,
	UploadService,
	WabaService,
	WebhookEmitter,
	type BackgroundTasks,
	type EventBus,
	type Scheduler,
	type SeedResult,
} from "./domain/index.ts";
import type { Logger } from "./logging/index.ts";
import { createMediaStorage, type MediaStorage } from "./storage/index.ts";

export interface CreateServicesOptions {
	config: AppConfig;
	logger: Logger;
	/** Injected by tests that drive time; defaults to real timers inside every service. */
	scheduler?: Scheduler;
}

/** The domain services the two API surfaces are built on (SPEC §8). */
export interface DomainServices {
	/** Graph API mock (SPEC §2). */
	objects: ObjectService;
	messages: MessageService;
	readReceipts: ReadReceiptService;
	media: MediaService;
	/** The Resumable Upload API and the handles it mints (SPEC §2.21). */
	uploads: UploadService;
	templates: TemplateService;
	/** Business profile and `subscribed_apps` (SPEC §2.19-§2.20). */
	businessProfiles: BusinessProfileService;
	subscribedApps: SubscribedAppService;
	/** Webhook engine, status ladder and template review (SPEC §3, §4). */
	webhooks: WebhookEmitter;
	statusLadder: StatusLadder;
	templateLifecycle: TemplateLifecycle;
	/** The account-level webhooks the UI and control plane can emit (SPEC §3). */
	accountEvents: AccountEventService;
	/** Typing indicators: in-memory, announced over the WebSocket (SPEC §2.18). */
	typing: TypingService;
	/** Error simulation (SPEC §4): the injection rules and the bearer-token registry. */
	injection: InjectionService;
	tokens: TokenRegistry;
	/** Control plane (SPEC §5). */
	contacts: ContactService;
	conversations: ConversationService;
	inbound: InboundService;
	phoneNumbers: PhoneNumberService;
	wabas: WabaService;
	state: StateService;
	reset: ResetService;
	/** State export/import: one JSON file that is a whole whaloc (SPEC §5). */
	snapshots: SnapshotService;
	/** The WebSocket hub subscribes here; services only ever publish. */
	events: EventBus;
	/** Webhook deliveries in flight; the specs and the shutdown sequence wait on it. */
	tasks: BackgroundTasks;
}

/** Everything with a lifetime, built once at boot and injected from here on (SPEC §8). */
export interface AppServices {
	db: Kysely<Database>;
	repositories: Repositories;
	mediaStorage: MediaStorage;
	domain: DomainServices;
	seed: SeedResult;
	/** Cancels pending timers and releases the database handle; called by the shutdown sequence. */
	close: () => Promise<void>;
}

function migrationMessage(applied: string[]): string {
	return applied.length === 0 ? "database schema already up to date" : "database migrated";
}

export interface CreateDomainServicesOptions {
	repositories: Repositories;
	mediaStorage: MediaStorage;
	config: AppConfig;
	logger: Logger;
	scheduler?: Scheduler;
}

/**
 * Wires the domain together, in dependency order: the event bus and the background-task
 * tracker first, then the webhook emitter everything announces through, then the two lifecycle
 * services that are also the `OutboundMessageEvents` / `TemplateLifecycleEvents` the Graph
 * services fire (SPEC §4).
 */
export function createDomainServices(options: CreateDomainServicesOptions): DomainServices {
	const { repositories, mediaStorage, config, logger } = options;
	const tasks = createBackgroundTasks(logger);
	const events = createEventBus({
		onListenerError: error => {
			logger.warn({ err: error }, "a websocket listener threw while handling an event");
		},
	});
	const scheduler = options.scheduler;
	const webhooks = new WebhookEmitter({
		repositories,
		logger,
		target: { url: config.webhookUrl, appSecret: config.appSecret, verifyToken: config.webhookVerifyToken },
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const statusLadder = new StatusLadder({
		repositories,
		webhooks,
		tasks,
		logger,
		delays: config.statusDelays,
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const templateLifecycle = new TemplateLifecycle({
		repositories,
		webhooks,
		tasks,
		logger,
		autoApproveMs: config.templateAutoApproveMs,
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const typing = new TypingService({
		events,
		...(scheduler !== undefined && { scheduler }),
	});
	const media = new MediaService({
		repositories,
		storage: mediaStorage,
		publicUrl: config.publicUrl,
		ttlSeconds: config.mediaTtlSeconds,
		...(scheduler !== undefined && { scheduler }),
	});
	const subscribedApps = new SubscribedAppService({
		repositories,
		publicUrl: config.publicUrl,
		events,
		...(config.appId !== undefined && { appId: config.appId }),
		...(scheduler !== undefined && { scheduler }),
	});
	// The Upload API is scoped to the app `subscribed_apps` reports, so it is built after it
	// (SPEC §2.21); the templates and the business profile both resolve handles through it.
	const uploads = new UploadService({
		repositories,
		storage: mediaStorage,
		publicUrl: config.publicUrl,
		appId: subscribedApps.identity.id,
		maxBytes: media.maxBytes,
		...(scheduler !== undefined && { scheduler }),
	});
	// The snapshot names the app `subscribed_apps` reports, so that one comes first.
	const state = new StateService({ repositories, config, webhooks, subscribedApps });
	// The WABA cascade goes through the phone numbers, so this one is built first.
	const phoneNumbers = new PhoneNumberService({
		repositories,
		webhooks,
		tasks,
		mediaStorage,
		logger,
		events,
		...(scheduler !== undefined && { scheduler }),
	});

	return {
		objects: new ObjectService({ repositories }),
		// An accepted send starts the ladder *and* drops the conversation's typing indicator.
		messages: new MessageService({ repositories, events: combineOutboundMessageEvents(statusLadder, typing) }),
		readReceipts: new ReadReceiptService({
			repositories,
			typing,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		media,
		uploads,
		templates: new TemplateService({ repositories, events: templateLifecycle, uploads }),
		businessProfiles: new BusinessProfileService({ repositories, media, uploads, events }),
		subscribedApps,
		webhooks,
		statusLadder,
		templateLifecycle,
		accountEvents: new AccountEventService({
			repositories,
			webhooks,
			...(scheduler !== undefined && { scheduler }),
		}),
		typing,
		injection: new InjectionService({ repositories, events }),
		tokens: new TokenRegistry({
			repositories,
			tokens: config.tokens,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		// A number change emits Meta's `user_changed_number` system webhook (SPEC §5), so this
		// one needs the emitter and the clock like every other announcing service.
		contacts: new ContactService({
			repositories,
			webhooks,
			tasks,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		conversations: new ConversationService({ repositories }),
		inbound: new InboundService({
			repositories,
			webhooks,
			tasks,
			media,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		phoneNumbers,
		wabas: new WabaService({ repositories, phoneNumbers, events }),
		state,
		reset: new ResetService({
			repositories,
			mediaStorage,
			config,
			logger,
			state,
			statusLadder,
			templateLifecycle,
			typing,
			events,
		}),
		// An import replaces everything a reset would wipe, so it cancels the same timers —
		// but it does *not* re-apply the seed: the snapshot is the state (SPEC §5).
		snapshots: new SnapshotService({
			repositories,
			mediaStorage,
			logger,
			state,
			statusLadder,
			templateLifecycle,
			typing,
			events,
			...(scheduler !== undefined && { scheduler }),
		}),
		events,
		tasks,
	};
}

/** Everything after the database is open; extracted so the caller's `try` stays trivial. */
async function buildServices(options: CreateServicesOptions, handle: DatabaseHandle): Promise<AppServices> {
	const { config, logger } = options;
	const { db } = handle;
	const { applied } = await runMigrations({ db });

	logger.info({ dbPath: config.dbPath, applied }, migrationMessage(applied));

	const repositories = createRepositories(db);
	const seed = await applySeed({ repositories, seed: config.seed });

	// The resolved ids — WABAs, phone numbers, contacts and templates — are what a user has to
	// put in `GRAPH_API_BASE_URL` calls, so they are logged in full even when nothing was
	// created (SPEC §7).
	logger.info({ wabas: seed.wabas, created: seed.created }, "seed applied");

	// A directory or an S3 bucket, decided by `WHALOC_MEDIA_BACKEND` (SPEC §6); everything
	// downstream only ever sees the interface.
	const mediaStorage = createMediaStorage({ config });

	logger.info({ backend: config.mediaBackend }, "media storage ready");
	const domain = createDomainServices({
		repositories,
		mediaStorage,
		config,
		logger,
		...(options.scheduler !== undefined && { scheduler: options.scheduler }),
	});

	return {
		db,
		repositories,
		mediaStorage,
		domain,
		seed,
		close: async () => {
			// Timers are in-process and are dropped on shutdown (SPEC §4); deliveries already
			// in flight get a chance to finish so the log is not left mid-attempt.
			domain.statusLadder.cancelAll();
			domain.templateLifecycle.cancelAll();
			domain.typing.clearAll();
			await domain.tasks.whenIdle();
			await handle.close();
			// An S3 client's keep-alive sockets would otherwise hold the process open until the
			// shutdown timeout gives up on them (SPEC §6).
			await mediaStorage.close?.();
		},
	};
}

/**
 * The boot sequence's middle step: open the database, migrate it, seed it, and hand back the
 * repositories, the media storage and the domain services the rest of the server is built on.
 * Keeping it here means `main.ts` stays a script and `app.ts` stays about HTTP.
 */
export async function createServices(options: CreateServicesOptions): Promise<AppServices> {
	const handle = createDatabase({ dbPath: options.config.dbPath });

	try {
		return await buildServices(options, handle);
	} catch (error) {
		await handle.close();

		throw error;
	}
}
