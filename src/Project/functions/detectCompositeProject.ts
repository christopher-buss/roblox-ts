import { getParsedCommandLine } from "Project/functions/getParsedCommandLine";
import { ProjectData } from "Shared/types";

export function isCompositeProject(data: ProjectData): boolean {
	const parsed = getParsedCommandLine(data);
	return !!parsed?.options.composite;
}

export function isSolutionContainer(data: ProjectData): boolean {
	const parsed = getParsedCommandLine(data);
	if (!parsed) return false;
	const hasReferences = Array.isArray(parsed.raw?.references);
	const hasNoRootFiles = (parsed.fileNames?.length ?? 0) === 0;
	return hasReferences && hasNoRootFiles;
}

export function shouldUseSolutionBuilder(data: ProjectData): boolean {
	return isCompositeProject(data) || isSolutionContainer(data);
}
