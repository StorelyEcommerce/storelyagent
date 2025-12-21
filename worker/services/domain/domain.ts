/**
 * Domain Service
 * Handles domain availability checking via WHOIS/DNS lookup
 */

import { createLogger } from '../../logger';

const logger = createLogger('DomainService');

export interface DomainAvailabilityResult {
    domain: string;
    available: boolean;
    premium?: boolean;
    error?: string;
}

export interface DomainSuggestion {
    domain: string;
    available: boolean;
}

export interface DomainConnectSettings {
    providerId: string;
    providerName: string;
    providerDisplayName?: string;
    urlSyncUX?: string;
    urlAsyncUX?: string;
    urlAPI?: string;
}

export interface DomainConnectSupport {
    settings: DomainConnectSettings;
    templateSupported: boolean;
}

/**
 * Domain Service for checking availability
 */
export class DomainService {
    private readonly domainConnectServiceId = 'website';
    private readonly domainConnectProviderId = 'storelyshop.com';

    /**
     * Check if a domain is available using DNS lookup
     * If DNS resolution fails, domain is likely available
     */
    async checkAvailability(domain: string): Promise<DomainAvailabilityResult> {
        try {
            // Normalize domain
            const normalizedDomain = this.normalizeDomain(domain);

            if (!this.isValidDomain(normalizedDomain)) {
                return {
                    domain: normalizedDomain,
                    available: false,
                    error: 'Invalid domain format'
                };
            }

            // Use DNS lookup to check availability
            // If DNS resolves, domain is taken; if it fails, likely available
            const isAvailable = await this.checkDNS(normalizedDomain);

            logger.info('Domain availability check', { domain: normalizedDomain, available: isAvailable });

            return {
                domain: normalizedDomain,
                available: isAvailable
            };
        } catch (error) {
            logger.error('Error checking domain availability', { domain, error });
            return {
                domain,
                available: false,
                error: 'Failed to check availability'
            };
        }
    }

    /**
     * Generate domain suggestions based on a search query
     */
    generateSuggestions(query: string): string[] {
        const baseName = query.toLowerCase().replace(/[^a-z0-9]/g, '');
        const tlds = ['.com', '.net', '.org', '.io', '.co', '.shop', '.store'];

        return tlds.map(tld => `${baseName}${tld}`);
    }

    /**
     * Get a purchase URL for a domain
     */
    getPurchaseUrl(domain: string): string {
        const normalizedDomain = this.normalizeDomain(domain);
        return `https://www.name.com/domain/search/${encodeURIComponent(normalizedDomain)}`;
    }

    /**
     * Normalize domain name
     */
    normalizeDomain(domain: string): string {
        let normalized = domain.toLowerCase().trim();

        // Remove protocol if present
        normalized = normalized.replace(/^https?:\/\//, '');

        // Remove www. prefix
        normalized = normalized.replace(/^www\./, '');

        // Remove trailing slashes and paths
        normalized = normalized.split('/')[0];

        return normalized;
    }

    /**
     * Validate domain format
     */
    isValidDomain(domain: string): boolean {
        // Basic domain validation regex
        const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;
        return domainRegex.test(domain);
    }

    /**
     * Discover Domain Connect settings for a domain, if supported by its DNS provider
     */
    async discoverDomainConnect(domain: string): Promise<DomainConnectSupport | null> {
        const normalizedDomain = this.normalizeDomain(domain);
        if (!this.isValidDomain(normalizedDomain)) {
            return null;
        }

        const domainConnectHost = await this.getDomainConnectHost(normalizedDomain);
        if (!domainConnectHost) {
            return null;
        }

        const settings = await this.fetchDomainConnectSettings(domainConnectHost, normalizedDomain);
        if (!settings) {
            return null;
        }

        const templateSupported = await this.isDomainConnectTemplateSupported(settings);
        return { settings, templateSupported };
    }

    /**
     * Build a Domain Connect apply URL for our template
     */
    buildDomainConnectApplyUrl(
        settings: DomainConnectSettings,
        domain: string,
        targetHost: string
    ): string | null {
        if (!settings.urlSyncUX) {
            return null;
        }

        const applyUrl = new URL(
            `${settings.urlSyncUX}/v2/domainTemplates/providers/${this.domainConnectProviderId}/services/${this.domainConnectServiceId}/apply`
        );

        applyUrl.searchParams.set('domain', domain);
        applyUrl.searchParams.set('TARGET', targetHost);

        return applyUrl.toString();
    }

    /**
     * Check DNS to determine if domain is registered
     * Uses Cloudflare's DNS-over-HTTPS
     */
    private async checkDNS(domain: string): Promise<boolean> {
        try {
            // Query Cloudflare DoH for A or NS records
            const response = await fetch(
                `https://cloudflare-dns.com/dns-query?name=${domain}&type=NS`,
                {
                    headers: {
                        'Accept': 'application/dns-json'
                    }
                }
            );

            if (!response.ok) {
                // If DNS query fails, assume we can't determine - default to not available
                return false;
            }

            const data = await response.json() as { Status: number; Answer?: unknown[] };

            // Status 0 = NOERROR (domain exists), Status 3 = NXDOMAIN (domain doesn't exist)
            // If NXDOMAIN (status 3), domain is likely available
            if (data.Status === 3) {
                return true; // Available
            }

            // If we got answers, domain is registered
            if (data.Answer && data.Answer.length > 0) {
                return false; // Not available
            }

            // No NS records but not NXDOMAIN - could be available
            return true;
        } catch (error) {
            logger.warn('DNS check failed, assuming unavailable', { domain, error });
            return false;
        }
    }

    private async getDomainConnectHost(domain: string): Promise<string | null> {
        const recordName = `__domainconnect_.${domain}`;

        try {
            const response = await fetch(
                `https://cloudflare-dns.com/dns-query?name=${recordName}&type=TXT`,
                {
                    headers: {
                        'Accept': 'application/dns-json'
                    }
                }
            );

            if (!response.ok) {
                return null;
            }

            const data = await response.json() as { Answer?: Array<{ data?: string }> };
            const answer = data.Answer?.find(entry => entry.data);
            if (!answer?.data) {
                return null;
            }

            return answer.data.replace(/"/g, '').trim();
        } catch (error) {
            logger.warn('Domain Connect TXT lookup failed', { domain, error });
            return null;
        }
    }

    private async fetchDomainConnectSettings(
        domainConnectHost: string,
        domain: string
    ): Promise<DomainConnectSettings | null> {
        try {
            const response = await fetch(
                `https://${domainConnectHost}/v2/${domain}/settings`,
                {
                    headers: {
                        'Accept': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                return null;
            }

            const data = await response.json() as DomainConnectSettings;
            if (!data.providerId || !data.providerName) {
                return null;
            }

            return data;
        } catch (error) {
            logger.warn('Domain Connect settings lookup failed', { domain, error });
            return null;
        }
    }

    private async isDomainConnectTemplateSupported(settings: DomainConnectSettings): Promise<boolean> {
        if (!settings.urlAPI) {
            return false;
        }

        try {
            const response = await fetch(
                `${settings.urlAPI}/v2/domainTemplates/providers/${this.domainConnectProviderId}/services/${this.domainConnectServiceId}`,
                {
                    headers: {
                        'Accept': 'application/json'
                    }
                }
            );

            if (response.status === 404) {
                return false;
            }

            return response.ok;
        } catch (error) {
            logger.warn('Domain Connect template support check failed', { error });
            return false;
        }
    }
}
