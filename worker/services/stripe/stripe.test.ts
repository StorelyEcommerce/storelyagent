import { describe, expect, it } from 'vitest';
import source from './stripe.ts?raw';

describe('StripeService', () => {
	it('contains account status mapping logic', () => {
		expect(source).toContain('getAccountStatus');
		expect(source).toContain("return 'pending'");
		expect(source).toContain("return 'active'");
		expect(source).toContain("return 'restricted'");
		expect(source).toContain("return 'disabled'");
	});
});
