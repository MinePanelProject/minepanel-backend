import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

// The nearest enclosing statement whose leading comment would reasonably
// justify an assertion. We never look past these, so a comment attached to an
// unrelated outer statement cannot bless a nested assertion.
const ownerKinds: Record<string, boolean> = {
  ExpressionStatement: true,
  VariableDeclaration: true,
  PropertyDefinition: true,
  ReturnStatement: true,
  ThrowStatement: true,
};

const MIN_TOKENS = 4;
const MIN_DISTINCT_TOKENS = 2;

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function findOwner(node: ESTree.Node, program: ESTree.Node): ESTree.Node | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current !== program) {
    if (ownerKinds[current.type] === true) return current;
    current = current.parent;
  }
  return null;
}

// Mechanical, non-semantic content check. A linter cannot judge whether a
// comment's prose is true, so we only reject comments that are trivially empty
// or vacuous (too few tokens). We do not evaluate what the comment says.
function isSubstantive(commentText: string): boolean {
  const explanation = commentText.replace(/\bSAFETY\s*:/iu, "").trim();
  if (explanation.length === 0) return false;
  const tokens = explanation.split(/\s+/u).filter((token) => token.length > 0);
  const distinct = new Set(tokens.map((token) => token.toLowerCase()));
  return tokens.length >= MIN_TOKENS && distinct.size >= MIN_DISTINCT_TOKENS;
}

// The contiguous block of leading comments immediately above an anchor. A
// multi-line `// SAFETY: …` comment forms one block even though the marker only
// appears on its first line. Returns only when the block is adjacent to the
// anchor (its last comment ends on the same or immediately preceding line) and
// contains a SAFETY marker.
function leadingSafetyBlock(sourceCode: SourceCode, anchor: ESTree.Node): string | null {
  const comments = sourceCode.getCommentsBefore(anchor);
  if (comments.length === 0) return null;
  const anchorLine = sourceCode.getLocFromIndex(anchor.start).line;
  const last = comments[comments.length - 1];
  if (last.start > anchor.start) return null;
  const lastEndLine = sourceCode.getLocFromIndex(last.end).line;
  if (lastEndLine !== anchorLine && lastEndLine !== anchorLine - 1) return null;

  let index = comments.length - 1;
  const texts = [comments[index].value];
  while (index > 0) {
    const previous = comments[index - 1];
    const previousEndLine = sourceCode.getLocFromIndex(previous.end).line;
    const currentStartLine = sourceCode.getLocFromIndex(comments[index].start).line;
    if (previousEndLine > currentStartLine - 1) break;
    if (previousEndLine !== currentStartLine - 1) break;
    texts.unshift(previous.value);
    index -= 1;
  }
  const block = texts.join(" ");
  return /\bSAFETY\s*:/iu.test(block) ? block : null;
}

function countAssertions(node: ESTree.Node): number {
  const own = node.type === "TSAsExpression" || node.type === "TSTypeAssertion" ? 1 : 0;
  let children = 0;
  for (const key of Object.keys(node) as string[]) {
    if (key === "parent") continue;
    const value: unknown = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child !== null && typeof child === "object" && typeof (child as ESTree.Node).type === "string") {
          children += countAssertions(child as ESTree.Node);
        }
      }
    } else if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as ESTree.Node).type === "string"
    ) {
      children += countAssertions(value as ESTree.Node);
    }
  }
  return own + children;
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion, program: ESTree.Node): boolean {
  const owner = findOwner(node, program);
  if (owner === null) return false;

  // A single comment must not silently justify several assertions in one
  // statement. When the owner holds more than one non-const assertion the
  // comment is ambiguous, so we reject rather than guess.
  if (countAssertions(owner) !== 1) return false;

  // An assertion with exactly one sibling in its owner is unambiguous: accept
  // either a comment directly before the assertion or the owner statement's
  // leading comment. Both must be substantive and adjacent.
  const direct = leadingSafetyBlock(sourceCode, node);
  if (direct !== null && isSubstantive(direct)) return true;
  const ownerBlock = leadingSafetyBlock(sourceCode, owner);
  return ownerBlock !== null && isSubstantive(ownerBlock);
}

/** Require every non-const type assertion to carry a directly associated SAFETY justification. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a directly associated, non-vacuous SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion needs an adjacent `SAFETY:` comment identifying the exact producer or framework boundary and the invariant assumed. Placeholder or inherited comments are not accepted.",
    },
  },
  createOnce(context) {
    let program: ESTree.Node | null = null;
    const checkAssertion = (node: TypeAssertion) => {
      if (program === null) return;
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node, program)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      Program(node: ESTree.Node) {
        program = node;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
