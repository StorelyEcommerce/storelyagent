/**
 * Domain Routes
 * Handles domain availability checking, purchase links, and domain-store linking
 */
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { DomainController } from '../controllers/domain';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';

export function setupDomainRoutes(app: Hono<AppEnv>): void {
    const domainRouter = new Hono<AppEnv>();

    // Check domain availability (public - no auth required)
    domainRouter.get(
        '/check',
        setAuthLevel(AuthConfig.public),
        adaptController(DomainController, DomainController.checkAvailability)
    );

    // Get purchase URL (public)
    domainRouter.get(
        '/purchase-url',
        setAuthLevel(AuthConfig.public),
        adaptController(DomainController, DomainController.getPurchaseUrl)
    );

    // Get user's domains (authenticated)
    domainRouter.get(
        '/mine',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.getUserDomains)
    );

    // Add a domain (authenticated)
    domainRouter.post(
        '/',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.addDomain)
    );

    // Start domain connect flow (authenticated)
    domainRouter.post(
        '/connect',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.connectDomain)
    );

    // Link domain to store (authenticated)
    domainRouter.post(
        '/:id/link',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.linkToStore)
    );

    // Unlink domain from store (authenticated)
    domainRouter.delete(
        '/:id/link',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.unlinkFromStore)
    );

    // Delete domain (authenticated)
    domainRouter.delete(
        '/:id',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.deleteDomain)
    );

    // ========================================
    // SUBDOMAIN (storelyshop.com) ROUTES
    // ========================================

    // Check subdomain availability (authenticated)
    domainRouter.get(
        '/subdomain/check',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.checkSubdomainAvailability)
    );

    // Update app subdomain (authenticated)
    domainRouter.post(
        '/subdomain/:appId',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(DomainController, DomainController.updateSubdomain)
    );

    app.route('/api/domain', domainRouter);
}
