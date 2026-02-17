export const getProtocolForHost = (host: string): string => {
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('0.0.0.0') || host.startsWith('::1')) {
        return 'http';
    } else {
        return 'https';
    }
}
export function getPreviewDomain(env: Env): string {
    if (env.CUSTOM_PREVIEW_DOMAIN && env.CUSTOM_PREVIEW_DOMAIN.trim() !== '') {
        return env.CUSTOM_PREVIEW_DOMAIN;
    }
    return env.CUSTOM_DOMAIN;
}

export function buildUserWorkerUrl(env: Env, deploymentId: string): string {
    const domain = getPreviewDomain(env);
    const protocol = getProtocolForHost(domain);
    return `${protocol}://${deploymentId}.${domain}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Normalize preview URL hostnames to be DNS-safe for local development.
 */
export function normalizePreviewUrl(url?: string): string | undefined {
    if (!url) return undefined;

    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('_')) {
            parsed.hostname = parsed.hostname.replace(/_/g, '-');
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Normalize preview URL and align local preview links to the current request origin/port.
 * Useful when local dev server port changes (e.g. 5173 -> 5174).
 */
export function normalizePreviewUrlForRequest(
    url: string | undefined,
    requestUrl: string
): string | undefined {
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return normalized;

    try {
        const preview = new URL(normalized);
        const request = new URL(requestUrl);
        const isRequestLoopback = LOOPBACK_HOSTS.has(request.hostname);
        const isPreviewLoopbackSubdomain = preview.hostname.endsWith('.localhost');

        if (isRequestLoopback && isPreviewLoopbackSubdomain) {
            preview.protocol = request.protocol;
            if (request.port) {
                preview.port = request.port;
            }
        }

        return preview.toString();
    } catch {
        return normalized;
    }
}

/**
 * Migrate a stored preview URL to the current domain.
 * Extracts subdomain from old URL and rebuilds with current getPreviewDomain().
 * Used to handle domain changes without invalidating existing sandbox instances.
 */
export function migratePreviewUrl(
    storedUrl: string | undefined,
    env: Env,
    overrideDomain?: string
): string | undefined {
    if (!storedUrl) return undefined;

    try {
        const url = new URL(storedUrl);
        const hostname = url.hostname;
        const currentDomain = overrideDomain && overrideDomain.trim() !== ''
            ? overrideDomain.trim()
            : getPreviewDomain(env);

        // Already using current domain
        if (hostname.endsWith(`.${currentDomain}`)) {
            return normalizePreviewUrl(storedUrl);
        }

        // Extract subdomain by finding the first dot
        const firstDotIndex = hostname.indexOf('.');
        if (firstDotIndex === -1) return storedUrl;

        const subdomain = hostname.slice(0, firstDotIndex);

        // Rebuild with current domain
        return normalizePreviewUrl(`${url.protocol}//${subdomain}.${currentDomain}${url.pathname}`);
    } catch {
        return normalizePreviewUrl(storedUrl);
    }
}

export function buildGitCloneUrl(env: Env, appId: string, token?: string): string {
    const domain = env.CUSTOM_DOMAIN;
    const protocol = getProtocolForHost(domain);
    // Git expects username:password format. Use 'oauth2' as username and token as password
    // This is a standard pattern for token-based git authentication
    const auth = token ? `oauth2:${token}@` : '';
    return `${protocol}://${auth}${domain}/apps/${appId}.git`;
}
