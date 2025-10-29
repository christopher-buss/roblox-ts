import { compileSolutionProject } from "Project/functions/compileSolutionProject";
import { createSolutionBuilderHost, SolutionBuilderHostOptions } from "Project/functions/createSolutionBuilderHost";
import { LogService } from "Shared/classes/LogService";
import { ProjectOptions } from "Shared/types";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export interface RobloxSolutionBuilderOptions extends SolutionBuilderHostOptions {
	solutionOptions?: ts.BuildOptions;
	projectOptions: ProjectOptions;
}

export class RobloxSolutionBuilder {
	private readonly solutionBuilder: ts.SolutionBuilder<ts.EmitAndSemanticDiagnosticsBuilderProgram>;
	private readonly host: ts.SolutionBuilderHost<ts.EmitAndSemanticDiagnosticsBuilderProgram>;
	private readonly projectOptions: ProjectOptions;

	constructor(rootConfigPath: string, options: RobloxSolutionBuilderOptions) {
		this.projectOptions = options.projectOptions;

		this.host = createSolutionBuilderHost({
			verbose: options.verbose,
			logStatus: options.logStatus,
			diagnosticReporter: options.diagnosticReporter,
			statusReporter: options.statusReporter,
		});

		this.solutionBuilder = ts.createSolutionBuilder(
			this.host,
			[rootConfigPath],
			options.solutionOptions ?? {
				incremental: true,
				verbose: options.verbose ?? false,
			},
		);
	}

	public build(): ts.ExitStatus {
		while (true) {
			const project = this.solutionBuilder.getNextInvalidatedProject();

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

					const success = compileSolutionProject(program, configPath, this.projectOptions, this.host);

					if (success) {
						project.emit();
					}
				}

				project.done();
			} catch (error) {
				LogService.writeLine(`Error building project: ${error}`);
				project.done();
			}
		}

		DiagnosticService.flush();

		return ts.ExitStatus.Success;
	}

	public buildAll(): ts.ExitStatus {
		this.solutionBuilder.clean();

		return this.build();
	}

	public clean(): ts.ExitStatus {
		return this.solutionBuilder.clean();
	}

	public getNextInvalidatedProject(): ts.InvalidatedProject<ts.EmitAndSemanticDiagnosticsBuilderProgram> | undefined {
		return this.solutionBuilder.getNextInvalidatedProject();
	}
}
