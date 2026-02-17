import traverseImport, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { FileOutputType, PhaseConceptType } from '../schemas';
import type { TemplateDetails } from '../../services/sandbox/sandboxTypes';
import type { InferenceContext } from '../inferutils/config.types';
import { parseCode, generateCode } from '../../services/code-fixer/utils/ast';
import { RealtimeCodeFixer } from '../assistants/realtimeCodeFixer';

const babelTraverse: typeof traverseImport =
	typeof (traverseImport as { default?: unknown }).default === 'function'
		? (traverseImport as { default: typeof traverseImport }).default
		: traverseImport;

export interface SafetyFinding {
	message: string;
	line?: number;
	column?: number;
}

function logSafetyGateError(context: string, error: unknown, extra?: Record<string, unknown>) {
	try {
		const payload = {
			context,
			...extra,
			error:
				error instanceof Error
					? { message: error.message, stack: error.stack }
					: { message: String(error) },
		};
		console.error('[preDeploySafetyGate]', payload);
	} catch {
		// Intentionally swallow all logging failures
	}
}

function getNodeLoc(node: t.Node): { line?: number; column?: number } {
	if (node.loc) {
		return { line: node.loc.start.line, column: node.loc.start.column + 1 };
	}
	return {};
}

function unwrapExpression(expression: t.Expression): t.Expression {
	let current = expression;
	while (true) {
		if (t.isParenthesizedExpression(current)) {
			current = current.expression;
			continue;
		}
		if (t.isTSAsExpression(current)) {
			current = current.expression;
			continue;
		}
		if (t.isTSTypeAssertion(current)) {
			current = current.expression;
			continue;
		}
		if (t.isTSNonNullExpression(current)) {
			current = current.expression;
			continue;
		}
		break;
	}
	return current;
}

function getReturnExpression(fn: t.ArrowFunctionExpression | t.FunctionExpression): t.Expression | null {
	if (t.isExpression(fn.body)) {
		return unwrapExpression(fn.body);
	}
	for (const stmt of fn.body.body) {
		if (t.isReturnStatement(stmt) && stmt.argument && t.isExpression(stmt.argument)) {
			return unwrapExpression(stmt.argument);
		}
	}
	return null;
}

function isUseLikeHookCallee(callee: t.Expression | t.V8IntrinsicIdentifier): callee is t.Identifier {
	return t.isIdentifier(callee) && callee.name.startsWith('use');
}

function isUseEffectCallee(callee: t.Expression | t.V8IntrinsicIdentifier): boolean {
	if (t.isIdentifier(callee) && callee.name === 'useEffect') return true;
	if (t.isMemberExpression(callee) && t.isIdentifier(callee.property) && callee.property.name === 'useEffect') return true;
	return false;
}

type WalkState = {
	inComponent: boolean;
	nestedFunctionDepth: number;
};

function isLikelyComponentFunctionPath(path: NodePath<t.Function>): boolean {
	const node = path.node;
	if (t.isFunctionDeclaration(node)) {
		return Boolean(node.id && /^[A-Z]/.test(node.id.name));
	}
	if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
		const parent = path.parentPath;
		if (parent && parent.isVariableDeclarator()) {
			const id = parent.node.id;
			return t.isIdentifier(id) && /^[A-Z]/.test(id.name);
		}
	}
	return false;
}

function collectSafetyFindings(ast: t.File): SafetyFinding[] {
	const findings: SafetyFinding[] = [];

	let inComponent = false;
	let nestedFunctionDepth = 0;
	let moduleLevelFunctionDepth = 0; // Track ALL function depth for JSX detection
	const stack: WalkState[] = [];

	babelTraverse(ast, {
		noScope: true,
		Function: {
			enter(path) {
				moduleLevelFunctionDepth += 1;
				stack.push({ inComponent, nestedFunctionDepth });

				if (!inComponent && isLikelyComponentFunctionPath(path)) {
					inComponent = true;
					nestedFunctionDepth = 0;
					return;
				}

				if (inComponent) nestedFunctionDepth += 1;
			},
			exit() {
				moduleLevelFunctionDepth -= 1;
				const prev = stack.pop();
				if (!prev) return;
				inComponent = prev.inComponent;
				nestedFunctionDepth = prev.nestedFunctionDepth;
			},
		},
		JSXElement(path) {
			// JSX at module level (not inside any function) is an anti-pattern
			if (moduleLevelFunctionDepth === 0) {
				findings.push({
					message:
						"JSX element at module level. Store component references instead of JSX instances: use { Icon: Component } not { icon: <Component /> }. Module-level JSX causes memory leaks and render issues.",
					...getNodeLoc(path.node),
				});
			}
		},
		CallExpression(path) {
			const node = path.node;
			const { callee, arguments: args } = node;

			// Selector allocations in use* hooks
			if (isUseLikeHookCallee(callee) && args.length > 0) {
				const firstArg = args[0];
				if (t.isArrowFunctionExpression(firstArg) || t.isFunctionExpression(firstArg)) {
					const ret = getReturnExpression(firstArg);
					if (ret) {
						if (t.isObjectExpression(ret) || t.isArrayExpression(ret)) {
							findings.push({
								message:
									"Potential external-store selector instability: a 'use*' hook selector returns a new object/array. This can cause getSnapshot/max-update-depth loops. Rewrite to select a single stable value per hook call and derive objects/arrays outside the selector (e.g. useMemo).",
								...getNodeLoc(node),
							});
						} else if (t.isCallExpression(ret) && t.isMemberExpression(ret.callee)) {
							const member = ret.callee;
							const prop = member.property;

							if (t.isIdentifier(prop) && ['map', 'filter', 'reduce', 'sort', 'slice', 'concat'].includes(prop.name)) {
								findings.push({
									message:
										"Potential external-store selector instability: a 'use*' hook selector returns an allocated array via map/filter/reduce/sort/etc. Select the raw stable collection from the hook and derive with useMemo outside the selector.",
									...getNodeLoc(node),
								});
							}

							if (
								t.isIdentifier(member.object) &&
								member.object.name === 'Object' &&
								t.isIdentifier(prop) &&
								['values', 'keys', 'entries'].includes(prop.name)
							) {
								findings.push({
									message:
										"Potential external-store selector instability: a 'use*' hook selector returns Object.values/keys/entries (allocates a new array). Select the raw object from the hook and derive with useMemo outside the selector.",
									...getNodeLoc(node),
								});
							}
						}
					}
				}
			}

			// setState during render (top-level in component)
			if (inComponent && nestedFunctionDepth === 0 && t.isIdentifier(callee) && /^set[A-Z]/.test(callee.name)) {
				findings.push({
					message:
						"State setter appears to be called during the component render phase (not inside an event handler or effect). This can cause an infinite render loop / 'Maximum update depth exceeded'. Move the state update into a handler or a guarded useEffect.",
					...getNodeLoc(node),
				});
			}

			// useEffect missing deps
			if (isUseEffectCallee(callee)) {
				if (args.length !== 1) return;
				const fn = args[0];
				if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return;
				if (!functionBodyContainsSetState(fn)) return;

				findings.push({
					message:
						"useEffect that sets state is missing a dependency array. This is a common cause of 'Maximum update depth exceeded'. Add a deps array and guard the state update.",
					...getNodeLoc(node),
				});
			}
		},
	});

	return findings;
}


function functionBodyContainsSetState(fn: t.ArrowFunctionExpression | t.FunctionExpression): boolean {
	let found = false;
	const bodyNode: t.Node = t.isBlockStatement(fn.body) ? fn.body : t.expressionStatement(fn.body);

	babelTraverse(bodyNode, {
		noScope: true,
		CallExpression(path) {
			const callee = path.node.callee;
			if (t.isIdentifier(callee) && /^set[A-Z]/.test(callee.name)) {
				found = true;
				path.stop();
			}
		},
	});

	return found;
}

export function detectPreDeploySafetyFindings(code: string): SafetyFinding[] {
	let ast: t.File;
	try {
		ast = parseCode(code);
	} catch (error) {
		logSafetyGateError('parseCode failed in detectPreDeploySafetyFindings', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse file for safety checks: ${message}`);
	}

	try {
		return collectSafetyFindings(ast);
	} catch (error) {
		logSafetyGateError('collectSafetyFindings failed', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to collect pre-deploy safety findings: ${message}`);
	}
}

function tryDeterministicSplitObjectSelectorDestructuring(code: string): { code: string; changed: boolean } {
	let ast: t.File;
	try {
		ast = parseCode(code);
	} catch (error) {
		logSafetyGateError('parseCode failed in deterministic split', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse file during deterministic selector rewrite: ${message}`);
	}

	let changed = false;

	function tryRewriteVariableDeclaration(decl: t.VariableDeclaration): t.VariableDeclaration[] | null {
		if (decl.declarations.length !== 1) return null;
		const d = decl.declarations[0];
		if (!t.isVariableDeclarator(d)) return null;
		if (!t.isObjectPattern(d.id)) return null;
		if (!d.init || !t.isCallExpression(d.init)) return null;
		if (!t.isIdentifier(d.init.callee) || !d.init.callee.name.startsWith('use')) return null;

		const hookName = d.init.callee.name;
		const selectorArg = d.init.arguments[0];
		if (!selectorArg || (!t.isArrowFunctionExpression(selectorArg) && !t.isFunctionExpression(selectorArg))) return null;

		const ret = getReturnExpression(selectorArg);
		if (!ret || !t.isObjectExpression(ret)) return null;

		const param = selectorArg.params[0];
		if (!param || !t.isIdentifier(param)) return null;

		const objectProps: Array<{ key: string; memberProp: string }> = [];
		for (const prop of ret.properties) {
			if (!t.isObjectProperty(prop) || prop.computed) return null;
			const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
			if (!key) return null;
			if (!t.isMemberExpression(prop.value) || prop.value.computed) return null;
			if (!t.isIdentifier(prop.value.object) || prop.value.object.name !== param.name) return null;
			if (!t.isIdentifier(prop.value.property)) return null;
			objectProps.push({ key, memberProp: prop.value.property.name });
		}

		const destructured = new Map<string, string>();
		for (const p of d.id.properties) {
			if (!t.isObjectProperty(p) || p.computed) return null;
			const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
			if (!key) return null;
			const local = t.isIdentifier(p.value) ? p.value.name : null;
			if (!local) return null;
			destructured.set(key, local);
		}

		const replacements: t.VariableDeclaration[] = [];
		for (const { key, memberProp } of objectProps) {
			const localName = destructured.get(key);
			if (!localName) return null;
			replacements.push(
				t.variableDeclaration(decl.kind, [
					t.variableDeclarator(
						t.identifier(localName),
						t.callExpression(t.identifier(hookName), [
							t.arrowFunctionExpression(
								[t.identifier(param.name)],
								t.memberExpression(t.identifier(param.name), t.identifier(memberProp)),
							)
						]),
					),
				]),
			);
		}

		return replacements.length > 0 ? replacements : null;
	}

	try {
		babelTraverse(ast, {
			noScope: true,
			VariableDeclaration(path) {
				// Preserve previous behavior: only rewrite declarations that are direct statements
				// in Program/BlockStatement bodies (avoid rewriting in for-loop init, etc.).
				const parentPath = path.parentPath;
				if (!parentPath) return;
				if (!parentPath.isProgram() && !parentPath.isBlockStatement()) return;

				const replacements = tryRewriteVariableDeclaration(path.node);
				if (!replacements) return;

				path.replaceWithMultiple(replacements);
				changed = true;
				path.skip();
			},
		});
	} catch (error) {
		logSafetyGateError('deterministic split rewrite failed', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed deterministic selector rewrite traversal: ${message}`);
	}

	if (!changed) return { code, changed: false };
	try {
		return { code: generateCode(ast).code, changed: true };
	} catch (error) {
		logSafetyGateError('generateCode failed in deterministic split', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to generate code after deterministic selector rewrite: ${message}`);
	}
}

export async function runPreDeploySafetyGate(args: {
	files: FileOutputType[];
	env: Env;
	inferenceContext: InferenceContext;
	query: string;
	template: TemplateDetails;
	phase: PhaseConceptType;
}): Promise<FileOutputType[]> {
	try {
		const updatedFiles: FileOutputType[] = [];
		const needsFixer: Array<{ file: FileOutputType; findings: SafetyFinding[] }> = [];

		for (const file of args.files) {
			if (!/\.(ts|tsx|js|jsx)$/.test(file.filePath)) {
				updatedFiles.push(file);
				continue;
			}

			const splitResult = tryDeterministicSplitObjectSelectorDestructuring(file.fileContents);
			const afterDeterministic = splitResult.changed ? splitResult.code : file.fileContents;

			const secondFindings = detectPreDeploySafetyFindings(afterDeterministic);

			const updated: FileOutputType = splitResult.changed ? { ...file, fileContents: afterDeterministic } : file;
			updatedFiles.push(updated);

			if (secondFindings.length > 0) {
				needsFixer.push({ file: updated, findings: secondFindings });
			}
		}

		if (needsFixer.length === 0) {
			return updatedFiles;
		}

		let realtimeCodeFixer: RealtimeCodeFixer;
		try {
			realtimeCodeFixer = new RealtimeCodeFixer(args.env, args.inferenceContext);
		} catch (error) {
			logSafetyGateError('RealtimeCodeFixer constructor failed', error);
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to initialize realtime code fixer: ${message}`);
		}

		const fixedResults = await Promise.all(
			needsFixer.map(async ({ file, findings }) => {
				const issuesText = findings.map((f) => {
					const loc = f.line
						? `${file.filePath}:${f.line}${typeof f.column === 'number' ? `:${f.column}` : ''}`
						: file.filePath;
					return `${loc} - ${f.message}`;
				});

				return await realtimeCodeFixer.run(
					file,
					{ query: args.query, template: args.template },
					// args.phase,
					undefined,
					issuesText,
					3,
				);
			}),
		);

		const fixedByPath = new Map<string, FileOutputType>();
		for (const fixedFile of fixedResults) {
			fixedByPath.set(fixedFile.filePath, fixedFile);
		}

		return updatedFiles.map((f) => fixedByPath.get(f.filePath) ?? f);
	} catch (error) {
		logSafetyGateError('runPreDeploySafetyGate unexpected failure', error);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Pre-deploy safety gate failed: ${message}`);
	}
}
