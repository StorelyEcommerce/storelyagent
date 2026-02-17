import { vi } from 'vitest';

import type { FileOutputType, PhaseConceptType } from '../schemas';
import type { TemplateDetails } from '../../services/sandbox/sandboxTypes';
import type { InferenceContext } from '../inferutils/config.types';

const mocked = vi.hoisted(() => ({
	runMock: vi.fn(),
	constructorShouldThrow: false,
}));

vi.mock('../assistants/realtimeCodeFixer', () => {
	return {
		RealtimeCodeFixer: class {
			constructor() {
				if (mocked.constructorShouldThrow) {
					throw new Error('RealtimeCodeFixer constructor failed');
				}
			}

			run = mocked.runMock;
		},
	};
});

import { detectPreDeploySafetyFindings, runPreDeploySafetyGate } from './preDeploySafetyGate';

type PreDeploySafetyGateArgs = Parameters<typeof runPreDeploySafetyGate>[0];

function makeFile(partial: Partial<FileOutputType> & Pick<FileOutputType, 'filePath' | 'fileContents'>): FileOutputType {
	return {
		filePath: partial.filePath,
		fileContents: partial.fileContents,
		filePurpose: partial.filePurpose ?? 'test',
	};
}

function makeArgs(files: FileOutputType[]): PreDeploySafetyGateArgs {
	return {
		files,
		env: {} as unknown as PreDeploySafetyGateArgs['env'],
		inferenceContext: {} as InferenceContext,
		query: 'test query',
		template: { name: 'template', allFiles: {} } as unknown as TemplateDetails,
		phase: { name: 'phase', description: 'desc', files: [] } as unknown as PhaseConceptType,
	};
}

describe('runPreDeploySafetyGate', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mocked.runMock.mockReset();
		mocked.constructorShouldThrow = false;
		warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('never throws on empty input', async () => {
		await expect(runPreDeploySafetyGate(makeArgs([]))).resolves.toEqual([]);
	});

	it('passes through non-script files without invoking fixer', async () => {
		const input = [makeFile({ filePath: 'README.md', fileContents: '# hi' })];
		const out = await runPreDeploySafetyGate(makeArgs(input));
		expect(out).toEqual(input);
		expect(mocked.runMock).not.toHaveBeenCalled();
	});

	it('detects selector object literal findings', () => {
		const findings = detectPreDeploySafetyFindings("const x = useOS(s => ({ a: s.a }));");
		expect(findings.length).toBeGreaterThan(0);
	});

	it('invokes fixer for use* selector returning object literal', async () => {
		mocked.runMock.mockImplementation(async (file: FileOutputType) => {
			return { ...file, fileContents: 'export const a = useOS(s => s.a);' };
		});

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents: "const x = useOS(s => ({ a: s.a }));\nexport default function App() { return null }",
			}),
		];

		const out = await runPreDeploySafetyGate(makeArgs(input));
		expect(out[0].fileContents).toContain('useOS');
		expect(out[0].fileContents).toContain('s => s.a');
		expect(mocked.runMock).toHaveBeenCalledTimes(1);
	});

	it('deterministically splits destructured object selector without invoking fixer', async () => {
		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents:
					"const { a, b } = useOS(s => ({ a: s.a, b: s.b }));\nexport default function App() { return <div>{a + b}</div> }",
			}),
		];

		const out = await runPreDeploySafetyGate(makeArgs(input));
		expect(out[0].fileContents).toContain('const a = useOS');
		expect(out[0].fileContents).toContain('const b = useOS');
		expect(out[0].fileContents).not.toContain('=> ({');
		expect(mocked.runMock).not.toHaveBeenCalled();
	});

	it('invokes fixer for setState in render body', async () => {
		mocked.runMock.mockImplementation(async (file: FileOutputType) => file);

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents:
					"import { useState } from 'react';\nexport function App() { const [x, setX] = useState(0); setX(1); return <div>{x}</div>; }",
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).resolves.toBeTruthy();
		expect(mocked.runMock).toHaveBeenCalledTimes(1);
	});

	it('invokes fixer for useEffect missing deps when setting state', async () => {
		mocked.runMock.mockImplementation(async (file: FileOutputType) => file);

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents:
					"import { useEffect, useState } from 'react';\nexport function App() { const [x,setX] = useState(0); useEffect(() => { setX(1); }); return <div>{x}</div> }",
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).resolves.toBeTruthy();
		expect(mocked.runMock).toHaveBeenCalledTimes(1);
	});

	it('throws if RealtimeCodeFixer constructor throws', async () => {
		mocked.constructorShouldThrow = true;

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents: "const x = useOS(s => ({ a: s.a }));\nexport default function App() { return null }",
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).rejects.toThrow(
			'Failed to initialize realtime code fixer: RealtimeCodeFixer constructor failed',
		);
		expect(mocked.runMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
	});

	it('throws if fixer run rejects', async () => {
		mocked.runMock.mockRejectedValueOnce(new Error('fixer failed'));

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents: "const x = useOS(s => ({ a: s.a }));\nexport default function App() { return null }",
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).rejects.toThrow('fixer failed');
	});

	it('throws if fixer run throws', async () => {
		mocked.runMock.mockImplementationOnce(() => {
			throw new Error('fixer threw');
		});

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents: "const x = useOS(s => ({ a: s.a }));\nexport default function App() { return null }",
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).rejects.toThrow('fixer threw');
	});

	it('throws on invalid syntax', async () => {
		mocked.runMock.mockImplementation(async (file: FileOutputType) => file);

		const input = [
			makeFile({
				filePath: 'src/App.tsx',
				fileContents: 'export const =',
			}),
		];

		await expect(runPreDeploySafetyGate(makeArgs(input))).rejects.toThrow(
			'Failed to parse file during deterministic selector rewrite',
		);
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe('detectPreDeploySafetyFindings', () => {
	it('throws on invalid input', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => detectPreDeploySafetyFindings('<<< not ts >>>')).toThrow(
			'Failed to parse file for safety checks',
		);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
