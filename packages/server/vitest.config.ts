import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.spec.ts"],
		// `node:sqlite` is still flagged experimental on Node 24 and warns on first use; the
		// dev script silences it the same way.
		execArgv: ["--disable-warning=ExperimentalWarning"],
	},
});
