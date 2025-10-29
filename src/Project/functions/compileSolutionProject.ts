import { renderAST } from "@roblox-ts/luau-ast";
import { PathTranslator } from "@roblox-ts/path-translator";
import { NetworkType, RbxPath, RojoResolver } from "@roblox-ts/rojo-resolver";
import fs from "fs-extra";
import path from "path";
import { checkFileName } from "Project/functions/checkFileName";
import { checkRojoConfig } from "Project/functions/checkRojoConfig";
import { createNodeModulesPathMapping } from "Project/functions/createNodeModulesPathMapping";
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
import { ProjectOptions } from "Shared/types";
import { assert } from "Shared/util/assert";
import { benchmarkIfVerbose } from "Shared/util/benchmark";
import { createTextDiagnostic } from "Shared/util/createTextDiagnostic";
import { findAncestorDir } from "Shared/util/findAncestorDir";
import { getRootDirs } from "Shared/util/getRootDirs";
import { MultiTransformState, transformSourceFile, TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { createTransformServices } from "TSTransformer/util/createTransformServices";
import ts from "typescript";

function inferProjectType(isPackage: boolean, rojoResolver: RojoResolver): ProjectType {
	if (isPackage) {
		return ProjectType.Package;
	} else if (rojoResolver.isGame) {
		return ProjectType.Game;
	} else {
		return ProjectType.Model;
	}
}

export function compileSolutionProject(
	builderProgram: ts.EmitAndSemanticDiagnosticsBuilderProgram,
	projectConfigPath: string,
	projectOptions: ProjectOptions,
	host: ts.SolutionBuilderHost<ts.EmitAndSemanticDiagnosticsBuilderProgram>,
	pathHints?: Array<string>,
): boolean {
	try {
		const program = builderProgram.getProgram();
		const compilerOptions = program.getCompilerOptions();

		const projectData = createProjectData(projectConfigPath, projectOptions);

		const sourceFiles = getChangedSourceFiles(builderProgram, pathHints);

		if (sourceFiles.length === 0) {
			return true;
		}

		const multiTransformState = new MultiTransformState();

		const outDir = compilerOptions.outDir!;

		const rootDir = findAncestorDir([program.getCommonSourceDirectory(), ...getRootDirs(compilerOptions)]);
		let buildInfoPath = ts.getTsBuildInfoEmitOutputFilePath(compilerOptions);
		if (buildInfoPath !== undefined) {
			buildInfoPath = path.normalize(buildInfoPath);
		}
		const declaration = compilerOptions.declaration === true;
		const pathTranslator = new PathTranslator(
			rootDir,
			outDir,
			buildInfoPath,
			declaration,
			projectData.projectOptions.luau,
		);

		const rojoResolver = projectData.rojoConfigPath
			? RojoResolver.fromPath(projectData.rojoConfigPath)
			: RojoResolver.synthetic(outDir);

		for (const warning of rojoResolver.getWarnings()) {
			LogService.warn(warning);
		}

		checkRojoConfig(projectData, rojoResolver, getRootDirs(compilerOptions), pathTranslator);

		for (const sourceFile of program.getSourceFiles()) {
			if (!path.normalize(sourceFile.fileName).startsWith(projectData.nodeModulesPath)) {
				checkFileName(sourceFile.fileName);
			}
		}

		const pkgRojoResolvers = compilerOptions.typeRoots!.map(RojoResolver.synthetic);
		const nodeModulesPathMapping = createNodeModulesPathMapping(compilerOptions.typeRoots!);

		const projectType = projectData.projectOptions.type ?? inferProjectType(projectData.isPackage, rojoResolver);

		if (projectType !== ProjectType.Package && projectData.rojoConfigPath === undefined) {
			DiagnosticService.addDiagnostic(
				createTextDiagnostic("Non-package projects must have a Rojo project file!"),
			);
			return false;
		}

		let runtimeLibRbxPath: RbxPath | undefined;
		if (projectType !== ProjectType.Package) {
			runtimeLibRbxPath = rojoResolver.getRbxPathFromFilePath(
				path.join(projectData.projectOptions.includePath, "RuntimeLib.lua"),
			);
			if (!runtimeLibRbxPath) {
				DiagnosticService.addDiagnostic(
					createTextDiagnostic("Rojo project contained no data for include folder!"),
				);
				return false;
			} else if (rojoResolver.getNetworkType(runtimeLibRbxPath) !== NetworkType.Unknown) {
				DiagnosticService.addDiagnostic(
					createTextDiagnostic("Runtime library cannot be in a server-only or client-only container!"),
				);
				return false;
			} else if (rojoResolver.isIsolated(runtimeLibRbxPath)) {
				DiagnosticService.addDiagnostic(
					createTextDiagnostic("Runtime library cannot be in an isolated container!"),
				);
				return false;
			}
		}

		if (DiagnosticService.hasErrors()) {
			return false;
		}

		const fileWriteQueue = new Array<{ sourceFile: ts.SourceFile; source: string }>();
		const progressMaxLength = `${sourceFiles.length}/${sourceFiles.length}`.length;

		let proxyProgram = program;

		if (compilerOptions.plugins && compilerOptions.plugins.length > 0) {
			benchmarkIfVerbose(`running transformers..`, () => {
				const pluginConfigs = getPluginConfigs(projectData.tsConfigPath);
				const transformerList = createTransformerList(program, pluginConfigs, projectData.projectPath);
				const transformers = flattenIntoTransformers(transformerList);
				if (transformers.length > 0) {
					const { service, updateFile } = (projectData.transformerWatcher ??=
						createTransformerWatcher(program));
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
							const source = ts.createPrinter().printFile(sourceFile);
							updateFile(sourceFile.fileName, source);
							if (projectData.projectOptions.writeTransformedFiles) {
								const outPath = pathTranslator.getOutputTransformedPath(sourceFile.fileName);
								fs.outputFileSync(outPath, source);
							}
						}
					}

					proxyProgram = service.getProgram()!;
				}
			});
		}

		if (DiagnosticService.hasErrors()) {
			return false;
		}

		const typeChecker = proxyProgram.getTypeChecker();
		const services = createTransformServices(typeChecker);

		for (let i = 0; i < sourceFiles.length; i++) {
			const sourceFile = proxyProgram.getSourceFile(sourceFiles[i].fileName);
			assert(sourceFile);
			const progress = `${i + 1}/${sourceFiles.length}`.padStart(progressMaxLength);
			benchmarkIfVerbose(`${progress} compile ${path.relative(process.cwd(), sourceFile.fileName)}`, () => {
				DiagnosticService.addDiagnostics(ts.getPreEmitDiagnostics(proxyProgram, sourceFile));
				DiagnosticService.addDiagnostics(getCustomPreEmitDiagnostics(projectData, sourceFile));
				if (DiagnosticService.hasErrors()) return;

				const transformState = new TransformState(
					proxyProgram,
					projectData,
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

		if (DiagnosticService.hasErrors()) {
			return false;
		}

		const emittedFiles = new Array<string>();
		if (fileWriteQueue.length > 0) {
			benchmarkIfVerbose("writing compiled files", () => {
				for (const { sourceFile, source } of fileWriteQueue) {
					const outPath = pathTranslator.getOutputPath(sourceFile.fileName);
					if (
						!projectData.projectOptions.writeOnlyChanged ||
						!fs.pathExistsSync(outPath) ||
						fs.readFileSync(outPath).toString() !== source
					) {
						fs.outputFileSync(outPath, source);
						emittedFiles.push(outPath);
					}
				}
			});
		}

		if (compilerOptions.declaration) {
			const afterDeclarations = [transformTypeReferenceDirectives, transformPathsTransformer(proxyProgram, {})];

			benchmarkIfVerbose("emitting declaration files", () => {
				for (const { sourceFile } of fileWriteQueue) {
					proxyProgram.emit(sourceFile, ts.sys.writeFile, undefined, true, { afterDeclarations });
				}
			});
		}

		return true;
	} catch {
		return false;
	}
}
