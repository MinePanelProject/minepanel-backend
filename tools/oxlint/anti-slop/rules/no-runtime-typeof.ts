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

function containsUnknownSignature(
	signature:
		| ESTree.TSIndexSignature
		| ESTree.TSPropertySignature
		| ESTree.TSCallSignatureDeclaration
		| ESTree.TSConstructSignatureDeclaration
		| ESTree.TSMethodSignature,
): boolean {
	switch (signature.type) {
		case "TSPropertySignature":
			return (
				signature.typeAnnotation !== null &&
				signature.typeAnnotation !== undefined &&
				containsUnknownType(signature.typeAnnotation.typeAnnotation)
			);
		case "TSIndexSignature":
			return containsUnknownType(signature.typeAnnotation.typeAnnotation);
		case "TSCallSignatureDeclaration":
		case "TSConstructSignatureDeclaration":
		case "TSMethodSignature":
			return (
				signature.returnType !== null &&
				signature.returnType !== undefined &&
				containsUnknownType(signature.returnType.typeAnnotation)
			);
		default:
			return false;
	}
}

function containsUnknownType(
	type: ESTree.TSType | ESTree.TSOptionalType | ESTree.TSRestType,
): boolean {
	if (type.type === "TSOptionalType" || type.type === "TSRestType") {
		return containsUnknownType(type.typeAnnotation);
	}
	switch (type.type) {
		case "TSUnknownKeyword":
		case "TSAnyKeyword":
			return true;
		case "TSArrayType":
			return containsUnknownType(type.elementType);
		case "TSTypeReference":
			return type.typeArguments?.params.some(containsUnknownType) ?? false;
		case "TSTypeLiteral":
			return type.members.some(containsUnknownSignature);
		case "TSMappedType":
			return (
				containsUnknownType(type.constraint) ||
				(type.nameType !== null && containsUnknownType(type.nameType)) ||
				(type.typeAnnotation !== null && containsUnknownType(type.typeAnnotation))
			);
		case "TSParenthesizedType":
			return containsUnknownType(type.typeAnnotation);
		case "TSUnionType":
		case "TSIntersectionType":
			return type.types.some(containsUnknownType);
		case "TSConditionalType":
			return (
				containsUnknownType(type.checkType) ||
				containsUnknownType(type.extendsType) ||
				containsUnknownType(type.trueType) ||
				containsUnknownType(type.falseType)
			);
		case "TSIndexedAccessType":
			return containsUnknownType(type.objectType) || containsUnknownType(type.indexType);
		case "TSTupleType":
			return type.elementTypes.some(containsUnknownType);
		case "TSNamedTupleMember":
			return containsUnknownType(type.elementType);
		case "TSTypeOperator":
			return containsUnknownType(type.typeAnnotation);
		case "TSFunctionType":
		case "TSConstructorType":
			return containsUnknownType(type.returnType.typeAnnotation);
		case "TSImportType":
			return type.typeArguments?.params.some(containsUnknownType) ?? false;
		case "TSTypeQuery":
			return type.typeArguments?.params.some(containsUnknownType) ?? false;
		case "TSTemplateLiteralType":
			return type.types.some(containsUnknownType);
		case "TSTypePredicate":
			return (
				type.typeAnnotation !== null &&
				containsUnknownType(type.typeAnnotation.typeAnnotation)
			);
		case "TSInferType":
			return (
				(type.typeParameter.constraint !== null &&
					containsUnknownType(type.typeParameter.constraint)) ||
				(type.typeParameter.default !== null &&
					containsUnknownType(type.typeParameter.default))
			);
		default:
			return false;
	}
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
	create(context) {
		const isJavaScriptFile = /\.(?:js|mjs|cjs|jsx)$/u.test(context.filename.replaceAll("\\", "/"));
		return {
			UnaryExpression(node) {
				if (isJavaScriptFile) return;
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

