import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs with `globals: false`, so Testing Library's automatic cleanup is not installed.
afterEach(() => {
	cleanup();
});
