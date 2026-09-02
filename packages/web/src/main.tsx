import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app.tsx";
import { StoreProvider } from "./store/store.tsx";
import "./styles/index.css";

const container = document.querySelector("#root");

if (!container) {
	throw new Error("index.html is missing its #root element");
}

createRoot(container).render(
	<StrictMode>
		<BrowserRouter>
			<StoreProvider>
				<App />
			</StoreProvider>
		</BrowserRouter>
	</StrictMode>,
);
