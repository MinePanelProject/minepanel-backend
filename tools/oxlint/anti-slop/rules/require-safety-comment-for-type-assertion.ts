import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

const evidenceContext =
  /\b(?:parser|validation|schema|runtime|framework|library|producer|request|response|database|external|api|json|drizzle|dockerode|nestjs|express|socket\.io|engine\.io|jwt|otplib|mock|double|fixture|prototype|collaborator)\b/iu;
const evidenceInvariant =
  /\b(?:invariant|contract|boundary|field|member|property|shape|surface|only|exact(?:ly)?|checked|narrowed|returns?|reads?|calls?|consumes?|provides?|implements?|exports?|satisf(?:ies|ied))\b/iu;

function hasMeaningfulSafetyEvidence(comment: string): boolean {
  const explanation = comment.replace(/\bSAFETY\s*:/iu, "");
  return evidenceContext.test(explanation) && evidenceInvariant.test(explanation);
}

function hasTypePredicateParserBoundary(node: ESTree.Node): boolean {
  let current = node.parent;
  while (current.type !== "Program") {
    if (
      (current.type === "ArrowFunctionExpression" ||
        current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression") &&
      current.returnType?.typeAnnotation.type === "TSTypePredicate"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (current.type !== "Program") {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some(
          (comment) =>
            comment.end <= node.start &&
            /\bSAFETY\s*:/u.test(comment.value) &&
            hasMeaningfulSafetyEvidence(comment.value),
        )
    ) {
      return true;
    }
    if (commentOwnerKinds.has(current.type) && !hasTypePredicateParserBoundary(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion needs an adjacent `SAFETY:` comment naming the producer or boundary and the invariant that makes the assertion sound.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
