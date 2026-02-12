import { describe, expect, it } from 'vitest';
import source from './domain.ts?raw';

describe('DomainService', () => {
	it('keeps storely domain connect provider configuration', () => {
		expect(source).toContain("domainConnectProviderId = 'storelyshop.com'");
		expect(source).toContain("domainConnectServiceId = 'website'");
	});

	it('contains domain connect apply URL builder', () => {
		expect(source).toContain('buildDomainConnectApplyUrl');
		expect(source).toContain('/v2/domainTemplates/providers/');
		expect(source).toContain("applyUrl.searchParams.set('TARGET', targetHost)");
	});
});
