/**
 * Stripe Connect Service
 * Handles CRUD operations for Stripe Connect accounts in the database
 */

import { eq } from 'drizzle-orm';
import { BaseService } from './BaseService';
import { stripeConnectAccounts, StripeConnectAccount, NewStripeConnectAccount } from '../schema';
import { generateId } from '../../utils/idGenerator';

export interface StripeConnectAccountUpdate {
    accountStatus?: 'pending' | 'active' | 'restricted' | 'disabled';
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    detailsSubmitted?: boolean;
    defaultCurrency?: string;
    country?: string;
    businessProfile?: Record<string, unknown>;
}

export class StripeConnectService extends BaseService {
    /**
     * Get a user's connected Stripe account
     */
    async getByUserId(userId: string): Promise<StripeConnectAccount | undefined> {
        try {
            const result = await this.getReadDb().query.stripeConnectAccounts.findFirst({
                where: eq(stripeConnectAccounts.userId, userId),
            });
            return result;
        } catch (error) {
            this.handleDatabaseError(error, 'getByUserId', { userId });
        }
    }

    /**
     * Get a connected account by Stripe account ID
     */
    async getByStripeAccountId(stripeAccountId: string): Promise<StripeConnectAccount | undefined> {
        try {
            const result = await this.getReadDb().query.stripeConnectAccounts.findFirst({
                where: eq(stripeConnectAccounts.stripeAccountId, stripeAccountId),
            });
            return result;
        } catch (error) {
            this.handleDatabaseError(error, 'getByStripeAccountId', { stripeAccountId });
        }
    }

    /**
     * Create a new Stripe Connect account record
     */
    async create(data: {
        userId: string;
        stripeAccountId: string;
        country?: string;
    }): Promise<StripeConnectAccount> {
        try {
            const id = generateId();
            const now = new Date();

            const newAccount: NewStripeConnectAccount = {
                id,
                userId: data.userId,
                stripeAccountId: data.stripeAccountId,
                accountStatus: 'pending',
                chargesEnabled: false,
                payoutsEnabled: false,
                detailsSubmitted: false,
                country: data.country,
                createdAt: now,
                updatedAt: now,
            };

            await this.database.insert(stripeConnectAccounts).values(newAccount);

            const created = await this.getByUserId(data.userId);
            if (!created) {
                throw new Error('Failed to create Stripe Connect account');
            }

            return created;
        } catch (error) {
            this.handleDatabaseError(error, 'create', { userId: data.userId });
        }
    }

    /**
     * Update a Stripe Connect account record
     */
    async update(id: string, data: StripeConnectAccountUpdate): Promise<StripeConnectAccount | undefined> {
        try {
            await this.database
                .update(stripeConnectAccounts)
                .set({
                    ...data,
                    updatedAt: new Date(),
                })
                .where(eq(stripeConnectAccounts.id, id));

            const result = await this.database.query.stripeConnectAccounts.findFirst({
                where: eq(stripeConnectAccounts.id, id),
            });
            return result;
        } catch (error) {
            this.handleDatabaseError(error, 'update', { id, data });
        }
    }

    /**
     * Update by Stripe account ID (used by webhooks)
     */
    async updateByStripeAccountId(
        stripeAccountId: string,
        data: StripeConnectAccountUpdate
    ): Promise<StripeConnectAccount | undefined> {
        try {
            await this.database
                .update(stripeConnectAccounts)
                .set({
                    ...data,
                    updatedAt: new Date(),
                })
                .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId));

            return await this.getByStripeAccountId(stripeAccountId);
        } catch (error) {
            this.handleDatabaseError(error, 'updateByStripeAccountId', { stripeAccountId, data });
        }
    }

    /**
     * Delete a user's Stripe Connect account record
     */
    async deleteByUserId(userId: string): Promise<boolean> {
        try {
            const result = await this.database
                .delete(stripeConnectAccounts)
                .where(eq(stripeConnectAccounts.userId, userId));

            return (result.meta?.changes ?? 0) > 0;
        } catch (error) {
            this.handleDatabaseError(error, 'deleteByUserId', { userId });
        }
    }

    /**
     * Check if a user has an active (can accept payments) Stripe account
     */
    async hasActiveAccount(userId: string): Promise<boolean> {
        const account = await this.getByUserId(userId);
        return account?.chargesEnabled === true && account?.detailsSubmitted === true;
    }
}
