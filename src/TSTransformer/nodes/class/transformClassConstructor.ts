import luau from "@roblox-ts/luau-ast";
import { errors } from "Shared/diagnostics";
import { TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { Prereqs } from "TSTransformer/classes/Prereqs";
import { transformExpression } from "TSTransformer/nodes/expressions/transformExpression";
import { transformIdentifierDefined } from "TSTransformer/nodes/expressions/transformIdentifier";
import { transformParameters } from "TSTransformer/nodes/transformParameters";
import { transformPropertyName } from "TSTransformer/nodes/transformPropertyName";
import { transformStatementList } from "TSTransformer/nodes/transformStatementList";
import { getExtendsNode } from "TSTransformer/util/getExtendsNode";
import { getStatements } from "TSTransformer/util/getStatements";
import ts from "typescript";

export function transformClassConstructor(
	state: TransformState,
	node: ts.ClassLikeDeclaration,
	name: luau.AnyIdentifier,
	originNode?: ts.ConstructorDeclaration & { body: ts.Block },
) {
	const statements = luau.list.make<luau.Statement>();

	let bodyStatements = originNode ? getStatements(originNode.body) : [];

	let removeFirstSuper = false;

	let parameters = luau.list.make<luau.AnyIdentifier>();
	let hasDotDotDot = false;
	if (originNode) {
		const {
			statements: paramStatements,
			parameters: constructorParams,
			hasDotDotDot: constructorHasDotDotDot,
		} = transformParameters(state, originNode);
		luau.list.pushList(statements, paramStatements);
		parameters = constructorParams;
		hasDotDotDot = constructorHasDotDotDot;
	} else if (getExtendsNode(node)) {
		// if extends + no constructor:
		// - add ... to params
		// - add super.constructor(self, ...)
		hasDotDotDot = true;
		luau.list.push(
			statements,
			luau.create(luau.SyntaxKind.CallStatement, {
				expression: luau.call(luau.property(luau.globals.super, "constructor"), [
					luau.globals.self,
					luau.create(luau.SyntaxKind.VarArgsLiteral, {}),
				]),
			}),
		);
	}

	// property parameters must come after the first super() call
	function transformFirstSuper() {
		if (!removeFirstSuper) {
			removeFirstSuper = true;
			if (bodyStatements.length > 0) {
				const firstStatement = bodyStatements[0];
				if (ts.isExpressionStatement(firstStatement) && ts.isSuperCall(firstStatement.expression)) {
					luau.list.pushList(statements, transformStatementList(state, originNode?.body, [firstStatement]));
				}
			}
		}
	}

	for (const parameter of originNode?.parameters ?? []) {
		if (ts.isParameterPropertyDeclaration(parameter, parameter.parent)) {
			transformFirstSuper();
			const paramId = transformIdentifierDefined(state, parameter.name);
			luau.list.push(
				statements,
				luau.create(luau.SyntaxKind.Assignment, {
					left: luau.property(luau.globals.self, paramId.name),
					operator: "=",
					right: paramId,
				}),
			);
		}
	}

	for (const member of node.members) {
		if (ts.isPropertyDeclaration(member) && !ts.hasStaticModifier(member)) {
			transformFirstSuper();

			const name = member.name;
			if (ts.isPrivateIdentifier(name)) {
				DiagnosticService.addDiagnostic(errors.noPrivateIdentifier(node));
				continue;
			}

			const initializer = member.initializer;
			if (!initializer) {
				continue;
			}

			const indexPrereqs = new Prereqs();
			const index = transformPropertyName(state, indexPrereqs, name);
			luau.list.pushList(statements, indexPrereqs.statements);

			const rightPrereqs = new Prereqs();
			const right = transformExpression(state, rightPrereqs, initializer);
			luau.list.pushList(statements, rightPrereqs.statements);

			luau.list.push(
				statements,
				luau.create(luau.SyntaxKind.Assignment, {
					left: luau.create(luau.SyntaxKind.ComputedIndexExpression, {
						expression: luau.globals.self,
						index,
					}),
					operator: "=",
					right,
				}),
			);
		}
	}

	// if removeFirstSuper and first statement is `super()`, remove it
	if (removeFirstSuper && bodyStatements.length > 0) {
		const firstStatement = bodyStatements[0];
		if (ts.isExpressionStatement(firstStatement) && ts.isSuperCall(firstStatement.expression)) {
			bodyStatements = bodyStatements.slice(1);
		}
	}

	luau.list.pushList(statements, transformStatementList(state, originNode?.body, bodyStatements));

	return luau.list.make<luau.Statement>(
		luau.create(luau.SyntaxKind.MethodDeclaration, {
			expression: name,
			name: "constructor",
			statements,
			parameters,
			hasDotDotDot,
		}),
	);
}
