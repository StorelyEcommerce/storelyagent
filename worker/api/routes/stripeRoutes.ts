/**
 * Stripe Connect Routes
 */
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { StripeController } from '../controllers/stripe';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';

export function setupStripeRoutes(app: Hono<AppEnv>): void {
    const stripeRouter = new Hono<AppEnv>();

    // Get Connect status
    stripeRouter.get(
        '/connect/status',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(StripeController, StripeController.getConnectStatus)
    );

    // Initiate Connect onboarding
    stripeRouter.post(
        '/connect/initiate',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(StripeController, StripeController.initiateConnect)
    );

    // Refresh status after returning from Stripe
    stripeRouter.post(
        '/connect/refresh',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(StripeController, StripeController.refreshStatus)
    );

    // Get Express Dashboard link
    stripeRouter.get(
        '/connect/dashboard',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(StripeController, StripeController.getDashboardLink)
    );

    // Disconnect Stripe account
    stripeRouter.delete(
        '/connect',
        setAuthLevel(AuthConfig.authenticated),
        adaptController(StripeController, StripeController.disconnect)
    );

    // Stripe webhooks (public - verified by signature)
    stripeRouter.post(
        '/webhooks',
        setAuthLevel(AuthConfig.public),
        adaptController(StripeController, StripeController.handleWebhook)
    );

    app.route('/api/stripe', stripeRouter);
}
