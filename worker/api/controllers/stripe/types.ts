/**
 * Stripe Connect API Types
 */

/**
 * Stripe Connect account status response
 */
export interface StripeConnectStatusData {
    isConnected: boolean;
    account?: {
        id: string;
        stripeAccountId: string;
        status: 'pending' | 'active' | 'restricted' | 'disabled';
        chargesEnabled: boolean;
        payoutsEnabled: boolean;
        detailsSubmitted: boolean;
        country?: string | null;
        defaultCurrency?: string | null;
    };
}

/**
 * Response when initiating Stripe Connect
 */
export interface StripeConnectInitiateData {
    url: string;
    accountId: string;
}

/**
 * Response for Express dashboard link
 */
export interface StripeConnectDashboardData {
    url: string;
}

/**
 * Response for disconnect operation
 */
export interface StripeConnectDisconnectData {
    success: boolean;
}
