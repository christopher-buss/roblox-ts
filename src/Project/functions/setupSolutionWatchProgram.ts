import { compileSolutionProject } from "Project/functions/compileFiles";
import { createSolutionBuilderHost } from "Project/functions/createSolutionBuilderHost";
import { LogService } from "Shared/classes/LogService";
import { ProjectOptions } from "Shared/types";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export function setupSolutionWatchProgram(rootConfigPath: string, projectOptions: ProjectOptions): void {
	const host = createSolutionBuilderWatchHost(projectOptions);

	ts.createSolutionBuilderWithWatch(host, [rootConfigPath], {
		incremental: true,
		verbose: projectOptions.verbose ?? false,
		watch: true,
	});

	LogService.writeLine("Starting compilation in watch mode...");
	LogService.writeLine("Watching for file changes...");
}

function createSolutionBuilderWatchHost(
	projectOptions: ProjectOptions,
): ts.SolutionBuilderWithWatchHost<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
	const diagnosticReporter = ts.createDiagnosticReporter(ts.sys, true);

	const baseHost = createSolutionBuilderHost({
		verbose: projectOptions.verbose,
		logStatus: true,
		diagnosticReporter,
		statusReporter: diagnosticReporter,
	});

	const watchHost: ts.SolutionBuilderWithWatchHost<ts.EmitAndSemanticDiagnosticsBuilderProgram> = {
		...baseHost,

		watchFile: (path, callback, pollingInterval, watchOptions) => {
			return ts.sys.watchFile!(path, callback, pollingInterval, watchOptions);
		},

		watchDirectory: (path, callback, recursive, watchOptions) => {
			return ts.sys.watchDirectory!(path, callback, recursive, watchOptions);
		},

		setTimeout: (callback, ms, ...args) => {
			return ts.sys.setTimeout!(callback, ms, ...args);
		},

		clearTimeout: handle => {
			return ts.sys.clearTimeout!(handle);
		},
	};

	const originalAfterEmit = watchHost.afterProgramEmitAndDiagnostics;

	watchHost.afterProgramEmitAndDiagnostics = (program: ts.EmitAndSemanticDiagnosticsBuilderProgram) => {
		const configFile = program.getProgram().getCompilerOptions().configFilePath;
		const configPath = typeof configFile === "string" ? configFile : program.getProgram().getCurrentDirectory();

		const result = compileSolutionProject(program, configPath, projectOptions);

		for (const diagnostic of result.diagnostics) {
			diagnosticReporter(diagnostic);
		}

		const diagnostics = DiagnosticService.flush();
		for (const diagnostic of diagnostics) {
			diagnosticReporter(diagnostic);
		}

		originalAfterEmit?.(program);
	};

	return watchHost;
}
