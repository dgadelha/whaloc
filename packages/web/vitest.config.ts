import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The UI's tests run in jsdom with the same React transform the app is built with. A config
 * of its own (rather than a `test` block in `vite.config.ts`) keeps the dev-server proxy and
 * the test environment from having to agree on anything.
 */
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		include: ["src/**/*.spec.{ts,tsx}"],
		setupFiles: ["src/test/setup.ts"],
		restoreMocks: true,
	},
});
