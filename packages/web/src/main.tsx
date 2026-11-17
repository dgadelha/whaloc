import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { App } from "./app.tsx";
import { EmbeddedSignupPage } from "./features/embedded-signup/embedded-signup-page.tsx";
import { StoreProvider } from "./store/store.tsx";
import "./styles/index.css";

const container = document.querySelector("#root");

if (!container) {
	throw new Error("index.html is missing its #root element");
}

createRoot(container).render(
	<StrictMode>
		<BrowserRouter>
			<Routes>
				{/* The popup `sdk.js` opens (SPEC §2.24): no store, so no bootstrap or socket. */}
				<Route path="dialog/embedded-signup" element={<EmbeddedSignupPage />} />
				<Route
					path="*"
					element={
						<StoreProvider>
							<App />
						</StoreProvider>
					}
				/>
			</Routes>
		</BrowserRouter>
	</StrictMode>,
);
