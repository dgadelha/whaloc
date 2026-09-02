import eslint from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import prettier from "eslint-plugin-prettier/recommended";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const gitIgnorePath = fileURLToPath(new URL(".gitignore", import.meta.url));

export default defineConfig(
	{
		ignores: ["eslint.config.mjs", "**/dist/**"],
	},
	includeIgnoreFile(gitIgnorePath, "Imported .gitignore patterns"),
	eslint.configs.recommended,
	tseslint.configs.strictTypeChecked,
	eslintPluginUnicorn.configs.all,
	prettier,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		rules: {
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					"args": "all",
					"argsIgnorePattern": "^_",
					"caughtErrors": "all",
					"caughtErrorsIgnorePattern": "^_",
					"destructuredArrayIgnorePattern": "^_",
					"varsIgnorePattern": "^_",
					"ignoreRestSiblings": true,
				},
			],
			"unicorn/consistent-function-scoping": ["error", { checkArrowFunctions: false }],
			"unicorn/filename-case": ["error", { "case": "kebabCase" }],
			"unicorn/no-abusive-eslint-disable": "off",
			// A folder that exposes a module (config/, logging/, …) re-exports it from an index.
			"unicorn/no-barrel-files": "off",
			"unicorn/no-null": "off",
			// Single-line JSDoc (`/** … */`) is the TypeScript convention and what Prettier formats to.
			"unicorn/no-asterisk-prefix-in-documentation-comments": "off",
			"unicorn/single-line-block-comment-style": "off",
			// `Env`, `id`, `db`, … are the names Hono, Meta and Kysely use themselves.
			"unicorn/name-replacements": "off",
			// Temporal is not available on Node 24.
			"unicorn/prefer-temporal": "off",
			// Neither are `Uint8Array#toBase64` and `Uint8Array.fromBase64`.
			"unicorn/prefer-uint8array-base64": "off",
			"unicorn/prevent-abbreviations": "off",
		},
	},
	{
		// The entrypoint and the shutdown handler are the only places allowed to end the process:
		// a bad configuration or a stuck connection must surface as a non-zero exit code.
		files: ["packages/server/src/main.ts", "packages/server/src/graceful-shutdown.ts"],
		rules: {
			"unicorn/no-process-exit": "off",
		},
	},
	{
		// JSX has two idioms these rules were not written for: a list is rendered with
		// `items.map(item => (<li … />))`, and React's own prop is called `className`.
		files: ["packages/web/**/*.tsx"],
		rules: {
			"unicorn/consistent-arrow-return-style": "off",
			"unicorn/no-keyword-prefix": "off",
		},
	},
	{
		// Test SUT factories (e.g. `makeSut`) live inside their `describe` block by
		// convention; they capture only module-scope fixtures, which this rule would
		// otherwise force out to module scope.
		files: ["**/*.spec.ts", "**/*.spec.tsx"],
		rules: {
			"unicorn/consistent-function-scoping": "off",
		},
	},
);
