/**
 * Domain Controller Types
 */

export interface DomainCheckData {
    domain: string;
    available: boolean;
    suggestions?: Array<{
        domain: string;
        available: boolean;
    }>;
    purchaseUrl?: string;
    error?: string;
}

export interface DomainPurchaseUrlData {
    domain: string;
    url: string;
}

export interface UserDomainData {
    id: string;
    domain: string;
    status: 'pending' | 'verified' | 'active' | 'expired';
    appId: string | null;
    app: {
        id: string;
        title: string;
    } | null;
    createdAt: Date | null;
}

export interface UserDomainsListData {
    domains: UserDomainData[];
}

export interface DomainLinkData {
    success: boolean;
    domain: UserDomainData;
}

export interface DomainDeleteData {
    success: boolean;
}

export interface DomainCreateData {
    success: boolean;
    domain: UserDomainData;
}

export interface DomainConnectData {
    mode: 'domain-connect' | 'manual';
    domain: UserDomainData;
    targetHost: string;
    applyUrl?: string;
    provider?: {
        id: string;
        name: string;
        displayName?: string;
    };
}

// Subdomain (storelyshop.com subdomain) Types

export interface SubdomainCheckData {
    subdomain: string;
    available: boolean;
    reason?: string; // e.g., "already taken", "reserved", "invalid characters"
}

export interface SubdomainUpdateData {
    success: boolean;
    subdomain: string;
    storeUrl: string; // Full URL: https://my-shop.storelyshop.com
}
