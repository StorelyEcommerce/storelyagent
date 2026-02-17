import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const getBrowserOrigin = (): string | undefined => {
	if (typeof window === 'undefined') return undefined
	return window.location.origin
}

const normalizePreviewCandidate = (
	url: string,
	currentOrigin?: string
): string => {
	try {
		const preview = new URL(url)

		// Keep local preview host labels DNS-safe.
		if (preview.hostname.includes('_')) {
			preview.hostname = preview.hostname.replace(/_/g, '-')
		}

		if (!currentOrigin) return preview.toString()

		const current = new URL(currentOrigin)
		const isCurrentLoopback = LOOPBACK_HOSTS.has(current.hostname)
		const isPreviewLoopbackSubdomain = preview.hostname.endsWith('.localhost')

		// In local dev, keep preview URLs aligned with the active app origin/port.
		if (isCurrentLoopback && isPreviewLoopbackSubdomain) {
			preview.protocol = current.protocol
			if (current.port) {
				preview.port = current.port
			}
		}

		return preview.toString()
	} catch {
		return url
	}
}

export function getPreviewUrlCandidates(
	previewURL?: string,
	tunnelURL?: string,
	currentOrigin?: string
): string[] {
	const origin = currentOrigin ?? getBrowserOrigin()
	const candidates: string[] = []
	const inputs = [previewURL, tunnelURL].filter((value): value is string => !!value)

	for (const input of inputs) {
		const normalized = normalizePreviewCandidate(input, origin)
		if (!candidates.includes(normalized)) {
			candidates.push(normalized)
		}

		// Keep the raw value as a fallback in case normalization made it worse for a given env.
		if (normalized !== input && !candidates.includes(input)) {
			candidates.push(input)
		}
	}

	return candidates
}

export function getPreviewUrl(previewURL?: string, tunnelURL?: string): string {
	return getPreviewUrlCandidates(previewURL, tunnelURL)[0] || ''
}

export function capitalizeFirstLetter(str: string) {
  if (typeof str !== 'string' || str.length === 0) {
    return str; // Handle non-string input or empty string
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}
