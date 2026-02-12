/**
 * Stripe Connect API Service
 * Handles Stripe API calls for Connect account management
 */

import { createLogger } from '../../logger';

const logger = createLogger('StripeService');

/**
 * Stripe Account object (simplified)
 */
export interface StripeAccount {
    id: string;
    type: 'express' | 'standard' | 'custom';
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
    default_currency?: string;
    country?: string;
    business_profile?: {
        name?: string;
        url?: string;
        mcc?: string;
    };
    requirements?: {
        currently_due: string[];
        eventually_due: string[];
        past_due: string[];
        disabled_reason?: string;
    };
}

/**
 * Stripe Account Link object
 */
export interface StripeAccountLink {
    object: 'account_link';
    created: number;
    expires_at: number;
    url: string;
}

/**
 * Stripe Login Link object
 */
export interface StripeLoginLink {
    object: 'login_link';
    created: number;
    url: string;
}

/**
 * Stripe Connect Service
 * Handles all Stripe API operations for Connect
 */
export class StripeService {
    private apiKey: string;
    private baseUrl = 'https://api.stripe.com/v1';

    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error('Stripe API key is required');
        }
        this.apiKey = apiKey;
    }

    /**
     * Make authenticated request to Stripe API
     */
    private async request<T>(
        endpoint: string,
        options: {
            method?: 'GET' | 'POST' | 'DELETE';
            body?: Record<string, string>;
        } = {}
    ): Promise<T> {
        const { method = 'GET', body } = options;

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.apiKey}`,
        };

        let requestBody: string | undefined;
        if (body) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            requestBody = new URLSearchParams(body).toString();
        }

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method,
            headers,
            body: requestBody,
        });

        const data = await response.json();

        if (!response.ok) {
            const error = data as { error?: { message?: string; type?: string } };
            logger.error('Stripe API error', {
                endpoint,
                status: response.status,
                error: error.error
            });
            throw new Error(error.error?.message || `Stripe API error: ${response.status}`);
        }

        return data as T;
    }

    /**
     * Create a new Express connected account
     */
    async createExpressAccount(options?: {
        country?: string;
        email?: string;
        businessType?: 'individual' | 'company';
    }): Promise<StripeAccount> {
        const body: Record<string, string> = {
            type: 'express',
        };

        if (options?.country) {
            body.country = options.country;
        }
        if (options?.email) {
            body.email = options.email;
        }
        if (options?.businessType) {
            body.business_type = options.businessType;
        }

        // Request transfer capability for receiving funds
        body['capabilities[transfers][requested]'] = 'true';
        body['capabilities[card_payments][requested]'] = 'true';

        logger.info('Creating Express account', { options });

        return this.request<StripeAccount>('/accounts', {
            method: 'POST',
            body,
        });
    }

    /**
     * Retrieve an account
     */
    async getAccount(accountId: string): Promise<StripeAccount> {
        return this.request<StripeAccount>(`/accounts/${accountId}`);
    }

    /**
     * Create an Account Link for onboarding
     */
    async createAccountLink(
        accountId: string,
        refreshUrl: string,
        returnUrl: string
    ): Promise<StripeAccountLink> {
        logger.info('Creating account link', { accountId });

        return this.request<StripeAccountLink>('/account_links', {
            method: 'POST',
            body: {
                account: accountId,
                refresh_url: refreshUrl,
                return_url: returnUrl,
                type: 'account_onboarding',
            },
        });
    }

    /**
     * Create a login link for the Express Dashboard
     */
    async createLoginLink(accountId: string): Promise<StripeLoginLink> {
        return this.request<StripeLoginLink>(`/accounts/${accountId}/login_links`, {
            method: 'POST',
        });
    }

    /**
     * Delete/disconnect a connected account
     */
    async deleteAccount(accountId: string): Promise<{ id: string; deleted: boolean }> {
        logger.info('Deleting account', { accountId });

        return this.request<{ id: string; deleted: boolean }>(`/accounts/${accountId}`, {
            method: 'DELETE',
        });
    }

    /**
     * Determine account status based on Stripe account data
     */
    getAccountStatus(account: StripeAccount): 'pending' | 'active' | 'restricted' | 'disabled' {
        if (!account.details_submitted) {
            return 'pending';
        }

        if (account.requirements?.disabled_reason) {
            return 'disabled';
        }

        if (account.requirements?.currently_due && account.requirements.currently_due.length > 0) {
            return 'restricted';
        }

        if (account.charges_enabled && account.payouts_enabled) {
            return 'active';
        }

        return 'restricted';
    }
}

/**
 * Verify Stripe webhook signature
 */
export async function verifyStripeWebhookSignature(
    payload: string,
    signature: string,
    secret: string
): Promise<boolean> {
    try {
        // Parse the signature header
        const parts = signature.split(',').reduce((acc, part) => {
            const [key, value] = part.split('=');
            if (key && value) {
                acc[key] = value;
            }
            return acc;
        }, {} as Record<string, string>);

        const timestamp = parts['t'];
        const expectedSignature = parts['v1'];

        if (!timestamp || !expectedSignature) {
            return false;
        }

        // Check timestamp is within tolerance (5 minutes)
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp)) > 300) {
            logger.warn('Webhook timestamp out of tolerance');
            return false;
        }

        // Compute expected signature
        const signedPayload = `${timestamp}.${payload}`;
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const signatureBuffer = await crypto.subtle.sign(
            'HMAC',
            key,
            encoder.encode(signedPayload)
        );

        const computedSignature = Array.from(new Uint8Array(signatureBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        return computedSignature === expectedSignature;
    } catch (error) {
        logger.error('Error verifying webhook signature', error);
        return false;
    }
}
