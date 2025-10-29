import path from "path";
import ts from "typescript";

/**
 * Detects whether a TypeScript project should use SolutionBuilder for compilation.
 *
 * A project is considered composite and suitable for SolutionBuilder if:
 * 1. The tsconfig.json has `composite: true` in compilerOptions
 * 2. The tsconfig.json has a `references` array (indicating dependencies on other projects)
 *
 * @param tsConfigPath - Absolute path to the tsconfig.json file
 * @returns true if the project should use SolutionBuilder, false otherwise
 */
export function detectCompositeProject(tsConfigPath: string): boolean {
	try {
		// Read and parse the tsconfig.json
		const configFile = ts.readConfigFile(path.normalize(tsConfigPath), ts.sys.readFile);

		if (configFile.error) {
			// If we can't read the config, fall back to standard compilation
			return false;
		}

		const config = configFile.config;

		// Check for composite flag
		const isComposite = config.compilerOptions?.composite === true;

		// Check for references array (even if empty, indicates solution setup)
		const hasReferences = Array.isArray(config.references);

		// For a project to use SolutionBuilder, it should have either:
		// - composite: true AND references (it's part of a multi-project solution)
		// - references only (it's a solution root file with no sources)

		return isComposite || hasReferences;
	} catch {
		// If any error occurs (invalid JSON, file read error, etc.), fall back to standard compilation
		return false;
	}
}

/**
 * Determines if the given path is a solution root (has references but no source files).
 * Solution roots are typically used as entry points for multi-project builds.
 *
 * @param tsConfigPath - Absolute path to the tsconfig.json file
 * @returns true if this is a solution root file
 */
export function isSolutionRoot(tsConfigPath: string): boolean {
	try {
		const configFile = ts.readConfigFile(path.normalize(tsConfigPath), ts.sys.readFile);

		if (configFile.error) {
			return false;
		}

		const config = configFile.config;

		// Solution roots have references but typically have files: [] or no sources
		const hasReferences = Array.isArray(config.references) && config.references.length > 0;
		const hasNoFiles = Array.isArray(config.files) && config.files.length === 0;
		const hasNoInclude = !config.include || (Array.isArray(config.include) && config.include.length === 0);

		return hasReferences && (hasNoFiles || hasNoInclude);
	} catch {
		return false;
	}
}
