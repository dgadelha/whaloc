import { importResponseSchema } from "@whaloc/shared";
import { Hono, type Context } from "hono";
import { ControlPlaneError, type SnapshotService, type StateSnapshot } from "../domain/index.ts";
import { readJsonBody, type ControlEnv } from "./control-env.ts";

export interface SnapshotRoutesOptions {
	snapshots: SnapshotService;
}

/** `whaloc-snapshot-20260901T174500Z.json` — sortable, and obvious in a downloads folder. */
export function snapshotFilename(exportedAt: string): string {
	return `whaloc-snapshot-${exportedAt.replaceAll(/[.:-]/g, "").replace(/\d{3}Z$/, "Z")}.json`;
}

/** The multipart part an uploaded snapshot arrives in, from the UI's file picker. */
const FILE_PART = "file";

/** A body that says `multipart/form-data` and is not one is the caller's mistake, not a 500. */
async function readForm(c: Context<ControlEnv>): Promise<FormData> {
	try {
		return await c.req.formData();
	} catch (error) {
		throw new ControlPlaneError("expected a multipart/form-data body", {
			status: 400,
			code: "invalid_upload",
			cause: error,
		});
	}
}

function readUploadedSnapshot(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new ControlPlaneError("the uploaded file is not JSON", {
			status: 400,
			code: "invalid_snapshot",
			cause: error,
		});
	}
}

/**
 * `GET /api/export` and `POST /api/import` (SPEC §5): a whaloc's whole state as one file.
 *
 * The export is served as an **attachment** — it is meant to be saved and passed around, not
 * read in a browser tab — and the import takes either a JSON body (scripts, `curl`) or a
 * `multipart/form-data` upload (the UI's file picker), because both callers are first-class.
 */
export function createSnapshotRoutes(options: SnapshotRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/export", async c => {
		// `?include=deliveries` opts the delivery log in; it is traffic rather than state, and
		// by far the biggest table.
		const snapshot: StateSnapshot = await options.snapshots.exportState({
			includeDeliveries: c.req.query("include") === "deliveries",
		});

		return c.body(JSON.stringify(snapshot), 200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="${snapshotFilename(snapshot.exportedAt)}"`,
			// A snapshot is a point in time; nothing about it should be reused from a cache.
			"Cache-Control": "no-store",
		});
	});

	routes.post("/import", async c => {
		const contentType = c.req.header("content-type") ?? "";
		let candidate: unknown;

		if (contentType.includes("multipart/form-data")) {
			const form = await readForm(c);
			const file = form.get(FILE_PART);

			if (!(file instanceof File)) {
				throw new ControlPlaneError(`the ${FILE_PART} part is required`, { status: 400, code: "invalid_upload" });
			}

			candidate = readUploadedSnapshot(await file.text());
		} else {
			candidate = await readJsonBody(c);
		}

		const { summary, state } = await options.snapshots.importState(candidate);

		return c.json(importResponseSchema.parse({ data: { summary, state } }));
	});

	return routes;
}
