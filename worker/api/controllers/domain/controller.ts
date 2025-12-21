/**
 * Domain Controller
 * Handles domain availability checking, purchase links, and domain-store linking
 */

import { BaseController } from '../baseController';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { DomainService } from '../../../services/domain';
import { UserDomainService } from '../../../database/services/UserDomainService';
import { AppService } from '../../../database/services/AppService';
import { getPreviewDomain } from '../../../utils/urls';
import type {
    DomainCheckData,
    DomainPurchaseUrlData,
    UserDomainsListData,
    DomainLinkData,
    DomainDeleteData,
    DomainCreateData,
    DomainConnectData,
    SubdomainCheckData,
    SubdomainUpdateData,
} from './types';

export class DomainController extends BaseController {
    /**
     * Check domain availability
     * GET /api/domain/check?domain=
     */
    static async checkAvailability(
        request: Request,
        _env: Env,
        _ctx: ExecutionContext,
        _context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainCheckData>>> {
        try {
            const url = new URL(request.url);
            const domain = url.searchParams.get('domain');

            if (!domain) {
                return DomainController.createErrorResponse<DomainCheckData>(
                    'Domain parameter is required',
                    400
                );
            }

            const domainService = new DomainService();
            const result = await domainService.checkAvailability(domain);

            // Generate suggestions if checking availability
            const suggestions = domainService.generateSuggestions(domain.split('.')[0] || domain);

            const data: DomainCheckData = {
                domain: result.domain,
                available: result.available,
                suggestions: suggestions.map(s => ({ domain: s, available: false })), // Suggestions don't have availability checked
                purchaseUrl: result.available ? domainService.getPurchaseUrl(result.domain) : undefined,
                error: result.error,
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error checking domain availability', error);
            return DomainController.createErrorResponse<DomainCheckData>(
                'Failed to check domain availability',
                500
            );
        }
    }

    /**
     * Get a purchase URL for a domain
     * GET /api/domain/purchase-url?domain=
     */
    static async getPurchaseUrl(
        request: Request,
        _env: Env,
        _ctx: ExecutionContext,
        _context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainPurchaseUrlData>>> {
        try {
            const url = new URL(request.url);
            const domain = url.searchParams.get('domain');

            if (!domain) {
                return DomainController.createErrorResponse<DomainPurchaseUrlData>(
                    'Domain parameter is required',
                    400
                );
            }

            const domainService = new DomainService();
            const purchaseUrl = domainService.getPurchaseUrl(domain);

            const data: DomainPurchaseUrlData = {
                domain,
                url: purchaseUrl,
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error getting purchase URL', error);
            return DomainController.createErrorResponse<DomainPurchaseUrlData>(
                'Failed to get purchase URL',
                500
            );
        }
    }

    /**
     * Get user's domains
     * GET /api/domain/mine
     */
    static async getUserDomains(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<UserDomainsListData>>> {
        try {
            const user = context.user!;
            const domainDbService = new UserDomainService(env);
            const domains = await domainDbService.getByUserId(user.id);

            const data: UserDomainsListData = {
                domains: domains.map(d => ({
                    id: d.id,
                    domain: d.domain,
                    status: d.status as 'pending' | 'verified' | 'active' | 'expired',
                    appId: d.appId,
                    app: d.app || null,
                    createdAt: d.createdAt,
                })),
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error getting user domains', error);
            return DomainController.createErrorResponse<UserDomainsListData>(
                'Failed to get domains',
                500
            );
        }
    }

    /**
     * Add a domain (manual flow)
     * POST /api/domain
     */
    static async addDomain(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainCreateData>>> {
        try {
            const user = context.user!;
            const body = await request.json() as { domain: string; appId?: string };

            if (!body.domain) {
                return DomainController.createErrorResponse<DomainCreateData>(
                    'Domain is required',
                    400
                );
            }

            const domainDbService = new UserDomainService(env);

            // Check if domain already exists
            const existing = await domainDbService.getByDomain(body.domain);
            if (existing) {
                return DomainController.createErrorResponse<DomainCreateData>(
                    'Domain is already registered',
                    409
                );
            }

            const newDomain = await domainDbService.create({
                userId: user.id,
                domain: body.domain,
                appId: body.appId,
            });

            const data: DomainCreateData = {
                success: true,
                domain: {
                    id: newDomain.id,
                    domain: newDomain.domain,
                    status: newDomain.status as 'pending' | 'verified' | 'active' | 'expired',
                    appId: newDomain.appId,
                    app: null,
                    createdAt: newDomain.createdAt,
                },
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error adding domain', error);
            return DomainController.createErrorResponse<DomainCreateData>(
                'Failed to add domain',
                500
            );
        }
    }

    /**
     * Start domain connect flow (Domain Connect if available, otherwise manual)
     * POST /api/domain/connect
     */
    static async connectDomain(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainConnectData>>> {
        try {
            const user = context.user!;
            const body = await request.json() as { domain: string; appId: string };

            if (!body.domain || !body.appId) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'Domain and app ID are required',
                    400
                );
            }

            const domainService = new DomainService();
            const normalizedDomain = domainService.normalizeDomain(body.domain);
            if (!domainService.isValidDomain(normalizedDomain)) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'Invalid domain format',
                    400
                );
            }

            const appService = new AppService(env);
            const ownership = await appService.checkAppOwnership(body.appId, user.id);
            if (!ownership.exists) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'App not found',
                    404
                );
            }
            if (!ownership.isOwner) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'You do not own this app',
                    403
                );
            }

            const appDetails = await appService.getAppDetails(body.appId, user.id);
            if (!appDetails?.deploymentId) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'Deploy your store before connecting a custom domain',
                    400
                );
            }

            const previewDomain = getPreviewDomain(env);
            if (!previewDomain) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'Custom domain support is not configured',
                    500
                );
            }

            const targetHost = `${appDetails.deploymentId}.${previewDomain}`;
            const domainDbService = new UserDomainService(env);

            let existing = await domainDbService.getByDomain(normalizedDomain);
            if (existing && existing.userId !== user.id) {
                return DomainController.createErrorResponse<DomainConnectData>(
                    'Domain is already registered to another account',
                    409
                );
            }

            if (!existing) {
                existing = await domainDbService.create({
                    userId: user.id,
                    domain: normalizedDomain,
                    appId: body.appId,
                });
            } else {
                await domainDbService.update(existing.id, user.id, { appId: body.appId, status: 'pending' });
                const refreshed = await domainDbService.getById(existing.id);
                if (!refreshed) {
                    throw new Error('Failed to refresh domain record');
                }
                existing = refreshed;
            }

            const connectSupport = await domainService.discoverDomainConnect(normalizedDomain);
            const hasDomainConnect = !!connectSupport?.settings.urlSyncUX;
            const mode = hasDomainConnect ? 'domain-connect' : 'manual';
            const applyUrl = hasDomainConnect && connectSupport
                ? domainService.buildDomainConnectApplyUrl(connectSupport.settings, normalizedDomain, targetHost)
                : undefined;

            const data: DomainConnectData = {
                mode,
                domain: {
                    id: existing.id,
                    domain: existing.domain,
                    status: existing.status as 'pending' | 'verified' | 'active' | 'expired',
                    appId: existing.appId,
                    app: null,
                    createdAt: existing.createdAt,
                },
                targetHost,
                applyUrl: applyUrl || undefined,
                provider: connectSupport ? {
                    id: connectSupport.settings.providerId,
                    name: connectSupport.settings.providerName,
                    displayName: connectSupport.settings.providerDisplayName,
                } : undefined,
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error starting domain connect flow', error);
            return DomainController.createErrorResponse<DomainConnectData>(
                'Failed to start domain connection',
                500
            );
        }
    }

    /**
     * Link domain to a store
     * POST /api/domain/:id/link
     */
    static async linkToStore(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainLinkData>>> {
        try {
            const user = context.user!;
            const url = new URL(request.url);
            const domainId = url.pathname.split('/').slice(-2)[0]; // Get ID from /api/domain/:id/link
            const body = await request.json() as { appId: string };

            if (!body.appId) {
                return DomainController.createErrorResponse<DomainLinkData>(
                    'App ID is required',
                    400
                );
            }

            const domainDbService = new UserDomainService(env);
            const updated = await domainDbService.linkToApp(domainId, user.id, body.appId);

            if (!updated) {
                return DomainController.createErrorResponse<DomainLinkData>(
                    'Domain not found or access denied',
                    404
                );
            }

            const data: DomainLinkData = {
                success: true,
                domain: {
                    id: updated.id,
                    domain: updated.domain,
                    status: updated.status as 'pending' | 'verified' | 'active' | 'expired',
                    appId: updated.appId,
                    app: null, // Would need to fetch app details
                    createdAt: updated.createdAt,
                },
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error linking domain to store', error);
            return DomainController.createErrorResponse<DomainLinkData>(
                'Failed to link domain',
                500
            );
        }
    }

    /**
     * Unlink domain from store
     * DELETE /api/domain/:id/link
     */
    static async unlinkFromStore(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainLinkData>>> {
        try {
            const user = context.user!;
            const url = new URL(request.url);
            const domainId = url.pathname.split('/').slice(-2)[0];

            const domainDbService = new UserDomainService(env);
            const updated = await domainDbService.unlinkFromApp(domainId, user.id);

            if (!updated) {
                return DomainController.createErrorResponse<DomainLinkData>(
                    'Domain not found or access denied',
                    404
                );
            }

            const data: DomainLinkData = {
                success: true,
                domain: {
                    id: updated.id,
                    domain: updated.domain,
                    status: updated.status as 'pending' | 'verified' | 'active' | 'expired',
                    appId: updated.appId,
                    app: null,
                    createdAt: updated.createdAt,
                },
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error unlinking domain from store', error);
            return DomainController.createErrorResponse<DomainLinkData>(
                'Failed to unlink domain',
                500
            );
        }
    }

    /**
     * Delete a domain
     * DELETE /api/domain/:id
     */
    static async deleteDomain(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<DomainDeleteData>>> {
        try {
            const user = context.user!;
            const url = new URL(request.url);
            const domainId = url.pathname.split('/').pop()!;

            const domainDbService = new UserDomainService(env);
            const success = await domainDbService.delete(domainId, user.id);

            if (!success) {
                return DomainController.createErrorResponse<DomainDeleteData>(
                    'Domain not found or access denied',
                    404
                );
            }

            return DomainController.createSuccessResponse({ success: true });
        } catch (error) {
            this.logger.error('Error deleting domain', error);
            return DomainController.createErrorResponse<DomainDeleteData>(
                'Failed to delete domain',
                500
            );
        }
    }

    // ========================================
    // SUBDOMAIN (storelyshop.com) OPERATIONS
    // ========================================

    // Reserved subdomains that cannot be claimed
    private static readonly RESERVED_SUBDOMAINS = new Set([
        'www', 'api', 'admin', 'app', 'mail', 'support', 'help',
        'docs', 'blog', 'store', 'shop', 'test', 'staging', 'dev',
        'cdn', 'assets', 'static', 'images', 'files', 'download',
        'auth', 'login', 'signup', 'register', 'account', 'dashboard',
        'billing', 'payment', 'checkout', 'cart', 'orders', 'products',
        'storely', 'storelyshop', 'storefront', 'merchant', 'seller'
    ]);

    /**
     * Validate subdomain format
     */
    private static validateSubdomain(subdomain: string): { valid: boolean; reason?: string } {
        if (!subdomain || subdomain.length < 3) {
            return { valid: false, reason: 'Subdomain must be at least 3 characters' };
        }
        if (subdomain.length > 32) {
            return { valid: false, reason: 'Subdomain must be 32 characters or less' };
        }
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain.toLowerCase())) {
            return { valid: false, reason: 'Subdomain can only contain lowercase letters, numbers, and hyphens (cannot start or end with hyphen)' };
        }
        if (subdomain.includes('--')) {
            return { valid: false, reason: 'Subdomain cannot contain consecutive hyphens' };
        }
        if (DomainController.RESERVED_SUBDOMAINS.has(subdomain.toLowerCase())) {
            return { valid: false, reason: 'This subdomain is reserved' };
        }
        return { valid: true };
    }

    /**
     * Check subdomain availability
     * GET /api/domain/subdomain/check?subdomain=
     */
    static async checkSubdomainAvailability(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        _context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<SubdomainCheckData>>> {
        try {
            const url = new URL(request.url);
            const subdomain = url.searchParams.get('subdomain');

            if (!subdomain) {
                return DomainController.createErrorResponse<SubdomainCheckData>(
                    'Subdomain parameter is required',
                    400
                );
            }

            const normalizedSubdomain = subdomain.toLowerCase();

            // Validate format first
            const validation = DomainController.validateSubdomain(normalizedSubdomain);
            if (!validation.valid) {
                return DomainController.createSuccessResponse<SubdomainCheckData>({
                    subdomain: normalizedSubdomain,
                    available: false,
                    reason: validation.reason
                });
            }

            // Check if taken
            const { AppService } = await import('../../../database/services/AppService');
            const appService = new AppService(env);
            const available = await appService.isSubdomainAvailable(normalizedSubdomain);

            const data: SubdomainCheckData = {
                subdomain: normalizedSubdomain,
                available,
                reason: available ? undefined : 'Subdomain is already taken'
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error checking subdomain availability', error);
            return DomainController.createErrorResponse<SubdomainCheckData>(
                'Failed to check subdomain availability',
                500
            );
        }
    }

    /**
     * Update app subdomain
     * POST /api/domain/subdomain/:appId
     */
    static async updateSubdomain(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<SubdomainUpdateData>>> {
        try {
            const user = context.user!;
            const url = new URL(request.url);
            const appId = url.pathname.split('/').pop()!;
            const body = await request.json() as { subdomain: string };

            if (!body.subdomain) {
                return DomainController.createErrorResponse<SubdomainUpdateData>(
                    'Subdomain is required',
                    400
                );
            }

            const normalizedSubdomain = body.subdomain.toLowerCase();

            // Validate format
            const validation = DomainController.validateSubdomain(normalizedSubdomain);
            if (!validation.valid) {
                return DomainController.createErrorResponse<SubdomainUpdateData>(
                    validation.reason || 'Invalid subdomain format',
                    400
                );
            }

            // Update subdomain
            const { AppService } = await import('../../../database/services/AppService');
            const appService = new AppService(env);
            const result = await appService.updateSubdomain(appId, user.id, normalizedSubdomain);

            if (!result.success) {
                return DomainController.createErrorResponse<SubdomainUpdateData>(
                    result.error || 'Failed to update subdomain',
                    result.error === 'App not found' ? 404 :
                        result.error === 'You do not own this app' ? 403 : 409
                );
            }

            // Build the store URL using the preview domain
            const { getPreviewDomain } = await import('../../../utils/urls');
            const previewDomain = getPreviewDomain(env);
            const storeUrl = `https://${normalizedSubdomain}.${previewDomain}`;

            const data: SubdomainUpdateData = {
                success: true,
                subdomain: normalizedSubdomain,
                storeUrl
            };

            return DomainController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error updating subdomain', error);
            return DomainController.createErrorResponse<SubdomainUpdateData>(
                'Failed to update subdomain',
                500
            );
        }
    }
}
