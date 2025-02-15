// @ts-check
import eslint from "@eslint/js";
import eslintPluginAstro from "eslint-plugin-astro";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptEslint = tseslint.plugin;
const tsParser = tseslint.parser;

export default tseslint.config(
	{
		ignores: [
			"**/node_modules",
			"**/dist",
			"dist/**/*",
			"**/node_modules",
			"**/target",
			"**/.astro",
			"**/.github",
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.recommendedTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: ["./tsconfig.json"],
				tsconfigRootDir: ".",
			},
		},
		plugins: {
			"@typescript-eslint": typescriptEslint,
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
			"@typescript-eslint/consistent-type-definitions": ["error", "type"],
		},
	},

	...eslintPluginAstro.configs.recommended,

	// Disabled because eslint-plugin-astro doesn't type Astro.props correctly in some contexts
	{
		files: ["**/*.astro"],
		rules: {
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			// this is due to returning astro redirect crashing eslint, TO DO: figure this out
			"@typescript-eslint/no-misused-promises": "off",
		},
	},

	// Disable typed rules for scripts inside Astro files
	// https://github.com/ota-meshi/eslint-plugin-astro/issues/240
	{
		files: ["**/*.astro/*.ts"],
		languageOptions: {
			parserOptions: {
				project: null,
			},
		},
		...tseslint.configs.disableTypeChecked,
	},

	{
		files: ["src/env.d.ts"],
		rules: {
			"@typescript-eslint/consistent-type-definitions": ["error", "interface"],
		},
	},

	// Files that run in the browser and need the browser globals
	{
		files: ["src/lib/modules/client/*"],
		languageOptions: {
			globals: {
				...Object.fromEntries(Object.entries(globals.node).map(([key]) => [key, "off"])),
				...globals.browser,
			},
		},
	},
);
