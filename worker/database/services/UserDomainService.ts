/**
 * User Domain Service
 * Handles CRUD operations for user domains in the database
 */

import { eq, and } from 'drizzle-orm';
import { BaseService } from './BaseService';
import { userDomains, UserDomain, NewUserDomain, apps } from '../schema';
import { generateId } from '../../utils/idGenerator';

export interface UserDomainUpdate {
    appId?: string | null;
    status?: 'pending' | 'verified' | 'active' | 'expired';
}

export interface UserDomainWithApp extends UserDomain {
    app?: {
        id: string;
        title: string;
    } | null;
}

export class UserDomainService extends BaseService {
    /**
     * Get all domains for a user
     */
    async getByUserId(userId: string): Promise<UserDomainWithApp[]> {
        try {
            const results = await this.getReadDb().query.userDomains.findMany({
                where: eq(userDomains.userId, userId),
                with: {
                    // Note: We'll need to join apps manually since drizzle might not have the relation defined
                }
            });

            // Fetch app details for each domain
            const domainsWithApps: UserDomainWithApp[] = [];
            for (const domain of results) {
                let app = null;
                if (domain.appId) {
                    const appResult = await this.getReadDb().query.apps.findFirst({
                        where: eq(apps.id, domain.appId),
                        columns: { id: true, title: true }
                    });
                    app = appResult ? { id: appResult.id, title: appResult.title } : null;
                }
                domainsWithApps.push({ ...domain, app });
            }

            return domainsWithApps;
        } catch (error) {
            this.handleDatabaseError(error, 'getByUserId', { userId });
        }
    }

    /**
     * Get a domain by ID
     */
    async getById(id: string): Promise<UserDomain | undefined> {
        try {
            const result = await this.getReadDb().query.userDomains.findFirst({
                where: eq(userDomains.id, id),
            });
            return result;
        } catch (error) {
            this.handleDatabaseError(error, 'getById', { id });
        }
    }

    /**
     * Get a domain by domain name
     */
    async getByDomain(domain: string): Promise<UserDomain | undefined> {
        try {
            const result = await this.getReadDb().query.userDomains.findFirst({
                where: eq(userDomains.domain, domain.toLowerCase()),
            });
            return result;
        } catch (error) {
            this.handleDatabaseError(error, 'getByDomain', { domain });
        }
    }

    /**
     * Create a new domain record
     */
    async create(data: {
        userId: string;
        domain: string;
        appId?: string;
    }): Promise<UserDomain> {
        try {
            const id = generateId();
            const now = new Date();

            const newDomain: NewUserDomain = {
                id,
                userId: data.userId,
                domain: data.domain.toLowerCase(),
                appId: data.appId || null,
                status: 'pending',
                createdAt: now,
                updatedAt: now,
            };

            await this.database.insert(userDomains).values(newDomain);

            const created = await this.getById(id);
            if (!created) {
                throw new Error('Failed to create domain record');
            }

            return created;
        } catch (error) {
            this.handleDatabaseError(error, 'create', { userId: data.userId, domain: data.domain });
        }
    }

    /**
     * Update a domain record
     */
    async update(id: string, userId: string, data: UserDomainUpdate): Promise<UserDomain | undefined> {
        try {
            // Ensure user owns the domain
            const existing = await this.getById(id);
            if (!existing || existing.userId !== userId) {
                return undefined;
            }

            await this.database
                .update(userDomains)
                .set({
                    ...data,
                    updatedAt: new Date(),
                })
                .where(eq(userDomains.id, id));

            return await this.getById(id);
        } catch (error) {
            this.handleDatabaseError(error, 'update', { id, data });
        }
    }

    /**
     * Link a domain to a store (app)
     */
    async linkToApp(id: string, userId: string, appId: string): Promise<UserDomain | undefined> {
        return this.update(id, userId, { appId, status: 'active' });
    }

    /**
     * Unlink a domain from a store
     */
    async unlinkFromApp(id: string, userId: string): Promise<UserDomain | undefined> {
        return this.update(id, userId, { appId: null, status: 'pending' });
    }

    /**
     * Delete a domain record
     */
    async delete(id: string, userId: string): Promise<boolean> {
        try {
            // Ensure user owns the domain
            const existing = await this.getById(id);
            if (!existing || existing.userId !== userId) {
                return false;
            }

            const result = await this.database
                .delete(userDomains)
                .where(and(eq(userDomains.id, id), eq(userDomains.userId, userId)));

            return (result.meta?.changes ?? 0) > 0;
        } catch (error) {
            this.handleDatabaseError(error, 'delete', { id, userId });
        }
    }
}
