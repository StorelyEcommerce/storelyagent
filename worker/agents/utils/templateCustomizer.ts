import { modify, applyEdits } from 'jsonc-parser';

export interface TemplateCustomizationOptions {
    projectName: string;
    commandsHistory: string[];
}

export interface CustomizedTemplateFiles {
    'package.json': string;
    'wrangler.jsonc'?: string;
    '.bootstrap.js': string;
    '.gitignore': string;
    'storefront-app/server.js'?: string;
    'api-worker/package.json'?: string;
}

/**
 * Customize all template configuration files
 * - Updates package.json with project name and prepare script
 * - Updates wrangler.jsonc with project name (if exists)
 * - Generates .bootstrap.js script
 * - Updates .gitignore to exclude bootstrap marker
 */
export function customizeTemplateFiles(
    templateFiles: Record<string, string>,
    options: TemplateCustomizationOptions
): Partial<CustomizedTemplateFiles> {
    const customized: Partial<CustomizedTemplateFiles> = {};
    
    // 1. Customize package.json
    if (templateFiles['package.json']) {
        customized['package.json'] = customizePackageJson(
            templateFiles['package.json'],
            options.projectName
        );
    }
    
    // 2. Customize wrangler.jsonc
    if (templateFiles['wrangler.jsonc']) {
        customized['wrangler.jsonc'] = customizeWranglerJsonc(
            templateFiles['wrangler.jsonc'],
            options.projectName
        );
    }
    
    // 3. Generate bootstrap script
    customized['.bootstrap.js'] = generateBootstrapScript(
        options.projectName,
        options.commandsHistory
    );
    
    // 4. Update .gitignore
    customized['.gitignore'] = updateGitignore(
        templateFiles['.gitignore'] || ''
    );

    // 5. Ensure storefront browser API calls use a relative base in base-store templates
    if (templateFiles['storefront-app/server.js']) {
        customized['storefront-app/server.js'] = ensureStorefrontPublicApiUrl(
            templateFiles['storefront-app/server.js']
        );
    }

    // 6. Ensure api-worker always uses its own wrangler config file explicitly.
    // Without --config wrangler.toml, wrangler can resolve ../wrangler.jsonc and crash.
    if (templateFiles['api-worker/package.json']) {
        customized['api-worker/package.json'] = ensureApiWorkerDevConfig(
            templateFiles['api-worker/package.json']
        );
    }
    
    return customized;
}

/**
 * Update package.json with project name and prepare script
 */
export function customizePackageJson(content: string, projectName: string): string {
    const pkg = JSON.parse(content);
    pkg.name = projectName;
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.prepare = 'bun .bootstrap.js || true';

    // Legacy base-store templates only installed storefront deps during postinstall,
    // which leaves api-worker deps missing and breaks /v1 proxy calls at runtime.
    const postinstall = pkg.scripts.postinstall;
    if (
        typeof postinstall === 'string' &&
        postinstall.includes('storefront-app') &&
        !postinstall.includes('api-worker')
    ) {
        pkg.scripts.postinstall = `${postinstall} && cd ../api-worker && npm install`;
    }

    // Legacy base-store templates invoked wrangler directly from root-level scripts.
    // In sandbox this can fail because api-worker local binaries are not on PATH there.
    // Route through npm scripts so local node_modules/.bin/wrangler is always resolved.
    if (typeof pkg.scripts.dev === 'string') {
        pkg.scripts.dev = pkg.scripts.dev.replace(
            /cd\s+api-worker\s*&&\s*wrangler\s+dev(?:\s+--config\s+wrangler\.toml)?(?:\s+--port\s+8787)?/g,
            'cd api-worker && npm run dev'
        );
    }
    if (typeof pkg.scripts['dev:api'] === 'string') {
        pkg.scripts['dev:api'] = pkg.scripts['dev:api'].replace(
            /cd\s+api-worker\s*&&\s*wrangler\s+dev(?:\s+--config\s+wrangler\.toml)?(?:\s+--port\s+8787)?/g,
            'cd api-worker && npm run dev'
        );
    }

    return JSON.stringify(pkg, null, 2);
}

/**
 * Update wrangler.jsonc with project name (preserves comments)
 */
function customizeWranglerJsonc(content: string, projectName: string): string {
    const edits = modify(content, ['name'], projectName, {
        formattingOptions: {
            tabSize: 2,
            insertSpaces: true,
            eol: '\n'
        }
    });
    return applyEdits(content, edits);
}

/**
 * Generate bootstrap script with proper command escaping
 */
export function generateBootstrapScript(projectName: string, commands: string[]): string {
    // Escape strings for safe embedding in JavaScript
    const safeProjectName = JSON.stringify(projectName);
    const safeCommands = JSON.stringify(commands, null, 4);
    
    return `#!/usr/bin/env bun
/**
 * Auto-generated bootstrap script
 * Runs once after git clone to setup project correctly
 * This file will self-delete after successful execution
 */

const fs = require('fs');
const { execSync } = require('child_process');

const PROJECT_NAME = ${safeProjectName};
const BOOTSTRAP_MARKER = '.bootstrap-complete';

// Check if already bootstrapped
if (fs.existsSync(BOOTSTRAP_MARKER)) {
    console.log('✓ Bootstrap already completed');
    process.exit(0);
}

console.log('🚀 Running first-time project setup...\\n');

try {
    // Update package.json
    updatePackageJson();
    
    // Update wrangler.jsonc if exists
    updateWranglerJsonc();
    
    // Run setup commands
    runSetupCommands();
    
    // Mark as complete
    fs.writeFileSync(BOOTSTRAP_MARKER, new Date().toISOString());
    
    // Self-delete
    fs.unlinkSync(__filename);
    
    console.log('\\n✅ Bootstrap complete! Project ready.');
} catch (error) {
    console.error('❌ Bootstrap failed:', error.message);
    console.log('You may need to manually update package.json and wrangler.jsonc');
    process.exit(1);
}

function updatePackageJson() {
    try {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        pkg.name = PROJECT_NAME;
        
        // Remove prepare script after bootstrap
        if (pkg.scripts && pkg.scripts.prepare) {
            delete pkg.scripts.prepare;
        }
        
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
        console.log('✓ Updated package.json with project name: ' + PROJECT_NAME);
    } catch (error) {
        console.error('Failed to update package.json:', error.message);
        throw error;
    }
}

function updateWranglerJsonc() {
    if (!fs.existsSync('wrangler.jsonc')) {
        console.log('⊘ wrangler.jsonc not found, skipping');
        return;
    }
    
    try {
        let content = fs.readFileSync('wrangler.jsonc', 'utf8');
        content = content.replace(/"name"\\s*:\\s*"[^"]*"/, \`"name": "\${PROJECT_NAME}"\`);
        fs.writeFileSync('wrangler.jsonc', content);
        console.log('✓ Updated wrangler.jsonc with project name: ' + PROJECT_NAME);
    } catch (error) {
        console.warn('⚠️  Failed to update wrangler.jsonc:', error.message);
    }
}

function runSetupCommands() {
    const commands = ${safeCommands};
    
    if (commands.length === 0) {
        console.log('⊘ No setup commands to run');
        return;
    }
    
    console.log('\\n📦 Running setup commands...\\n');
    
    let successCount = 0;
    let failCount = 0;
    
    for (const cmd of commands) {
        console.log(\`▸ \${cmd}\`);
        try {
            execSync(cmd, { 
                stdio: 'inherit',
                cwd: process.cwd()
            });
            successCount++;
        } catch (error) {
            failCount++;
            console.warn(\`⚠️  Command failed: \${cmd}\`);
            console.warn(\`   Error: \${error.message}\`);
        }
    }
    
    console.log(\`\\n✓ Commands completed: \${successCount} successful, \${failCount} failed\\n\`);
}
`;
}

/**
 * Update .gitignore to exclude bootstrap marker
 */
function updateGitignore(content: string): string {
    if (content.includes('.bootstrap-complete')) {
        return content;
    }
    return content + '\n# Bootstrap marker\n.bootstrap-complete\n';
}

function ensureStorefrontPublicApiUrl(content: string): string {
    let next = content;

    next = next
        .split("const API_BASE = process.env.API_URL || 'http://localhost:8787';")
        .join("const API_BASE = process.env.API_URL || 'http://127.0.0.1:8787';");

    if (!next.includes('app.use(express.json());')) {
        next = next.replace(
            "app.use('/public', express.static(path.resolve(__dirname, 'public')));",
            ["app.use('/public', express.static(path.resolve(__dirname, 'public')));", 'app.use(express.json());'].join('\n'),
        );
    }

    if (!next.includes('const PUBLIC_API_URL')) {
        next = next.replace(
            "const STORE_SLUG = process.env.STORE_SLUG || 'demo-store';",
            [
                "const STORE_SLUG = process.env.STORE_SLUG || 'demo-store';",
                'const PUBLIC_API_URL = (() => {',
                "  const configured = process.env.PUBLIC_API_URL || '/v1/stores/';",
                "  return configured.endsWith('/') ? configured : `${configured}/`;",
                '})();',
            ].join('\n'),
        );
    }

    next = next.split("api_url: API_BASE + '/v1/stores/',").join('api_url: PUBLIC_API_URL,');

    const legacyHeaderForwardingBlock = [
        '    const headers = {};',
        '',
        '    for (const [key, value] of Object.entries(req.headers)) {',
        "      if (!value || key === 'host' || key === 'content-length') {",
        '        continue;',
        '      }',
        "      headers[key] = Array.isArray(value) ? value.join(',') : value;",
        '    }',
    ].join('\n');

    const safeHeaderForwardingBlock = [
        "    // Node's fetch rejects forbidden hop-by-hop headers (for example: connection).",
        '    // Forward only safe end-to-end headers needed by API routes.',
        '    const headers = {};',
        "    const allowedHeaders = ['accept', 'content-type', 'authorization', 'cookie'];",
        '    for (const headerName of allowedHeaders) {',
        '      const value = req.headers[headerName];',
        "      if (typeof value === 'string' && value.length > 0) {",
        '        headers[headerName] = value;',
        '      }',
        '    }',
    ].join('\n');

    next = next.split(legacyHeaderForwardingBlock).join(safeHeaderForwardingBlock);

    const legacyProxyErrorResponse = "    res.status(502).json({ error: 'API proxy request failed' });";
    const detailedProxyErrorResponse = [
        '    res.status(502).json({',
        "      error: 'API proxy request failed',",
        "      details: error instanceof Error ? error.message : String(error),",
        '      target: `${API_BASE}${req.originalUrl}`,',
        '    });',
    ].join('\n');

    next = next.split(legacyProxyErrorResponse).join(detailedProxyErrorResponse);

    if (next.includes('console.log(`🔗 API URL: ${API_BASE}`);') && !next.includes('console.log(`🌐 Public API URL: ${PUBLIC_API_URL}`);')) {
        next = next.replace(
            'console.log(`🔗 API URL: ${API_BASE}`);',
            ['console.log(`🔗 API URL: ${API_BASE}`);', '  console.log(`🌐 Public API URL: ${PUBLIC_API_URL}`);'].join('\n'),
        );
    }

    if (!next.includes("app.use('/v1', async (req, res) => {")) {
        next = next.replace(
            '})();',
            [
                '})();',
                '',
                '// Proxy API calls through this server so browser requests stay same-origin in preview.',
                "app.use('/v1', async (req, res) => {",
                '  try {',
                '    const targetUrl = `${API_BASE}${req.originalUrl}`;',
                "    // Node's fetch rejects forbidden hop-by-hop headers (for example: connection).",
                '    // Forward only safe end-to-end headers needed by API routes.',
                '    const headers = {};',
                "    const allowedHeaders = ['accept', 'content-type', 'authorization', 'cookie'];",
                '    for (const headerName of allowedHeaders) {',
                '      const value = req.headers[headerName];',
                "      if (typeof value === 'string' && value.length > 0) {",
                '        headers[headerName] = value;',
                '      }',
                '    }',
                '',
                '    const response = await fetch(targetUrl, {',
                '      method: req.method,',
                '      headers,',
                "      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),",
                '    });',
                '',
                '    const body = Buffer.from(await response.arrayBuffer());',
                "    const contentType = response.headers.get('content-type');",
                '',
                '    if (contentType) {',
                "      res.setHeader('content-type', contentType);",
                '    }',
                '',
                '    res.status(response.status).send(body);',
                '  } catch (error) {',
                "    console.error('Failed to proxy API request:', error);",
                '    res.status(502).json({',
                "      error: 'API proxy request failed',",
                "      details: error instanceof Error ? error.message : String(error),",
                '      target: `${API_BASE}${req.originalUrl}`,',
                '    });',
                '  }',
                '});',
            ].join('\n'),
        );
    }

    return next;
}

function ensureApiWorkerDevConfig(content: string): string {
    let pkg: Record<string, unknown>;
    try {
        pkg = JSON.parse(content);
    } catch {
        return content;
    }

    const scripts = (pkg.scripts && typeof pkg.scripts === 'object')
        ? pkg.scripts as Record<string, unknown>
        : undefined;
    if (!scripts) {
        return content;
    }

    const devScript = scripts.dev;
    if (typeof devScript !== 'string' || !devScript.includes('wrangler dev')) {
        return content;
    }

    let nextDev = devScript;

    if (!/--config\s+wrangler\.toml\b/.test(nextDev)) {
        nextDev = nextDev.replace(/wrangler\s+dev\b/, 'wrangler dev --config wrangler.toml');
    }

    if (!/--port\s+8787\b/.test(nextDev)) {
        nextDev = `${nextDev} --port 8787`;
    }

    if (nextDev === devScript) {
        return content;
    }

    scripts.dev = nextDev;
    pkg.scripts = scripts;
    return JSON.stringify(pkg, null, 2);
}

/**
 * Generate project name from blueprint or query
 */
export function generateProjectName(
    projectName: string,
    uniqueSuffix: string,
    maxPrefixLength: number = 20
): string {
    let prefix = projectName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-');
    
    prefix = prefix.slice(0, maxPrefixLength);
    return `${prefix}-${uniqueSuffix}`.toLowerCase();
}
