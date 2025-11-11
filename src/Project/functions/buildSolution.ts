import { compileSolutionProject } from "Project/functions/compileFiles";
import { createSolutionBuilderHost, SolutionBuilderHostOptions } from "Project/functions/createSolutionBuilderHost";
import { LogService } from "Shared/classes/LogService";
import { ProjectOptions } from "Shared/types";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export interface BuildSolutionOptions extends SolutionBuilderHostOptions {
	solutionOptions?: ts.BuildOptions;
	projectOptions: ProjectOptions;
}

/**
 * Builds a TypeScript solution with project references, compiling each project to Luau.
 *
 * @param rootConfigPath - Path to the root tsconfig.json
 * @param options - Build configuration options
 * @returns Exit status indicating success or failure
 */
export function buildSolution(rootConfigPath: string, options: BuildSolutionOptions): ts.ExitStatus {
	const diagnosticReporter = options.diagnosticReporter ?? ts.createDiagnosticReporter(ts.sys, true);
	const host = createSolutionBuilderHost({
		verbose: options.verbose,
		logStatus: options.logStatus,
		diagnosticReporter,
		statusReporter: options.statusReporter,
	});

	const solutionBuilder = ts.createSolutionBuilder(
		host,
		[rootConfigPath],
		options.solutionOptions ?? {
			incremental: true,
			verbose: options.verbose ?? false,
		},
	);

	let hasErrors = false;

	while (true) {
		const project = solutionBuilder.getNextInvalidatedProject();

		if (!project) {
			break;
		}

		try {
			if (project.kind === ts.InvalidatedProjectKind.Build) {
				const builderProgram = project.getBuilderProgram();

				if (!builderProgram) {
					LogService.writeLine("Warning: No builder program available for project");
					project.done();
					continue;
				}

				const program = builderProgram.getProgram();
				const configFile = program.getCompilerOptions().configFilePath;
				const configPath = typeof configFile === "string" ? configFile : program.getCurrentDirectory();

				const result = compileSolutionProject(builderProgram, configPath, options.projectOptions, undefined, {
					runCleanup: true,
				});

				for (const diagnostic of result.diagnostics) {
					diagnosticReporter(diagnostic);
				}

				if (result.emitSkipped) {
					hasErrors = true;
				}

				if (result.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) {
					hasErrors = true;
				}
			}

			project.done();
		} catch (error) {
			LogService.writeLine(`Error building project: ${error}`);
			hasErrors = true;
			project.done();
		}
	}

	const diagnostics = DiagnosticService.flush();

	for (const diagnostic of diagnostics) {
		diagnosticReporter(diagnostic);
		if (diagnostic.category === ts.DiagnosticCategory.Error) {
			hasErrors = true;
		}
	}

	if (hasErrors) {
		return ts.ExitStatus.DiagnosticsPresent_OutputsSkipped;
	}

	return ts.ExitStatus.Success;
}
