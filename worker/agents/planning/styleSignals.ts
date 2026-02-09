export function extractStyleSignalsFromPrompt(query: string): string[] {
	const q = query.toLowerCase();
	const signals = new Set<string>();

	const patterns: Array<{ label: string; tests: RegExp[] }> = [
		{ label: 'minimalist', tests: [/\bminimal(ist)?\b/, /\bclean\b/, /\bsimple\b/, /\bairy\b/] },
		{ label: 'luxury/editorial', tests: [/\bluxury\b/, /\bpremium\b/, /\belegant\b/, /\beditorial\b/, /\bhigh[- ]?end\b/] },
		{ label: 'playful', tests: [/\bplayful\b/, /\bfun\b/, /\bcolorful\b/, /\bkid(s)?\b/, /\bwhimsical\b/] },
		{ label: 'retro/vintage', tests: [/\bretro\b/, /\bvintage\b/, /\bnostalgic\b/, /\b90s\b/, /\b80s\b/] },
		{ label: 'futuristic/tech', tests: [/\bfutur(istic|ism)\b/, /\bcyber\b/, /\btech\b/, /\bneon\b/, /\bglow\b/] },
		{ label: 'organic/natural', tests: [/\bnatural\b/, /\borganic\b/, /\bearth(y)?\b/, /\bhandcrafted\b/, /\bbotanical\b/] },
		{ label: 'bold/experimental', tests: [/\bbold\b/, /\bexperimental\b/, /\bunique\b/, /\bunconventional\b/, /\bavant\b/] },
		{ label: 'dark theme', tests: [/\bdark\b/, /\bmoody\b/, /\bnight\b/] },
	];

	for (const pattern of patterns) {
		if (pattern.tests.some((r) => r.test(q))) {
			signals.add(pattern.label);
		}
	}

	return Array.from(signals);
}
