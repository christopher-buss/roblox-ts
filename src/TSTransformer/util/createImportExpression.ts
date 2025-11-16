import luau from "@roblox-ts/luau-ast";
import { FileRelation, NetworkType, RbxPath, RbxPathParent, RbxType, RojoResolver } from "@roblox-ts/rojo-resolver";
import path from "path";
import { NODE_MODULES, PARENT_FIELD, ProjectType } from "Shared/constants";
import { errors } from "Shared/diagnostics";
import { assert } from "Shared/util/assert";
import { getCanonicalFileName } from "Shared/util/getCanonicalFileName";
import { TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { createGetService } from "TSTransformer/util/createGetService";
import { propertyAccessExpressionChain } from "TSTransformer/util/expressionChain";
import { getSourceFileFromModuleSpecifier } from "TSTransformer/util/getSourceFileFromModuleSpecifier";
import ts from "typescript";

function getAbsoluteImport(moduleRbxPath: RbxPath) {
	const pathExpressions = new Array<luau.Expression>();
	const serviceName = moduleRbxPath[0];
	assert(serviceName);
	pathExpressions.push(createGetService(serviceName));
	for (let i = 1; i < moduleRbxPath.length; i++) {
		pathExpressions.push(luau.string(moduleRbxPath[i]));
	}
	return pathExpressions;
}

function getRelativeImport(sourceRbxPath: RbxPath, moduleRbxPath: RbxPath) {
	const relativePath = RojoResolver.relative(sourceRbxPath, moduleRbxPath);

	// create descending path pieces
	const path = new Array<string>();
	let i = 0;
	while (relativePath[i] === RbxPathParent) {
		path.push(PARENT_FIELD);
		i++;
	}

	const pathExpressions: Array<luau.Expression> = [propertyAccessExpressionChain(luau.globals.script, path)];

	// create descending path pieces
	for (; i < relativePath.length; i++) {
		const pathPart = relativePath[i];
		assert(typeof pathPart === "string");
		pathExpressions.push(luau.string(pathPart));
	}

	return pathExpressions;
}

function validateModule(state: TransformState, scope: string) {
	// In monorepos, nodeModulesPath may point to a package's local directory,
	// but typeRoots points to the actual location (usually root node_modules).
	// Instead of comparing paths, check if the scope ends any of the typeRoots.
	if (state.compilerOptions.typeRoots) {
		for (const typeRoot of state.compilerOptions.typeRoots) {
			const normalizedTypeRoot = path.normalize(typeRoot);
			if (normalizedTypeRoot.endsWith(path.normalize(scope))) {
				return true;
			}
		}
	}
	return false;
}

function findRelativeRbxPath(moduleOutPath: string, pkgRojoResolvers: Array<RojoResolver>) {
	for (const pkgRojoResolver of pkgRojoResolvers) {
		const relativeRbxPath = pkgRojoResolver.getRbxPathFromFilePath(moduleOutPath);
		if (relativeRbxPath) {
			return relativeRbxPath;
		}
	}
}

function getPathsWithScope(rojoResolver: RojoResolver, moduleScope: string): Array<string> {
	const pathsWithScope = new Set<string>();

	for (const partition of rojoResolver.getPartitions()) {
		const fsPath = partition.fsPath;
		const normalized = path.normalize(fsPath);
		if (normalized.endsWith(moduleScope) && !normalized.includes(NODE_MODULES)) {
			pathsWithScope.add(normalized);
		}
	}

	return Array.from(pathsWithScope);
}

function getNodeModulesImportParts(
	state: TransformState,
	sourceFile: ts.SourceFile,
	moduleSpecifier: ts.Expression,
	moduleOutPath: string,
) {
	const moduleScope = path.relative(state.data.nodeModulesPath, moduleOutPath).split(path.sep)[0];
	assert(moduleScope);

	if (!moduleScope.startsWith("@")) {
		DiagnosticService.addDiagnostic(errors.noUnscopedModule(moduleSpecifier));
		return [luau.none()];
	}

	if (!validateModule(state, moduleScope)) {
		DiagnosticService.addDiagnostic(errors.noInvalidModule(moduleSpecifier));
		return [luau.none()];
	}

	if (state.projectType === ProjectType.Package) {
		// In monorepos, moduleOutPath may be under the package's local node_modules,
		// but pkgRojoResolvers are based on typeRoots (usually root node_modules).
		// We need to remap the path from package-local to root-level.
		let resolvedModuleOutPath = moduleOutPath;
		const nodeModulesIndex = moduleOutPath.lastIndexOf(NODE_MODULES);
		if (nodeModulesIndex !== -1 && state.compilerOptions.typeRoots) {
			const afterNodeModules = moduleOutPath.substring(nodeModulesIndex + NODE_MODULES.length + 1);

			const scope = afterNodeModules.split(path.sep)[0];
			for (const typeRoot of state.compilerOptions.typeRoots) {
				if (path.normalize(typeRoot).endsWith(path.normalize(scope))) {
					resolvedModuleOutPath = path.join(typeRoot, afterNodeModules.substring(scope.length + 1));
					break;
				}
			}
		}

		const relativeRbxPath = findRelativeRbxPath(resolvedModuleOutPath, state.pkgRojoResolvers);
		if (!relativeRbxPath) {
			DiagnosticService.addDiagnostic(
				errors.noRojoData(moduleSpecifier, path.relative(state.data.projectPath, moduleOutPath), true),
			);
			return [luau.none()];
		}

		const moduleName = relativeRbxPath[0];
		assert(moduleName);

		return [
			propertyAccessExpressionChain(
				luau.call(state.TS(moduleSpecifier.parent, "getModule"), [
					luau.globals.script,
					luau.string(moduleScope),
					luau.string(moduleName),
				]),
				relativeRbxPath.slice(1),
			),
		];
	} else {
		let moduleRbxPath = state.rojoResolver.getRbxPathFromFilePath(moduleOutPath);

		// If not found in main resolver and this is a node_modules import,
		// try finding it in alternative locations (e.g., rojo-sync directory)
		if (!moduleRbxPath) {
			const pathsWithScope = getPathsWithScope(state.rojoResolver, moduleScope);
			if (pathsWithScope.length === 0) {
				DiagnosticService.addDiagnostic(
					errors.noRojoData(moduleSpecifier, path.relative(state.data.projectPath, moduleOutPath), true),
				);
				return [luau.none()];
			}

			// Extract the package part after node_modules (e.g., "@rbxts/services/init.lua")
			const nodeModulesIndex = moduleOutPath.lastIndexOf(NODE_MODULES);
			const afterNodeModules = moduleOutPath.substring(nodeModulesIndex + NODE_MODULES.length + 1);
			const packageName = afterNodeModules.split(path.sep).slice(1).join(path.sep);

			for (const pathWithScope of pathsWithScope) {
				const alternativePath = path.join(pathWithScope, packageName);
				const testRbxPath = state.rojoResolver.getRbxPathFromFilePath(alternativePath);
				if (testRbxPath) {
					moduleRbxPath = testRbxPath;
					break;
				}
			}
		}

		if (!moduleRbxPath) {
			DiagnosticService.addDiagnostic(
				errors.noRojoData(moduleSpecifier, path.relative(state.data.projectPath, moduleOutPath), true),
			);
			return [luau.none()];
		}

		const indexOfScope = moduleRbxPath.indexOf(moduleScope);
		if (indexOfScope === -1 || moduleRbxPath[indexOfScope - 1] !== NODE_MODULES) {
			DiagnosticService.addDiagnostic(
				errors.noPackageImportWithoutScope(
					moduleSpecifier,
					path.relative(state.data.projectPath, moduleOutPath),
					moduleRbxPath,
				),
			);
			return [luau.none()];
		}

		return getProjectImportParts(state, sourceFile, moduleSpecifier, moduleOutPath, moduleRbxPath);
	}
}

function getProjectImportParts(
	state: TransformState,
	sourceFile: ts.SourceFile,
	moduleSpecifier: ts.Expression,
	moduleOutPath: string,
	moduleRbxPath: RbxPath,
) {
	const moduleRbxType = state.rojoResolver.getRbxTypeFromFilePath(moduleOutPath);
	if (moduleRbxType === RbxType.Script || moduleRbxType === RbxType.LocalScript) {
		DiagnosticService.addDiagnostic(errors.noNonModuleImport(moduleSpecifier));
		return [luau.none()];
	}

	const sourceOutPath = state.pathTranslator.getOutputPath(sourceFile.fileName);
	const sourceRbxPath = state.rojoResolver.getRbxPathFromFilePath(sourceOutPath);
	if (!sourceRbxPath) {
		DiagnosticService.addDiagnostic(
			errors.noRojoData(sourceFile, path.relative(state.data.projectPath, sourceOutPath), false),
		);
		return [luau.none()];
	}

	if (state.projectType === ProjectType.Game) {
		if (
			// in the case of `import("")`, don't do network type check
			// as the call may be guarded by runtime RunService checks
			!ts.isImportCall(moduleSpecifier.parent) &&
			state.rojoResolver.getNetworkType(moduleRbxPath) === NetworkType.Server &&
			state.rojoResolver.getNetworkType(sourceRbxPath) !== NetworkType.Server
		) {
			DiagnosticService.addDiagnostic(errors.noServerImport(moduleSpecifier));
			return [luau.none()];
		}

		const fileRelation = state.rojoResolver.getFileRelation(sourceRbxPath, moduleRbxPath);
		if (fileRelation === FileRelation.OutToOut || fileRelation === FileRelation.InToOut) {
			return getAbsoluteImport(moduleRbxPath);
		} else if (fileRelation === FileRelation.InToIn) {
			return getRelativeImport(sourceRbxPath, moduleRbxPath);
		} else {
			DiagnosticService.addDiagnostic(errors.noIsolatedImport(moduleSpecifier));
			return [luau.none()];
		}
	} else {
		return getRelativeImport(sourceRbxPath, moduleRbxPath);
	}
}

export function getImportParts(state: TransformState, sourceFile: ts.SourceFile, moduleSpecifier: ts.Expression) {
	const moduleFile = getSourceFileFromModuleSpecifier(state, moduleSpecifier);
	if (!moduleFile) {
		DiagnosticService.addDiagnostic(errors.noModuleSpecifierFile(moduleSpecifier));
		return [luau.none()];
	}

	const virtualPath = state.guessVirtualPath(moduleFile.fileName) || moduleFile.fileName;

	if (ts.isInsideNodeModules(virtualPath)) {
		const moduleOutPath = state.pathTranslator.getImportPath(
			state.nodeModulesPathMapping.get(getCanonicalFileName(path.normalize(virtualPath))) ?? virtualPath,
			/* isNodeModule */ true,
		);
		return getNodeModulesImportParts(state, sourceFile, moduleSpecifier, moduleOutPath);
	} else {
		const moduleOutPath = state.pathTranslator.getImportPath(virtualPath);
		const moduleRbxPath = state.rojoResolver.getRbxPathFromFilePath(moduleOutPath);
		if (!moduleRbxPath) {
			DiagnosticService.addDiagnostic(
				errors.noRojoData(moduleSpecifier, path.relative(state.data.projectPath, moduleOutPath), false),
			);
			return [luau.none()];
		}
		return getProjectImportParts(state, sourceFile, moduleSpecifier, moduleOutPath, moduleRbxPath);
	}
}

export function createImportExpression(
	state: TransformState,
	sourceFile: ts.SourceFile,
	moduleSpecifier: ts.Expression,
): luau.IndexableExpression {
	const parts = getImportParts(state, sourceFile, moduleSpecifier);
	parts.unshift(luau.globals.script);
	return luau.call(state.TS(moduleSpecifier.parent, "import"), parts);
}
