import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function isUser(value: unknown): value is User { return typeof value === 'object'; }",
    "const parseUser = (value: unknown): User | null => null;",
    "function parseUser(value: unknown): User | null { return null; }",
    "function decodeUser(value: unknown): User | null { return null; }",
    "function report(cause: unknown): void {}",
  ],
  invalid: [
    { code: "function load(value: unknown): User { return user; }", errors: [error] },
    { code: "const parse = (value: unknown): unknown => value;", errors: [error] },
    { code: "function isUser(value: unknown): boolean { return true; }", errors: [error] },
    { code: "function decode(value: unknown): User | null { return null; }", errors: [error] },
  ],
});
