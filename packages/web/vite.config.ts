import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The whaloc server the dev server proxies to; in production both are the same origin. */
const serverUrl = process.env["WHALOC_DEV_SERVER_URL"] ?? "http://localhost:8080";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			// Control plane, WebSocket, media bytes and the versioned Graph API mount (SPEC §8).
			"/api": { target: serverUrl, changeOrigin: true, ws: true },
			"/whaloc-media": { target: serverUrl, changeOrigin: true },
			[String.raw`^/v\d+\.\d+/`]: { target: serverUrl, changeOrigin: true },
		},
	},
});
