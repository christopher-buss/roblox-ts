import { compileSolutionProject } from "Project/functions/compileFiles";
import { LogService } from "Shared/classes/LogService";
import { ProjectOptions } from "Shared/types";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export function setupSolutionWatchProgram(rootConfigPath: string, projectOptions: ProjectOptions): void {
	try {
		const host = createSolutionBuilderWatchHost(projectOptions);

		const solutionBuilder = ts.createSolutionBuilderWithWatch(host, [rootConfigPath], {
			incremental: true,
			verbose: projectOptions.verbose ?? false,
			watch: true,
		});

		solutionBuilder.build();
	} catch (error) {
		LogService.writeLine(`Error setting up solution watch: ${error}`);
		if (error instanceof Error && error.stack) {
			LogService.writeLineIfVerbose(error.stack);
		}
		throw error;
	}
}

function createSolutionBuilderWatchHost(
	projectOptions: ProjectOptions,
): ts.SolutionBuilderWithWatchHost<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
	const diagnosticReporter = ts.createDiagnosticReporter(ts.sys, true);
	const builderStatusReporter = ts.createBuilderStatusReporter(ts.sys, true);
	const statusReporter = ts.createWatchStatusReporter(ts.sys, true);

	// Track which projects have been built to run cleanup only once per project
	const builtProjects = new Set<string>();

	// Use TypeScript's built-in watch host creator
	const watchHost = ts.createSolutionBuilderWithWatchHost(
		ts.sys,
		ts.createEmitAndSemanticDiagnosticsBuilderProgram,
		diagnosticReporter,
		builderStatusReporter,
		statusReporter,
	);

	// Wrap createProgram to intercept program creation and trigger Luau compilation
	const originalCreateProgram = watchHost.createProgram;
	if (originalCreateProgram) {
		watchHost.createProgram = function (...args) {
			const program = originalCreateProgram.apply(this, args);

			// After TypeScript creates the program, compile to Luau
			if (program) {
				try {
					const configFile = program.getProgram().getCompilerOptions().configFilePath;
					const configPath =
						typeof configFile === "string" ? configFile : program.getProgram().getCurrentDirectory();

					// Run cleanup only on first build of each project
					const isFirstBuild = !builtProjects.has(configPath);
					if (isFirstBuild) {
						builtProjects.add(configPath);
					}

					// Compile the TypeScript files to Luau (this also handles file operations internally)
					const result = compileSolutionProject(program, configPath, projectOptions, undefined, {
						runCleanup: isFirstBuild,
					});

					for (const diagnostic of result.diagnostics) {
						diagnosticReporter(diagnostic);
					}

					const diagnostics = DiagnosticService.flush();
					for (const diagnostic of diagnostics) {
						diagnosticReporter(diagnostic);
					}
				} catch (error) {
					LogService.writeLine(`Error compiling to Luau: ${error}`);
					if (error instanceof Error && error.stack) {
						LogService.writeLineIfVerbose(error.stack);
					}
				}
			}

			return program;
		};
	}

	return watchHost;
}
