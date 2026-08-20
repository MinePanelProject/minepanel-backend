import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingSafetyComment" };

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "const values = [1, 2] as const;",
      "const value = <const>{ id: 'one' };",
      "// SAFETY: The parser established the UserId invariant.\nconst id = value as UserId;",
      "function parse(): UserId {\n// SAFETY: Validation above established the UserId invariant.\nreturn value as UserId;\n}",
      "const id = /* SAFETY: Validation established the invariant. */ value as UserId;",
      `// SAFETY: The JSON parser contract establishes the validated claim shape.
const isClaim = (value: unknown): value is { id: string } => {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { id?: unknown }).id === 'string';
}`,
    ],
    invalid: [
      { code: "const id = value as UserId;", errors: [error] },
      { code: "const id = <UserId>value;", errors: [error] },
      { code: "const id = value as UserId; // SAFETY: Too late.", errors: [error] },
      {
        code: "// This cast seems fine.\nconst id = value as UserId;",
        errors: [error],
      },
      {
        code: "// SAFETY: This is safe.\nconst id = value as UserId;",
        errors: [error],
      },
    ],
  },
);
