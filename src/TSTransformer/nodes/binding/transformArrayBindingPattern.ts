import luau from "@roblox-ts/luau-ast";
import { errors } from "Shared/diagnostics";
import { TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { Prereqs } from "TSTransformer/classes/Prereqs";
import { transformObjectBindingPattern } from "TSTransformer/nodes/binding/transformObjectBindingPattern";
import { transformVariable } from "TSTransformer/nodes/statements/transformVariableStatement";
import { transformInitializer } from "TSTransformer/nodes/transformInitializer";
import { getAccessorForBindingType } from "TSTransformer/util/binding/getAccessorForBindingType";
import { validateNotAnyType } from "TSTransformer/util/validateNotAny";
import ts from "typescript";

export function transformArrayBindingPattern(
	state: TransformState,
	prereqs: Prereqs,
	bindingPattern: ts.ArrayBindingPattern,
	parentId: luau.AnyIdentifier,
) {
	validateNotAnyType(state, bindingPattern);

	let index = 0;
	const idStack = new Array<luau.AnyIdentifier>();
	const accessor = getAccessorForBindingType(state, bindingPattern, state.getType(bindingPattern));
	for (const element of bindingPattern.elements) {
		if (ts.isOmittedExpression(element)) {
			accessor(state, prereqs, parentId, index, idStack, true);
		} else {
			if (element.dotDotDotToken) {
				DiagnosticService.addDiagnostic(errors.noSpreadDestructuring(element));
				return;
			}
			const name = element.name;
			const value = accessor(state, prereqs, parentId, index, idStack, false);
			if (ts.isIdentifier(name)) {
				const id = transformVariable(state, prereqs, name, value);
				if (element.initializer) {
					prereqs.prereq(transformInitializer(state, id, element.initializer));
				}
			} else {
				const id = prereqs.pushToVar(value, "binding");
				if (element.initializer) {
					prereqs.prereq(transformInitializer(state, id, element.initializer));
				}
				if (ts.isArrayBindingPattern(name)) {
					transformArrayBindingPattern(state, prereqs, name, id);
				} else {
					transformObjectBindingPattern(state, prereqs, name, id);
				}
			}
		}
		index++;
	}
}
