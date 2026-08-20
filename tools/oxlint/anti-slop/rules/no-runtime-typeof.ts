import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function functionName(node: RuntimeFunction): string | null {
	if ("id" in node && node.id?.type === "Identifier") return node.id.name;

	const parent = node.parent;
	if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
		return parent.id.name;
	}
	if (
		(parent.type === "MethodDefinition" || parent.type === "Property") &&
		parent.key.type === "Identifier"
	) {
		return parent.key.name;
	}
	return null;
}

function containsUnknownType(type: ESTree.TSType): boolean {
	if (type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword") return true;
	if (type.type === "TSParenthesizedType") return containsUnknownType(type.typeAnnotation);
	if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
		return type.types.some(containsUnknownType);
	}
	return false;
}

function isParserBoundary(node: RuntimeFunction): boolean {
	const returnType = node.returnType?.typeAnnotation;
	const name = functionName(node);
	return (
		returnType !== null &&
		returnType !== undefined &&
		!containsUnknownType(returnType) &&
		name !== null &&
		/^(?:parse|decode)[A-Z]/u.test(name)
	);
}

function isInsideAllowedBoundary(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return isParserBoundary(current);
		}
		current = current.parent;
	}
	return false;
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Disallow runtime typeof checks except at typed parser and type-guard boundaries. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					(!isInsideAllowedBoundary(node) &&
						(!allowInTypeGuards || !isInsideTypeGuard(node)))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});

