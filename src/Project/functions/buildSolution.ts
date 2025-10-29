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
	const host = createSolutionBuilderHost({
		verbose: options.verbose,
		logStatus: options.logStatus,
		diagnosticReporter: options.diagnosticReporter,
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
				const program = project.getBuilderProgram();

				if (!program) {
					LogService.writeLine("Warning: No builder program available for project");
					project.done();
					continue;
				}

				const configFile = program.getProgram().getCompilerOptions().configFilePath;
				const configPath =
					typeof configFile === "string" ? configFile : program.getProgram().getCurrentDirectory();

				const result = compileSolutionProject(program, configPath, options.projectOptions);

				if (result.emitSkipped) {
					hasErrors = true;
				}

				if (result.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) {
					hasErrors = true;
				}

				if (!result.emitSkipped) {
					project.emit();
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

	if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) {
		hasErrors = true;
	}

	if (hasErrors) {
		return ts.ExitStatus.DiagnosticsPresent_OutputsSkipped;
	}

	return ts.ExitStatus.Success;
}
