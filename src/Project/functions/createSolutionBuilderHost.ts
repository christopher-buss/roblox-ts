import { LogService } from "Shared/classes/LogService";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

export interface SolutionBuilderHostOptions {
	verbose?: boolean;
	logStatus?: boolean;
	diagnosticReporter?: ts.DiagnosticReporter;
	statusReporter?: ts.DiagnosticReporter;
}

interface LuauCompilationState {
	luauOutputs: Map<string, string>;
	pathMapping: Map<string, string>;
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

	const luauState: LuauCompilationState = {
		luauOutputs: new Map(),
		pathMapping: new Map(),
	};

	const originalWriteFile = defaultHost.writeFile ?? ts.sys.writeFile;
	defaultHost.writeFile = (fileName: string, data: string, writeByteOrderMark: boolean) => {
		if (fileName.endsWith(".js")) {
			const luauCode = luauState.luauOutputs.get(fileName);
			const luauPath = luauState.pathMapping.get(fileName);

			if (luauCode && luauPath) {
				ts.sys.writeFile(luauPath, luauCode, false);
				luauState.luauOutputs.delete(fileName);
				luauState.pathMapping.delete(fileName);
			} else {
				LogService.writeLineIfVerbose(
					`No Luau output registered for ${fileName}, skipping (may be type-only file)`,
				);
			}
			return;
		}

		if (fileName.endsWith(".d.ts") || fileName.endsWith(".d.ts.map")) {
			originalWriteFile(fileName, data, writeByteOrderMark);
			return;
		}

		if (fileName.endsWith(".tsbuildinfo")) {
			originalWriteFile(fileName, data, writeByteOrderMark);
			return;
		}

		originalWriteFile(fileName, data, writeByteOrderMark);
	};

	(defaultHost as SolutionBuilderHostWithLuauState).luauState = luauState;

	return defaultHost;
}

export interface SolutionBuilderHostWithLuauState
	extends ts.SolutionBuilderHost<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
	luauState: LuauCompilationState;
}

export function registerLuauOutput(
	host: ts.SolutionBuilderHost<ts.EmitAndSemanticDiagnosticsBuilderProgram>,
	jsFilePath: string,
	luauFilePath: string,
	luauSource: string,
): void {
	const hostWithState = host as SolutionBuilderHostWithLuauState;
	if (!hostWithState.luauState) {
		throw new Error("Host does not have Luau state - was it created with createSolutionBuilderHost?");
	}

	hostWithState.luauState.luauOutputs.set(jsFilePath, luauSource);
	hostWithState.luauState.pathMapping.set(jsFilePath, luauFilePath);
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
		if (diagnostic.category === ts.DiagnosticCategory.Error) {
			LogService.writeLine(message);
		} else {
			LogService.writeLine(message);
		}
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
