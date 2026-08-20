import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
	valid: [
		{
			filename: "scripts/check-package-scripts.mjs",
			code: 'if (typeof scripts[name] !== "string") missing.push(name);',
		},
		"const value = input;",
		{
			code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
			options: allowInTypeGuards,
		},
		{
			code: 'const isString = (value: unknown): value is string => typeof value === "string";',
			options: allowInTypeGuards,
		},
		{
			code: 'function assertString(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error(); }',
			options: allowInTypeGuards,
		},
		{
			code: 'function parseToken(value: unknown): string | null { if (typeof value !== "string") return null; return value; }',
		},
		{
			code: 'const decodeToken = (value: unknown): { token: string } | null => { if (typeof value !== "object" || value === null) return null; return null; };',
		},
	],
	invalid: [
		{ code: 'if (typeof input === "string") use(input);', errors: [error] },
		{
			code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
			errors: [error],
		},
		{
			code: 'function parse(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }',
			options: allowInTypeGuards,
			errors: [error],
		},
		{
			code: 'function parseUnknown(value: unknown): unknown { return typeof value === "string" ? value : undefined; }',
			errors: [error],
		},
		{
			code: 'function parseItems(value: unknown): unknown[] { if (typeof value !== "object" || value === null || !Array.isArray(value)) throw new Error(); return value; }',
			errors: [error],
		},
		{
			code: 'function decodeRecord(value: unknown): { value: unknown } { if (typeof value !== "object" || value === null) throw new Error(); return value as { value: unknown }; }',
			errors: [error],
		},
		{
			code: 'function isString(value: unknown): value is string { const check = () => typeof value === "string"; return check(); }',
			options: allowInTypeGuards,
			errors: [error],
		},
	],
});
