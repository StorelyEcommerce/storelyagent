import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createLogger } from '../../logger';
import { MCPServerConfig, MCPSSEServerConfig } from './types';

const logger = createLogger('MCPManager');

/**
 * MCP Server configurations
 * 
 * SSE servers: Connect directly via URL
 */
const MCP_SERVERS: MCPServerConfig[] = [
	{
		name: 'playwright-mcp',
		type: 'sse',
		sseUrl: 'https://playwright-mcp-storely.jayyala.workers.dev/sse',
	},
];

/**
 * MCP Manager - Based on the reference implementation from vite-cfagents-runner
 * Manages connections to multiple MCP servers and provides unified tool access
 * 
 * Supports SSE-based MCP servers that connect directly via URL
 */
export class MCPManager {
	private clients: Map<string, Client> = new Map();
	private toolMap: Map<string, string> = new Map();
	private initialized = false;

	async initialize() {
		if (this.initialized) {
			logger.info('[MCPManager] Already initialized - skipping', { 
				activeConnections: this.clients.size,
				availableTools: this.toolMap.size 
			});
			return;
		}

		logger.info('[MCPManager] ========================================');
		logger.info('[MCPManager] INITIALIZING MCP MANAGER');
		logger.info('[MCPManager] ========================================');
		logger.info('[MCPManager] Initializing MCP manager...', {
			sseServers: MCP_SERVERS.length,
		});
		logger.info(`[MCPManager] SSE Servers: ${MCP_SERVERS.length}`);
		
		// Connect to SSE-based servers
		for (const serverConfig of MCP_SERVERS) {
			if (serverConfig.type !== 'sse') continue;
			
			try {
				logger.info(`[MCPManager] Connecting to SSE MCP server: ${serverConfig.name}`, {
					url: serverConfig.sseUrl,
				});
				await this.connectToSSEServer(serverConfig as MCPSSEServerConfig);
			} catch (error) {
				logger.error(
					`[MCPManager] Failed to connect to MCP server ${serverConfig.name}:`,
					error,
				);
			}
		}

		this.initialized = true;
		logger.info(`[MCPManager] ✅ Initialized successfully`);
		logger.info(`[MCPManager] Active connections: ${this.clients.size}`);
		logger.info(`[MCPManager] Available tools: ${this.toolMap.size}`);
		logger.info(`[MCPManager] Tools: ${Array.from(this.toolMap.keys()).join(', ')}`);
		logger.info('[MCPManager] ========================================');
		
		// Summary log for visibility
		logger.info('[MCPManager] 📊 SUMMARY:', {
			initialized: true,
			activeConnections: this.clients.size,
			availableTools: this.toolMap.size,
			toolNames: Array.from(this.toolMap.keys()),
		});
		logger.info(
			`[MCPManager] MCP manager initialized successfully`,
			{
				activeConnections: this.clients.size,
				availableTools: this.toolMap.size,
				toolNames: Array.from(this.toolMap.keys()),
			}
		);
	}

	private async connectToSSEServer(serverConfig: MCPSSEServerConfig) {
		logger.info(`[MCPManager] Connecting to SSE server`, {
			name: serverConfig.name,
			url: serverConfig.sseUrl,
		});
		
		const transport = new SSEClientTransport(
			new URL(serverConfig.sseUrl),
		);

		const client = new Client(
			{
				name: 'cloudflare-agent',
				version: '1.0.0',
			},
			{
				capabilities: {},
			},
		);
		
		logger.info(`[MCPManager] Attempting connection to ${serverConfig.name}`, { url: serverConfig.sseUrl });
		await client.connect(transport, { timeout: 5000, maxTotalTimeout: 10000 });
		logger.info(`[MCPManager] Successfully connected to ${serverConfig.name}`);
		this.clients.set(serverConfig.name, client);

		logger.info(`[MCPManager] Listing tools from ${serverConfig.name}`);
		const toolsResult = await client.listTools();

		if (toolsResult?.tools) {
			logger.info(`[MCPManager] Found ${toolsResult.tools.length} tools from ${serverConfig.name}`, {
				toolNames: toolsResult.tools.map(t => t.name),
			});
			for (const tool of toolsResult.tools) {
				this.toolMap.set(tool.name, serverConfig.name);
				logger.debug(`[MCPManager] Registered tool: ${tool.name} -> ${serverConfig.name}`);
			}
		} else {
			logger.warn(`[MCPManager] No tools found from ${serverConfig.name}`);
		}

		logger.info(
			`[MCPManager] Connection to ${serverConfig.name} complete`,
			{
				toolCount: toolsResult?.tools?.length || 0,
				totalRegisteredTools: this.toolMap.size,
			}
		);
	}

	async getToolDefinitions() {
		await this.initialize();
		logger.info('[MCPManager] Getting tool definitions', {
			activeClients: this.clients.size,
			registeredTools: this.toolMap.size,
		});
		
		const allTools = [];

		for (const [serverName, client] of this.clients.entries()) {
			try {
				logger.debug(`[MCPManager] Fetching tools from ${serverName}`);
				const toolsResult = await client.listTools();

				if (toolsResult?.tools) {
					logger.info(`[MCPManager] Processing ${toolsResult.tools.length} tools from ${serverName}`);
					for (const tool of toolsResult.tools) {
						// Ensure parameters schema has additionalProperties: false for Anthropic compatibility
						const inputSchema = tool.inputSchema || {
							type: 'object',
							properties: {},
							required: [],
						};
						
						// Normalize the schema to ensure it's an object with additionalProperties: false
						const parameters = {
							type: 'object' as const,
							properties: (inputSchema as any)?.properties || {},
							required: (inputSchema as any)?.required || [],
							additionalProperties: false, // Required by Anthropic API
						};
						
						allTools.push({
							type: 'function' as const,
							function: {
								name: tool.name,
								description: tool.description || '',
								parameters,
							},
						});
						logger.debug(`[MCPManager] Added tool definition: ${tool.name}`, {
							hasParameters: !!parameters.properties && Object.keys(parameters.properties).length > 0,
							parameterCount: Object.keys(parameters.properties || {}).length,
						});
					}
				}
			} catch (error) {
				logger.error(`[MCPManager] Error getting tools from ${serverName}:`, error);
			}
		}

		logger.info(`[MCPManager] Returning ${allTools.length} tool definitions`);
		return allTools;
	}

	async executeTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<string> {
		await this.initialize();

		logger.info(`[MCPManager] Executing tool: ${toolName}`, { args });

		const serverName = this.toolMap.get(toolName);
		if (!serverName) {
			logger.error(`[MCPManager] Tool ${toolName} not found`, {
				availableTools: Array.from(this.toolMap.keys()),
			});
			throw new Error(`Tool ${toolName} not found in any MCP server`);
		}

		logger.debug(`[MCPManager] Tool ${toolName} is provided by server: ${serverName}`);

		const client = this.clients.get(serverName);
		if (!client) {
			logger.error(`[MCPManager] Client for server ${serverName} not available`, {
				availableClients: Array.from(this.clients.keys()),
			});
			throw new Error(`Client for server ${serverName} not available`);
		}

		try {
			logger.info(`[MCPManager] Calling tool ${toolName} on server ${serverName}`, {
				args,
			});
			
			const result = await client.callTool({
				name: toolName,
				arguments: args,
			});

			logger.info(`[MCPManager] Tool ${toolName} execution completed`, {
				isError: result.isError,
				contentTypes: Array.isArray(result.content) 
					? result.content.map((c: { type: string }) => c.type)
					: 'no content',
			});

			if (result.isError) {
				const errorContent = Array.isArray(result.content) 
					? result.content
						.filter((c: { type: string }) => c.type === 'text')
						.map((c: { text: string }) => c.text)
						.join('\n')
					: 'Unknown error';
				logger.error(`[MCPManager] Tool ${toolName} returned error`, { errorContent });
				throw new Error(`Tool execution failed: ${errorContent}`);
			}

			if (Array.isArray(result.content)) {
				const parts: string[] = [];
				let imageCount = 0;
				let textCount = 0;
				let resourceCount = 0;
				
				for (const item of result.content) {
					if (item.type === 'text') {
						textCount++;
						parts.push(item.text);
						logger.debug(`[MCPManager] Processing text content (${textCount})`, {
							length: item.text.length,
						});
					} else if (item.type === 'image') {
						imageCount++;
						// Convert image content to data URL format for multimodal support
						// MCP image format: { type: 'image', data: string (base64), mimeType?: string }
						const mimeType = (item as { mimeType?: string }).mimeType || 'image/png';
						const imageData = (item as { data: string }).data;
						const dataUrl = `data:${mimeType};base64,${imageData}`;
						parts.push(dataUrl);
						logger.info(`[MCPManager] Processing image content (${imageCount})`, {
							mimeType,
							dataLength: imageData.length,
							dataUrlLength: dataUrl.length,
						});
					} else if (item.type === 'resource') {
						resourceCount++;
						// Handle resource references
						const resource = item as { uri: string; text?: string };
						parts.push(resource.text || `[Resource: ${resource.uri}]`);
						logger.debug(`[MCPManager] Processing resource content (${resourceCount})`, {
							uri: resource.uri,
						});
					}
				}
				
				const resultString = parts.join('\n');
				logger.info(`[MCPManager] Tool ${toolName} result processed`, {
					textItems: textCount,
					imageItems: imageCount,
					resourceItems: resourceCount,
					totalLength: resultString.length,
					hasImages: imageCount > 0,
				});
				
				return resultString;
			}

			logger.warn(`[MCPManager] Tool ${toolName} returned no content`);
			return 'No content returned';
		} catch (error) {
			logger.error(`[MCPManager] Tool ${toolName} execution failed`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw new Error(`Tool execution failed: ${String(error)}`);
		}
	}

	hasToolAvailable(toolName: string): boolean {
		return this.toolMap.has(toolName);
	}

	getAvailableToolNames(): string[] {
		return Array.from(this.toolMap.keys());
	}

	async shutdown(): Promise<void> {
		logger.info('Shutting down MCP manager...');

		// MCP SDK handles cleanup automatically
		this.clients.clear();
		this.toolMap.clear();
		this.initialized = false;

		logger.info('MCP manager shutdown complete');
	}
}

// Singleton instance
export const mcpManager = new MCPManager();
