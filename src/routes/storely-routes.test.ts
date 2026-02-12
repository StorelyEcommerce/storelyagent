import { describe, expect, it } from 'vitest';
import routesSource from '../routes.ts?raw';

describe('storely routes', () => {
	it('includes an admin dashboard route', () => {
		expect(routesSource).toContain("path: 'admin'");
		expect(routesSource).toContain('AdminDashboard');
	});
});
