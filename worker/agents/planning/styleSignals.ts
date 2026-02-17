export function extractStyleSignalsFromPrompt(query: string): string[] {
	const q = query.toLowerCase();
	const signals = new Set<string>();

	const patterns: Array<{ label: string; tests: RegExp[] }> = [
		{ label: 'minimalist', tests: [/\bminimal(ist)?\b/, /\bclean\b/, /\bairy\b/, /\bunderstated\b/] },
		{ label: 'luxury/editorial', tests: [/\bluxury\b/, /\bpremium\b/, /\belegant\b/, /\beditorial\b/, /\bhigh[- ]?end\b/, /\brefined\b/, /\bcouture\b/] },
		{ label: 'playful', tests: [/\bplayful\b/, /\bfun\b/, /\bcolorful\b/, /\bkid(s)?\b/, /\bwhimsical\b/] },
		{ label: 'retro/vintage', tests: [/\bretro\b/, /\bvintage\b/, /\bnostalgic\b/, /\b90s\b/, /\b80s\b/, /\by2k\b/] },
		{ label: 'futuristic/tech', tests: [/\bfutur(istic|ism)\b/, /\bcyber\b/, /\btech\b/, /\bneon\b/, /\bglow\b/, /\bscifi\b/, /\bsci[- ]?fi\b/] },
		{ label: 'organic/natural', tests: [/\bnatural\b/, /\borganic\b/, /\bearth(y)?\b/, /\bhandcrafted\b/, /\bbotanical\b/, /\brustic\b/] },
		{ label: 'artisan/handmade', tests: [/\bartisan(al)?\b/, /\bhandmade\b/, /\bcraft(ed)?\b/, /\bsmall[- ]?batch\b/] },
		{ label: 'brutalist', tests: [/\bbrutalis(m|t)\b/, /\braw\b/, /\bindustrial\b/] },
		{ label: 'maximalist', tests: [/\bmaximal(ist)?\b/, /\bopulent\b/, /\bdecorative\b/, /\blayered\b/] },
		{ label: 'streetwear/urban', tests: [/\bstreetwear\b/, /\burban\b/, /\bgrunge\b/, /\bedgy\b/] },
		{ label: 'bold/experimental', tests: [/\bbold\b/, /\bexperimental\b/, /\bunique\b/, /\bunconventional\b/, /\bavant\b/] },
		{ label: 'cozy/warm', tests: [/\bcozy\b/, /\bwarm\b/, /\bsoft\b/, /\bhomely\b/] },
		{ label: 'high-energy', tests: [/\benergetic\b/, /\bhigh[- ]?energy\b/, /\bvibrant\b/, /\bpunchy\b/] },
		{ label: 'dark theme', tests: [/\bdark\b/, /\bmoody\b/, /\bnight\b/] },
	];

	for (const pattern of patterns) {
		if (pattern.tests.some((r) => r.test(q))) {
			signals.add(pattern.label);
		}
	}

	return Array.from(signals);
}
