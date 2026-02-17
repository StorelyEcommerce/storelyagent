// import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import path from 'path';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

const disableCloudflareContainers =
	process.env.DISABLE_CF_CONTAINERS === '1';

// https://vite.dev/config/
export default defineConfig({
	optimizeDeps: {
		exclude: [
			'format',
			'@modelcontextprotocol/sdk', // Exclude MCP SDK from pre-bundling (used in Worker, not browser)
		],
		include: ['monaco-editor/esm/vs/editor/editor.api'],
		force: true,
	},

	build: {
		// Monaco + TS language service workers produce large, intentional chunks.
		chunkSizeWarningLimit: 2600,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) {
						return;
					}

					if (id.includes('monaco-editor')) {
						return 'vendor-monaco';
					}

					if (
						id.includes('react-markdown') ||
						id.includes('remark-gfm') ||
						id.includes('rehype-external-links') ||
						id.includes('/remark-parse/') ||
						id.includes('/remark-rehype/') ||
						id.includes('/rehype-raw/') ||
						id.includes('/unified/')
					) {
						return 'vendor-markdown';
					}

					if (id.includes('recharts')) {
						return 'vendor-charts';
					}

					if (id.includes('@sentry/')) {
						return 'vendor-sentry';
					}

					if (id.includes('@radix-ui/')) {
						return 'vendor-radix';
					}

					if (id.includes('framer-motion')) {
						return 'vendor-motion';
					}

					if (id.includes('@tanstack/')) {
						return 'vendor-tanstack';
					}

					if (id.includes('lucide-react')) {
						return 'vendor-icons';
					}

					if (
						id.includes('/react-router/') ||
						id.includes('/react-router-dom/')
					) {
						return 'vendor-router';
					}

					if (id.includes('/react-dom/') || id.includes('/react/')) {
						return 'vendor-react';
					}

					return 'vendor';
				},
			},
		},
	},
	plugins: [
		react(),
		svgr(),
		cloudflare({
			configPath: 'wrangler.jsonc',
			...(disableCloudflareContainers
				? {
						config: (config) => ({
							dev: {
								...(config.dev ?? {}),
								enable_containers: false,
							},
						}),
					}
				: {}),
		}),
		tailwindcss(),
		// sentryVitePlugin({
		// 	org: 'cloudflare-0u',
		// 	project: 'javascript-react',
		// }),
	],

	resolve: {
		alias: {
			debug: 'debug/src/browser',
			'@': path.resolve(__dirname, './src'),
			'shared': path.resolve(__dirname, './shared'),
			'worker': path.resolve(__dirname, './worker'),
		},
	},

	// Configure for Prisma + Cloudflare Workers compatibility
	define: {
		// Ensure proper module definitions for Cloudflare Workers context
		'process.env.NODE_ENV': JSON.stringify(
			process.env.NODE_ENV || 'development',
		),
		global: 'globalThis',
		// '__filename': '""',
		// '__dirname': '""',
	},

	worker: {
		// Handle Prisma in worker context for development
		format: 'es',
	},

	server: {
		allowedHosts: true,
	},

	// Clear cache more aggressively
	cacheDir: 'node_modules/.vite',
});
