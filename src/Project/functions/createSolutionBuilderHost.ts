import { LogService } from "Shared/classes/LogService";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export interface SolutionBuilderHostOptions {
	verbose?: boolean;
	logStatus?: boolean;
	diagnosticReporter?: ts.DiagnosticReporter;
	statusReporter?: ts.DiagnosticReporter;
}

export function createSolutionBuilderHost(
	options: SolutionBuilderHostOptions = {},
): ts.SolutionBuilderHost<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
	const defaultHost = ts.createSolutionBuilderHost(
		ts.sys,
		ts.createEmitAndSemanticDiagnosticsBuilderProgram,
		options.diagnosticReporter ?? createDiagnosticReporter(),
		options.statusReporter ?? (options.logStatus !== false ? createStatusReporter() : undefined),
	);

	return defaultHost;
}

function createDiagnosticReporter(): ts.DiagnosticReporter {
	const formatHost: ts.FormatDiagnosticsHost = {
		getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
		getCanonicalFileName: (fileName: string) => fileName,
		getNewLine: () => ts.sys.newLine,
	};

	return (diagnostic: ts.Diagnostic) => {
		DiagnosticService.addDiagnostic(diagnostic);

		const message = ts.formatDiagnostic(diagnostic, formatHost);
		LogService.writeLine(message);
	};
}

function createStatusReporter(): ts.DiagnosticReporter {
	const formatHost: ts.FormatDiagnosticsHost = {
		getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
		getCanonicalFileName: (fileName: string) => fileName,
		getNewLine: () => ts.sys.newLine,
	};

	return (diagnostic: ts.Diagnostic) => {
		const message = ts.formatDiagnostic(diagnostic, formatHost);
		LogService.writeLine(message);
	};
}
