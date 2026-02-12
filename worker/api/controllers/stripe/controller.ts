/**
 * Stripe Connect Controller
 * Handles Stripe Connect account operations
 */

import { BaseController } from '../baseController';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { StripeService, verifyStripeWebhookSignature } from '../../../services/stripe';
import { StripeConnectService } from '../../../database/services/StripeConnectService';
import type {
    StripeConnectStatusData,
    StripeConnectInitiateData,
    StripeConnectDashboardData,
    StripeConnectDisconnectData,
} from './types';

export class StripeController extends BaseController {
    /**
     * Get Stripe Connect status for the current user
     * GET /api/stripe/connect/status
     */
    static async getConnectStatus(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<StripeConnectStatusData>>> {
        try {
            const user = context.user!;

            const connectService = new StripeConnectService(env);
            const account = await connectService.getByUserId(user.id);

            const data: StripeConnectStatusData = account
                ? {
                    isConnected: true,
                    account: {
                        id: account.id,
                        stripeAccountId: account.stripeAccountId,
                        status: account.accountStatus as 'pending' | 'active' | 'restricted' | 'disabled',
                        chargesEnabled: account.chargesEnabled ?? false,
                        payoutsEnabled: account.payoutsEnabled ?? false,
                        detailsSubmitted: account.detailsSubmitted ?? false,
                        country: account.country,
                        defaultCurrency: account.defaultCurrency,
                    },
                }
                : { isConnected: false };

            return StripeController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error getting Connect status', error);
            return StripeController.createErrorResponse<StripeConnectStatusData>(
                'Failed to get Stripe Connect status',
                500
            );
        }
    }

    /**
     * Initiate Stripe Connect onboarding
     * POST /api/stripe/connect/initiate
     */
    static async initiateConnect(
        request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<StripeConnectInitiateData>>> {
        try {
            const user = context.user!;

            const stripeKey = env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
                return StripeController.createErrorResponse<StripeConnectInitiateData>(
                    'Stripe is not configured',
                    500
                );
            }

            const connectService = new StripeConnectService(env);
            const stripeService = new StripeService(stripeKey);

            // Check if user already has a connected account
            let account = await connectService.getByUserId(user.id);
            let stripeAccountId: string;

            if (account) {
                // Use existing Stripe account
                stripeAccountId = account.stripeAccountId;
            } else {
                // Create new Express account
                const stripeAccount = await stripeService.createExpressAccount({
                    email: user.email,
                    country: 'US',
                });

                // Save to database
                account = await connectService.create({
                    userId: user.id,
                    stripeAccountId: stripeAccount.id,
                    country: stripeAccount.country,
                });

                stripeAccountId = stripeAccount.id;
            }

            // Generate onboarding link
            const baseUrl = new URL(request.url).origin;
            const refreshUrl = `${baseUrl}/settings?stripe_refresh=true`;
            const returnUrl = `${baseUrl}/settings?stripe_return=true`;

            const accountLink = await stripeService.createAccountLink(
                stripeAccountId,
                refreshUrl,
                returnUrl
            );

            const data: StripeConnectInitiateData = {
                url: accountLink.url,
                accountId: stripeAccountId,
            };

            return StripeController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error initiating Stripe Connect', error);
            return StripeController.createErrorResponse<StripeConnectInitiateData>(
                'Failed to initiate Stripe Connect',
                500
            );
        }
    }

    /**
     * Refresh the account status after returning from Stripe
     * POST /api/stripe/connect/refresh
     */
    static async refreshStatus(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<StripeConnectStatusData>>> {
        try {
            const user = context.user!;

            const stripeKey = env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
                return StripeController.createErrorResponse<StripeConnectStatusData>(
                    'Stripe is not configured',
                    500
                );
            }

            const connectService = new StripeConnectService(env);
            const stripeService = new StripeService(stripeKey);

            const account = await connectService.getByUserId(user.id);
            if (!account) {
                return StripeController.createErrorResponse<StripeConnectStatusData>(
                    'No connected account found',
                    404
                );
            }

            // Fetch latest status from Stripe
            const stripeAccount = await stripeService.getAccount(account.stripeAccountId);
            const status = stripeService.getAccountStatus(stripeAccount);

            // Update database
            await connectService.update(account.id, {
                accountStatus: status,
                chargesEnabled: stripeAccount.charges_enabled,
                payoutsEnabled: stripeAccount.payouts_enabled,
                detailsSubmitted: stripeAccount.details_submitted,
                defaultCurrency: stripeAccount.default_currency,
                country: stripeAccount.country,
                businessProfile: stripeAccount.business_profile as Record<string, unknown>,
            });

            // Return updated status
            const data: StripeConnectStatusData = {
                isConnected: true,
                account: {
                    id: account.id,
                    stripeAccountId: account.stripeAccountId,
                    status,
                    chargesEnabled: stripeAccount.charges_enabled,
                    payoutsEnabled: stripeAccount.payouts_enabled,
                    detailsSubmitted: stripeAccount.details_submitted,
                    country: stripeAccount.country,
                    defaultCurrency: stripeAccount.default_currency,
                },
            };

            return StripeController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error refreshing Connect status', error);
            return StripeController.createErrorResponse<StripeConnectStatusData>(
                'Failed to refresh status',
                500
            );
        }
    }

    /**
     * Get Express Dashboard login link
     * GET /api/stripe/connect/dashboard
     */
    static async getDashboardLink(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<StripeConnectDashboardData>>> {
        try {
            const user = context.user!;

            const stripeKey = env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
                return StripeController.createErrorResponse<StripeConnectDashboardData>(
                    'Stripe is not configured',
                    500
                );
            }

            const connectService = new StripeConnectService(env);
            const stripeService = new StripeService(stripeKey);

            const account = await connectService.getByUserId(user.id);
            if (!account) {
                return StripeController.createErrorResponse<StripeConnectDashboardData>(
                    'No connected account found',
                    404
                );
            }

            const loginLink = await stripeService.createLoginLink(account.stripeAccountId);

            const data: StripeConnectDashboardData = {
                url: loginLink.url,
            };

            return StripeController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error getting dashboard link', error);
            return StripeController.createErrorResponse<StripeConnectDashboardData>(
                'Failed to get dashboard link',
                500
            );
        }
    }

    /**
     * Disconnect Stripe account
     * DELETE /api/stripe/connect
     */
    static async disconnect(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<StripeConnectDisconnectData>>> {
        try {
            const user = context.user!;

            const stripeKey = env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
                return StripeController.createErrorResponse<StripeConnectDisconnectData>(
                    'Stripe is not configured',
                    500
                );
            }

            const connectService = new StripeConnectService(env);
            const stripeService = new StripeService(stripeKey);

            const account = await connectService.getByUserId(user.id);
            if (!account) {
                return StripeController.createErrorResponse<StripeConnectDisconnectData>(
                    'No connected account found',
                    404
                );
            }

            // Delete from Stripe
            try {
                await stripeService.deleteAccount(account.stripeAccountId);
            } catch (error) {
                // Log but continue - account might already be deleted on Stripe's side
                this.logger.warn('Failed to delete Stripe account (may already be deleted)', {
                    accountId: account.stripeAccountId,
                    error,
                });
            }

            // Delete from database
            await connectService.deleteByUserId(user.id);

            const data: StripeConnectDisconnectData = {
                success: true,
            };

            return StripeController.createSuccessResponse(data);
        } catch (error) {
            this.logger.error('Error disconnecting Stripe account', error);
            return StripeController.createErrorResponse<StripeConnectDisconnectData>(
                'Failed to disconnect Stripe account',
                500
            );
        }
    }

    /**
     * Handle Stripe webhooks
     * POST /api/stripe/webhooks
     */
    static async handleWebhook(
        request: Request,
        env: Env,
        _ctx: ExecutionContext
    ): Promise<ControllerResponse<ApiResponse<{ received: boolean }>>> {
        try {
            const stripeKey = env.STRIPE_SECRET_KEY;
            const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

            if (!stripeKey || !webhookSecret) {
                return StripeController.createErrorResponse<{ received: boolean }>(
                    'Stripe webhooks not configured',
                    500
                );
            }

            const signature = request.headers.get('stripe-signature');
            if (!signature) {
                return StripeController.createErrorResponse<{ received: boolean }>(
                    'Missing signature',
                    400
                );
            }

            const payload = await request.text();

            // Verify webhook signature
            const isValid = await verifyStripeWebhookSignature(payload, signature, webhookSecret);
            if (!isValid) {
                this.logger.warn('Invalid webhook signature');
                return StripeController.createErrorResponse<{ received: boolean }>(
                    'Invalid signature',
                    400
                );
            }

            const event = JSON.parse(payload) as {
                type: string;
                data: { object: Record<string, unknown> };
            };

            this.logger.info('Received Stripe webhook', { type: event.type });

            // Handle account.updated events
            if (event.type === 'account.updated') {
                const stripeAccount = event.data.object as {
                    id: string;
                    charges_enabled: boolean;
                    payouts_enabled: boolean;
                    details_submitted: boolean;
                    default_currency?: string;
                    country?: string;
                    business_profile?: Record<string, unknown>;
                    requirements?: {
                        disabled_reason?: string;
                        currently_due?: string[];
                    };
                };

                const connectService = new StripeConnectService(env);

                // Determine status
                let status: 'pending' | 'active' | 'restricted' | 'disabled' = 'pending';
                if (!stripeAccount.details_submitted) {
                    status = 'pending';
                } else if (stripeAccount.requirements?.disabled_reason) {
                    status = 'disabled';
                } else if (stripeAccount.requirements?.currently_due?.length) {
                    status = 'restricted';
                } else if (stripeAccount.charges_enabled && stripeAccount.payouts_enabled) {
                    status = 'active';
                } else {
                    status = 'restricted';
                }

                await connectService.updateByStripeAccountId(stripeAccount.id, {
                    accountStatus: status,
                    chargesEnabled: stripeAccount.charges_enabled,
                    payoutsEnabled: stripeAccount.payouts_enabled,
                    detailsSubmitted: stripeAccount.details_submitted,
                    defaultCurrency: stripeAccount.default_currency,
                    country: stripeAccount.country,
                    businessProfile: stripeAccount.business_profile,
                });

                this.logger.info('Updated account from webhook', {
                    accountId: stripeAccount.id,
                    status,
                });
            }

            return StripeController.createSuccessResponse({ received: true });
        } catch (error) {
            this.logger.error('Error handling webhook', error);
            return StripeController.createErrorResponse<{ received: boolean }>(
                'Webhook processing failed',
                500
            );
        }
    }
}
