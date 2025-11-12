import { renderAST } from "@roblox-ts/luau-ast";
import { PathTranslator } from "@roblox-ts/path-translator";
import { NetworkType, RbxPath, RojoResolver } from "@roblox-ts/rojo-resolver";
import fs from "fs-extra";
import path from "path";
import { checkFileName } from "Project/functions/checkFileName";
import { checkRojoConfig } from "Project/functions/checkRojoConfig";
import { cleanup } from "Project/functions/cleanup";
import { copyFiles } from "Project/functions/copyFiles";
import { copyInclude } from "Project/functions/copyInclude";
import { createNodeModulesPathMapping } from "Project/functions/createNodeModulesPathMapping";
import { createPathTranslator } from "Project/functions/createPathTranslator";
import { createProjectData } from "Project/functions/createProjectData";
import { getChangedSourceFiles } from "Project/functions/getChangedSourceFiles";
import transformPathsTransformer from "Project/transformers/builtin/transformPaths";
import { transformTypeReferenceDirectives } from "Project/transformers/builtin/transformTypeReferenceDirectives";
import { createTransformerList, flattenIntoTransformers } from "Project/transformers/createTransformerList";
import { createTransformerWatcher } from "Project/transformers/createTransformerWatcher";
import { getPluginConfigs } from "Project/transformers/getPluginConfigs";
import { getCustomPreEmitDiagnostics } from "Project/util/getCustomPreEmitDiagnostics";
import { LogService } from "Shared/classes/LogService";
import { ProjectType } from "Shared/constants";
import { DiagnosticError } from "Shared/errors/DiagnosticError";
import { ProjectData, ProjectOptions } from "Shared/types";
import { assert } from "Shared/util/assert";
import { benchmarkIfVerbose } from "Shared/util/benchmark";
import { createTextDiagnostic } from "Shared/util/createTextDiagnostic";
import { getRootDirs } from "Shared/util/getRootDirs";
import { MultiTransformState, transformSourceFile, TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { createTransformServices } from "TSTransformer/util/createTransformServices";
import ts from "typescript";

function inferProjectType(data: ProjectData, rojoResolver: RojoResolver): ProjectType {
	if (data.isPackage) {
		return ProjectType.Package;
	} else if (rojoResolver.isGame) {
		return ProjectType.Game;
	} else {
		return ProjectType.Model;
	}
}

function emitResultFailure(messageText: string): ts.EmitResult {
	return {
		emitSkipped: true,
		diagnostics: [createTextDiagnostic(messageText)],
	};
}

const ROJO_CACHE = new Map();

function compileToLuau(
	program: ts.Program,
	data: ProjectData,
	pathTranslator: PathTranslator,
	sourceFiles: Array<ts.SourceFile>,
): ts.EmitResult {
	const compilerOptions = program.getCompilerOptions();

	const multiTransformState = new MultiTransformState();

	const outDir = compilerOptions.outDir!;

	const rojoResolver = data.rojoConfigPath
		? ROJO_CACHE.get(data.rojoConfigPath) ?? RojoResolver.fromPath(data.rojoConfigPath)
		: RojoResolver.synthetic(outDir);

	if (data.rojoConfigPath) {
		ROJO_CACHE.set(data.rojoConfigPath, rojoResolver);
	}

	for (const warning of rojoResolver.getWarnings()) {
		LogService.warn(warning);
	}

	checkRojoConfig(data, rojoResolver, getRootDirs(compilerOptions), pathTranslator);

	for (const sourceFile of program.getSourceFiles()) {
		if (!path.normalize(sourceFile.fileName).startsWith(data.nodeModulesPath)) {
			checkFileName(sourceFile.fileName);
		}
	}

	const pkgRojoResolvers = compilerOptions.typeRoots!.map((v) => {
		const existing = ROJO_CACHE.get(v);
		if (existing) {
			return existing;
		}

		const rojo = RojoResolver.synthetic(v);
		ROJO_CACHE.set(v, rojo);
		return rojo;
	});

	const nodeModulesPathMapping = createNodeModulesPathMapping(compilerOptions.typeRoots!);

	const projectType = data.projectOptions.type ?? inferProjectType(data, rojoResolver);

	if (projectType !== ProjectType.Package && data.rojoConfigPath === undefined) {
		return emitResultFailure("Non-package projects must have a Rojo project file!");
	}

	let runtimeLibRbxPath: RbxPath | undefined;
	if (projectType !== ProjectType.Package) {
		runtimeLibRbxPath = rojoResolver.getRbxPathFromFilePath(
			path.join(data.projectOptions.includePath, "RuntimeLib.lua"),
		);
		if (!runtimeLibRbxPath) {
			return emitResultFailure("Rojo project contained no data for include folder!");
		} else if (rojoResolver.getNetworkType(runtimeLibRbxPath) !== NetworkType.Unknown) {
			return emitResultFailure("Runtime library cannot be in a server-only or client-only container!");
		} else if (rojoResolver.isIsolated(runtimeLibRbxPath)) {
			return emitResultFailure("Runtime library cannot be in an isolated container!");
		}
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	LogService.writeLineIfVerbose(`compiling as ${projectType}..`);

	const fileWriteQueue = new Array<{ sourceFile: ts.SourceFile; source: string }>();
	const progressMaxLength = `${sourceFiles.length}/${sourceFiles.length}`.length;

	let proxyProgram = program;

	if (compilerOptions.plugins && compilerOptions.plugins.length > 0) {
		benchmarkIfVerbose(`running transformers..`, () => {
			const pluginConfigs = getPluginConfigs(data.tsConfigPath);
			const transformerList = createTransformerList(program, pluginConfigs, data.projectPath);
			const transformers = flattenIntoTransformers(transformerList);
			if (transformers.length > 0) {
				const { service, updateFile } = (data.transformerWatcher ??= createTransformerWatcher(program));
				const transformResult = ts.transformNodes(
					undefined,
					undefined,
					ts.factory,
					compilerOptions,
					sourceFiles,
					transformers,
					false,
				);

				if (transformResult.diagnostics) DiagnosticService.addDiagnostics(transformResult.diagnostics);

				for (const sourceFile of transformResult.transformed) {
					if (ts.isSourceFile(sourceFile)) {
						// transformed nodes don't have symbol or type information (or they have out of date information)
						// there's no way to "rebind" an existing file, so we have to reprint it
						const source = ts.createPrinter().printFile(sourceFile);
						updateFile(sourceFile.fileName, source);
						if (data.projectOptions.writeTransformedFiles) {
							const outPath = pathTranslator.getOutputTransformedPath(sourceFile.fileName);
							fs.outputFileSync(outPath, source);
						}
					}
				}

				proxyProgram = service.getProgram()!;
			}
		});
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	const typeChecker = proxyProgram.getTypeChecker();
	const services = createTransformServices(typeChecker);

	for (let i = 0; i < sourceFiles.length; i++) {
		const sourceFile = proxyProgram.getSourceFile(sourceFiles[i].fileName);
		assert(sourceFile);
		const progress = `${i + 1}/${sourceFiles.length}`.padStart(progressMaxLength);
		benchmarkIfVerbose(`${progress} compile ${path.relative(process.cwd(), sourceFile.fileName)}`, () => {
			DiagnosticService.addDiagnostics(ts.getPreEmitDiagnostics(proxyProgram, sourceFile));
			DiagnosticService.addDiagnostics(getCustomPreEmitDiagnostics(data, sourceFile));
			if (DiagnosticService.hasErrors()) return;

			const transformState = new TransformState(
				proxyProgram,
				data,
				services,
				pathTranslator,
				multiTransformState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				typeChecker,
				projectType,
				sourceFile,
			);

			const luauAST = transformSourceFile(transformState, sourceFile);
			if (DiagnosticService.hasErrors()) return;

			const source = renderAST(luauAST);

			fileWriteQueue.push({ sourceFile, source });
		});
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	const emittedFiles = new Array<string>();
	if (fileWriteQueue.length > 0) {
		benchmarkIfVerbose("writing compiled files", () => {
			const afterDeclarations = compilerOptions.declaration
				? [transformTypeReferenceDirectives, transformPathsTransformer(program, {})]
				: undefined;
			for (const { sourceFile, source } of fileWriteQueue) {
				const outPath = pathTranslator.getOutputPath(sourceFile.fileName);
				if (
					!data.projectOptions.writeOnlyChanged ||
					!fs.pathExistsSync(outPath) ||
					fs.readFileSync(outPath).toString() !== source
				) {
					fs.outputFileSync(outPath, source);
					emittedFiles.push(outPath);
				}
				if (compilerOptions.declaration) {
					proxyProgram.emit(sourceFile, ts.sys.writeFile, undefined, true, { afterDeclarations });
				}
			}
		});
	}

	return { emittedFiles, emitSkipped: false, diagnostics: DiagnosticService.flush() };
}

/**
 * 'transpiles' TypeScript project into a logically identical Luau project.
 *
 * writes rendered Luau source to the out directory.
 */
export function compileFiles(
	program: ts.Program,
	data: ProjectData,
	pathTranslator: PathTranslator,
	sourceFiles: Array<ts.SourceFile>,
): ts.EmitResult {
	const result = compileToLuau(program, data, pathTranslator, sourceFiles);

	if (!result.emitSkipped) {
		program.emitBuildInfo();
	}

	return result;
}

export function compileSolutionProject(
	builderProgram: ts.EmitAndSemanticDiagnosticsBuilderProgram,
	projectConfigPath: string,
	projectOptions: ProjectOptions,
	pathHints?: Array<string>,
	options?: { runCleanup?: boolean },
): ts.EmitResult {
	try {
		const program = builderProgram.getProgram();
		const projectData = createProjectData(projectConfigPath, projectOptions);
		const pathTranslator = createPathTranslator(builderProgram, projectData);

		// Run file operations before compilation
		if (options?.runCleanup) {
			cleanup(pathTranslator);
		}
		copyInclude(projectData);
		const compilerOptions = program.getCompilerOptions();
		copyFiles(projectData, pathTranslator, new Set(getRootDirs(compilerOptions)));

		const sourceFiles = getChangedSourceFiles(builderProgram, pathHints);

		if (sourceFiles.length === 0) {
			return { emittedFiles: [], emitSkipped: false, diagnostics: [] };
		}

		const result = compileToLuau(program, projectData, pathTranslator, sourceFiles);

		if (!result.emitSkipped) {
			const emitBuildInfo = builderProgram.emitBuildInfo ?? program.emitBuildInfo?.bind(program);
			emitBuildInfo?.();
		}

		return result;
	} catch (e) {
		if (e instanceof DiagnosticError) {
			return {
				emitSkipped: true,
				diagnostics: e.diagnostics,
			};
		}

		LogService.writeLine(`Unexpected error compiling solution project: ${e}`);
		throw e;
	}
}
