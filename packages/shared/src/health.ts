import { z } from "zod";

/**
 * Body returned by `GET /api/health` (and its root alias `GET /health`, used by the
 * Docker `HEALTHCHECK`). See SPEC §5.
 */
export const healthResponseSchema = z.object({
	status: z.literal("ok"),
	uptimeSeconds: z.number().int().nonnegative(),
	timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
