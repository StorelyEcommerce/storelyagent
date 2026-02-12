import { describe, expect, it } from 'vitest';
import { CloudflareLogo, StorelyLogo } from './logos';

describe('storely branding', () => {
	it('keeps CloudflareLogo aliased to StorelyLogo for compatibility', () => {
		expect(CloudflareLogo).toBe(StorelyLogo);
	});
});
