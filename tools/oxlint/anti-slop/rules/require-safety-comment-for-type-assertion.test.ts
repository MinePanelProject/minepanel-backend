import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingSafetyComment" };

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      // const assertions never need a SAFETY comment.
      "const values = [1, 2] as const;",
      "const value = <const>{ id: 'one' };",
      // A substantive, directly adjacent SAFETY comment is accepted.
      "// SAFETY: The JSON parser verified the decoded claim shape before this narrowing.\nconst id = value as UserId;",
      "function parse(): UserId {\n  // SAFETY: Validation above established the UserId invariant.\n  return value as UserId;\n}",
      "const id = /* SAFETY: The parser validated this claim before the narrowing. */ value as UserId;",
      // A substantive comment directly adjacent to a type-predicate cast is accepted.
      `const isClaim = (value: unknown): value is { id: string } => {
  if (typeof value !== 'object' || value === null) return false;
  // SAFETY: The object and prototype checks above established the claim-shape invariant.
  return typeof (value as { id?: unknown }).id === 'string';
}`,
    ],
    invalid: [
      // No comment at all.
      { code: "const id = value as UserId;", errors: [error] },
      { code: "const id = <UserId>value;", errors: [error] },
      // Trailing comments cannot justify an assertion.
      { code: "const id = value as UserId; // SAFETY: Too late.", errors: [error] },
      // A non-SAFETY comment is not evidence.
      { code: "// This cast seems fine.\nconst id = value as UserId;", errors: [error] },
      // Vacuous / trivial placeholders are rejected mechanically (too few tokens).
      { code: "// SAFETY: This is safe.\nconst id = value as UserId;", errors: [error] },
      { code: "// SAFETY: required.\nconst id = value as UserId;", errors: [error] },
      // The listed adversarial phrases carry no concrete evidence and are too short.
      { code: "// SAFETY: framework contract.\nconst id = value as UserId;", errors: [error] },
      { code: "// SAFETY: parser invariant.\nconst id = value as UserId;", errors: [error] },
      { code: "// SAFETY: runtime shape.\nconst id = value as UserId;", errors: [error] },
      { code: "// SAFETY: library boundary.\nconst id = value as UserId;", errors: [error] },
      // A obviously repeated-word filler must not pass the token-count heuristic.
      { code: "// SAFETY: safe safe safe safe safe\nconst id = value as UserId;", errors: [error] },
      // A comment too far away (blank line between it and the assertion) is not adjacent.
      {
        code: "// SAFETY: The JSON parser validated the decoded claim shape in detail before this narrowing.\n\nconst id = value as UserId;",
        errors: [error],
      },
      // A comment attached to a previous unrelated assertion cannot justify this one.
      {
        code: "// SAFETY: The JSON parser validated the Alpha claim before the narrowing.\nconst prev = a as Alpha;\nconst id = b as UserId;",
        errors: [error],
      },
      // Multiple assertions on one statement must each be justified: a single
      // ambiguous comment must not silently cover two casts.
      {
        code: "// SAFETY: The parser validated both claim shapes before narrowing.\nconst id1 = a as Alpha, id2 = b as UserId;",
        errors: [error, error],
      },
    ],
  },
);
