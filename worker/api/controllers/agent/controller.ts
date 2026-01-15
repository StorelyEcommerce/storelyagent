import { WebSocketMessageResponses } from '../../../agents/constants';
import { BaseController } from '../baseController';
import { generateId } from '../../../utils/idGenerator';
import { CodeGenState } from '../../../agents/core/state';
import { getAgentStub, getTemplateForQuery } from '../../../agents';
import { AgentConnectionData, AgentPreviewResponse, AgentCloudflareDeployResponse, CodeGenArgs } from './types';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { ModelConfigService } from '../../../database';
import { ModelConfig } from '../../../agents/inferutils/config.types';
import { RateLimitService } from '../../../services/rate-limit/rateLimits';
import { validateWebSocketOrigin } from '../../../middleware/security/websocket';
import { createLogger } from '../../../logger';
import { getPreviewDomain } from 'worker/utils/urls';
import { ImageType, uploadImage } from 'worker/utils/images';
import { ProcessedImageAttachment } from 'worker/types/image-attachment';
import { getTemplateImportantFiles } from 'worker/services/sandbox/utils';
import { checkStoreInfoForInitialQuery } from '../../../agents/operations/UserConversationProcessor';
import { checkGuardrail, getGuardrailRejectionMessage } from '../../../agents/operations/Guardrail';
import { InferenceContext } from '../../../agents/inferutils/config.types';
import { AppService } from '../../../database';
import type { Blueprint } from '../../../agents/schemas';
import type { SmartCodeGeneratorAgent } from '../../../agents/core/smartGeneratorAgent';

const defaultCodeGenArgs: CodeGenArgs = {
    query: '',
    language: 'typescript',
    frameworks: ['react', 'vite'],
    selectedTemplate: 'auto',
    agentMode: 'deterministic',
};


/**
 * CodingAgentController to handle all code generation related endpoints
 */
export class CodingAgentController extends BaseController {
    static logger = createLogger('CodingAgentController');
    /**
     * Start the incremental code generation process
     */
    static async startCodeGeneration(request: Request, env: Env, ctx: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            this.logger.info('Starting code generation process');

            const url = new URL(request.url);
            const hostname = url.hostname === 'localhost' ? `localhost:${url.port}` : getPreviewDomain(env);
            // Parse the query from the request body
            let body: CodeGenArgs;
            try {
                body = await request.json() as CodeGenArgs;
            } catch (error) {
                return CodingAgentController.createErrorResponse(`Invalid JSON in request body: ${JSON.stringify(error, null, 2)}`, 400);
            }

            const query = body.query;
            if (!query) {
                return CodingAgentController.createErrorResponse('Missing "query" field in request body', 400);
            }
            const { readable, writable } = new TransformStream({
                transform(chunk, controller) {
                    if (chunk === "terminate") {
                        controller.terminate();
                    } else {
                        const encoded = new TextEncoder().encode(JSON.stringify(chunk) + '\n');
                        controller.enqueue(encoded);
                    }
                }
            });
            const writer = writable.getWriter();
            // Check if user is authenticated (required for app creation)
            const user = context.user!;
            try {
                await RateLimitService.enforceAppCreationRateLimit(env, context.config.security.rateLimit, user, request);
            } catch (error) {
                if (error instanceof Error) {
                    return CodingAgentController.createErrorResponse(error, 429);
                } else {
                    this.logger.error('Unknown error in enforceAppCreationRateLimit', error);
                    return CodingAgentController.createErrorResponse(JSON.stringify(error), 429);
                }
            }

            const agentId = generateId();

            // Run guardrail check before proceeding
            const guardrailResult = await checkGuardrail(query, env, {
                agentId,
                userId: user.id,
                enableRealtimeCodeFix: false,
                enableFastSmartCodeFix: false,
            });

            if (!guardrailResult.isAllowed) {
                this.logger.info('Request rejected by guardrail', {
                    reason: guardrailResult.reason,
                    explanation: guardrailResult.explanation,
                    queryPreview: query.substring(0, 100)
                });
                return CodingAgentController.createErrorResponse(
                    getGuardrailRejectionMessage(guardrailResult),
                    403
                );
            }

            this.logger.info('Request passed guardrail check', {
                reason: guardrailResult.reason
            });

            const modelConfigService = new ModelConfigService(env);

            // Fetch all user model configs, api keys and agent instance at once
            const [userConfigsRecord, agentInstance] = await Promise.all([
                modelConfigService.getUserModelConfigs(user.id),
                getAgentStub(env, agentId)
            ]);

            // Convert Record to Map and extract only ModelConfig properties
            const userModelConfigs = new Map();
            for (const [actionKey, mergedConfig] of Object.entries(userConfigsRecord)) {
                if (mergedConfig.isUserOverride) {
                    const modelConfig: ModelConfig = {
                        name: mergedConfig.name,
                        max_tokens: mergedConfig.max_tokens,
                        temperature: mergedConfig.temperature,
                        reasoning_effort: mergedConfig.reasoning_effort,
                        fallbackModel: mergedConfig.fallbackModel
                    };
                    userModelConfigs.set(actionKey, modelConfig);
                }
            }

            const inferenceContext = {
                userModelConfigs: Object.fromEntries(userModelConfigs),
                agentId: agentId,
                userId: user.id,
                enableRealtimeCodeFix: false, // This costs us too much, so disabled it for now
                enableFastSmartCodeFix: false,
            }

            this.logger.info(`Initialized inference context for user ${user.id}`, {
                modelConfigsCount: Object.keys(userModelConfigs).length,
            });

            const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;
            const httpStatusUrl = `${url.origin}/api/agent/${agentId}`;

            let uploadedImages: ProcessedImageAttachment[] = [];
            if (body.images) {
                uploadedImages = await Promise.all(body.images.map(async (image) => {
                    return uploadImage(env, image, ImageType.UPLOADS);
                }));
            }

            // Handle store info collection phase (if needed)
            // This checks if we need store name/design and sets up minimal state if so
            const storeInfoResponse = await CodingAgentController.handleStoreInfoCollection(
                query,
                env,
                inferenceContext,
                agentId,
                agentInstance,
                user,
                body,
                hostname,
                websocketUrl,
                writer,
                readable
            );

            // If store info collection returned a response, return it early
            // (we're waiting for user to provide store info)
            if (storeInfoResponse) {
                return storeInfoResponse;
            }

            // If we proceed with initialization, NOW we select the template
            // (we have the complete query with store info)
            const { templateDetails, selection } = await getTemplateForQuery(env, inferenceContext, query, body.images, this.logger);

            writer.write({
                message: 'Code generation started',
                agentId: agentId,
                websocketUrl,
                httpStatusUrl,
                template: {
                    name: templateDetails.name,
                    files: getTemplateImportantFiles(templateDetails),
                }
            });

            // Prepare initialization args with template info
            const initArgs = {
                query,
                language: body.language || defaultCodeGenArgs.language,
                frameworks: body.frameworks || defaultCodeGenArgs.frameworks,
                hostname,
                inferenceContext,
                images: uploadedImages,
                onBlueprintChunk: (chunk: string) => {
                    writer.write({ chunk });
                },
                templateInfo: { templateDetails, selection },
            };

            const agentPromise = agentInstance.initialize(
                initArgs,
                body.agentMode || defaultCodeGenArgs.agentMode
            ) as Promise<CodeGenState>;

            // Keep background work alive with ctx.waitUntil()
            // This is critical for Cloudflare Workers - without it, the runtime
            // may terminate background work and report "Worker's code had hung"
            ctx.waitUntil(
                agentPromise.then(async (_state: CodeGenState) => {
                    writer.write("terminate");
                    writer.close();
                    this.logger.info(`Agent ${agentId} terminated successfully`);
                }).catch((error) => {
                    this.logger.error(`Agent ${agentId} initialization failed`, error);
                    try {
                        writer.write({ error: 'Initialization failed' });
                        writer.close();
                    } catch (writeError) {
                        // Writer may already be closed
                        this.logger.warn(`Failed to write error to stream for agent ${agentId}`, writeError);
                    }
                })
            );

            this.logger.info(`Agent ${agentId} init launched successfully`);

            return new Response(readable, {
                status: 200,
                headers: {
                    // Use SSE content-type to ensure Cloudflare disables buffering,
                    // while the payload remains NDJSON lines consumed by the client.
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    // Prevent intermediary caches/proxies from buffering or transforming
                    'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
        } catch (error) {
            this.logger.error('Error starting code generation', error);
            return CodingAgentController.handleError(error, 'start code generation');
        }
    }

    /**
     * Handle WebSocket connections for code generation
     * This routes the WebSocket connection directly to the Agent
     */
    static async handleWebSocketConnection(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<Response> {
        try {
            const chatId = context.pathParams.agentId; // URL param is still agentId for backward compatibility
            if (!chatId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // Ensure the request is a WebSocket upgrade request
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }

            // Validate WebSocket origin
            if (!validateWebSocketOrigin(request, env)) {
                return new Response('Forbidden: Invalid origin', { status: 403 });
            }

            // Extract user for rate limiting
            const user = context.user!;
            if (!user) {
                return CodingAgentController.createErrorResponse('Missing user', 401);
            }

            this.logger.info(`WebSocket connection request for chat: ${chatId}`);

            // Log request details for debugging
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => {
                headers[key] = value;
            });
            this.logger.info('WebSocket request details', {
                headers,
                url: request.url,
                chatId
            });

            try {
                // Get the agent instance to handle the WebSocket connection
                const agentInstance = await getAgentStub(env, chatId);

                this.logger.info(`Successfully got agent instance for chat: ${chatId}`);

                // Let the agent handle the WebSocket connection directly
                return agentInstance.fetch(request);
            } catch (error) {
                this.logger.error(`Failed to get agent instance with ID ${chatId}:`, error);
                // Return an appropriate WebSocket error response
                // We need to emulate a WebSocket response even for errors
                const { 0: client, 1: server } = new WebSocketPair();

                server.accept();
                server.send(JSON.stringify({
                    type: WebSocketMessageResponses.ERROR,
                    error: `Failed to get agent instance: ${error instanceof Error ? error.message : String(error)}`
                }));

                server.close(1011, 'Agent instance not found');

                return new Response(null, {
                    status: 101,
                    webSocket: client
                });
            }
        } catch (error) {
            this.logger.error('Error handling WebSocket connection', error);
            return CodingAgentController.handleError(error, 'handle WebSocket connection');
        }
    }

    /**
     * Connect to an existing agent instance
     * Returns connection information for an already created agent
     */
    static async connectToExistingAgent(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentConnectionData>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentConnectionData>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Connecting to existing agent: ${agentId}`);

            try {
                // Verify the agent instance exists
                const agentInstance = await getAgentStub(env, agentId);
                if (!agentInstance || !(await agentInstance.isInitialized())) {
                    return CodingAgentController.createErrorResponse<AgentConnectionData>('Agent instance not found or not initialized', 404);
                }
                this.logger.info(`Successfully connected to existing agent: ${agentId}`);

                // Construct WebSocket URL
                const url = new URL(request.url);
                const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;

                const responseData: AgentConnectionData = {
                    websocketUrl,
                    agentId,
                };

                return CodingAgentController.createSuccessResponse(responseData);
            } catch (error) {
                this.logger.error(`Failed to connect to agent ${agentId}:`, error);
                return CodingAgentController.createErrorResponse<AgentConnectionData>(`Agent instance not found or unavailable: ${error instanceof Error ? error.message : String(error)}`, 404);
            }
        } catch (error) {
            this.logger.error('Error connecting to existing agent', error);
            return CodingAgentController.handleError(error, 'connect to existing agent') as ControllerResponse<ApiResponse<AgentConnectionData>>;
        }
    }

    /**
     * Handle store info collection phase before initialization
     * If store info is needed, sets up minimal agent state and returns early response
     * If not needed, returns null to proceed with normal initialization
     */
    static async handleStoreInfoCollection(
        query: string,
        env: Env,
        inferenceContext: InferenceContext,
        agentId: string,
        agentInstance: DurableObjectStub<SmartCodeGeneratorAgent>,
        user: { id: string },
        body: CodeGenArgs,
        hostname: string,
        websocketUrl: string,
        writer: WritableStreamDefaultWriter,
        readable: ReadableStream
    ): Promise<Response | null> {
        const logger = createLogger('StoreInfoCollection');

        // Check if we need to ask for store info
        const storeInfoCheck = await checkStoreInfoForInitialQuery(
            query,
            env,
            inferenceContext
        );

        // If we don't need to ask, proceed with initialization
        if (!storeInfoCheck || storeInfoCheck.askFor === 'skip') {
            return null; // Signal to proceed with normal initialization
        }

        // Build the message based on what we need to ask for
        let askMessage = '';

        if (storeInfoCheck.askFor === 'both') {
            askMessage = `Before we continue, I'd like to know a bit more about your store to make it perfect for you:\n\n1. **Store Name**: What would you like to name your store? (e.g., "TechShop", "Fashion Boutique", "Artisan Crafts")\n\n2. **Visual Design Style**: What visual aesthetic would you like for your store's appearance? This determines the colors, fonts, and overall look of your website. For example:\n   - Modern and minimalist\n   - Vintage and rustic\n   - Bold and colorful\n   - Elegant and sophisticated\n   - Playful and fun\n   - Or describe your preferred color scheme and visual style`;
        } else if (storeInfoCheck.askFor === 'name') {
            askMessage = `Before we continue, I'd like to know what you'd like to name your store. (e.g., "TechShop", "Fashion Boutique", "Artisan Crafts")\n\nWhat would you like to call it?`;
        } else if (storeInfoCheck.askFor === 'design') {
            askMessage = `Before we continue, I'd like to know what visual aesthetic you'd like for your store's appearance. This determines the colors, fonts, and overall look of your website. For example:\n   - Modern and minimalist\n   - Vintage and rustic\n   - Bold and colorful\n   - Elegant and sophisticated\n   - Playful and fun\n   - Or describe your preferred color scheme and visual style\n\nWhat visual design style do you have in mind?`;
        }

        logger.info("Store info needed, setting up pending state", {
            askFor: storeInfoCheck.askFor
        });

        // Send agentId and websocketUrl so frontend can connect
        // The agent will broadcast the store info request via WebSocket on connect
        writer.write({
            message: 'Waiting for store information',
            agentId: agentId,
            websocketUrl: websocketUrl,
            storeInfoPending: true
        });

        // Set up minimal agent state for WebSocket connections
        // We don't know the template yet - it will be selected during initialize() with complete query
        // Store init args for later initialization (without templateInfo and onBlueprintChunk callback)
        // We'll store these in state so they persist across WebSocket connections
        // Note: onBlueprintChunk callback can't be stored in state, but we'll reconstruct it during initialize()
        const minimalState: CodeGenState = {
            blueprint: {} as Blueprint,
            projectName: '',
            query: query,
            generatedFilesMap: {},
            generatedPhases: [],
            templateName: '', // Empty - template not selected yet
            sandboxInstanceId: undefined,
            shouldBeGenerating: false,
            mvpGenerated: false,
            reviewingInitiated: false,
            agentMode: body.agentMode || defaultCodeGenArgs.agentMode,
            sessionId: '',
            hostname: hostname,
            phasesCounter: 12,
            pendingUserInputs: [],
            currentDevState: 0, // CurrentDevState.IDLE
            conversationMessages: [],
            projectUpdatesAccumulator: [],
            inferenceContext: inferenceContext,
            lastDeepDebugTranscript: null,
            isDeepDebugging: false,
            commandsHistory: [],
            lastPackageJson: undefined,
            storeInfoPending: true, // Flag to indicate waiting for store info
            // Store pending init args in state so they persist (without callbacks)
            pendingInitArgs: {
                query,
                language: (body.language ?? defaultCodeGenArgs.language) as string,
                frameworks: (body.frameworks ?? defaultCodeGenArgs.frameworks) as string[],
                hostname,
                inferenceContext,
                images: body.images ?? [],
                storeInfoMessage: askMessage // Store the message to broadcast on connect
            }
        };
        agentInstance.setState(minimalState);

        logger.info(`Set minimal state for agent ${agentId} (template not selected yet)`, {
            query: query.substring(0, 50) + '...'
        });

        // Create a minimal app record so WebSocket authentication works
        // Use upsert or check for existing app to avoid duplicate key errors
        try {
            const appService = new AppService(env);
            // Try to create the app, but if it already exists, that's okay
            await appService.createApp({
                id: agentId,
                title: (query.substring(0, 100) || 'New Store').trim(),
                description: (query.substring(0, 500) || query).trim(), // Limit description length
                originalPrompt: query.trim(),
                userId: user.id,
                visibility: 'private' as const,
                status: 'generating' as const,
                framework: ((body.frameworks?.[0] || 'react') as string).trim(),
                createdAt: new Date(),
                updatedAt: new Date()
            });
            logger.info(`Created minimal app record for agent ${agentId}`);
        } catch (error: any) {
            // If it's a duplicate key error, that's fine - app already exists
            if (error?.message?.includes('UNIQUE constraint') ||
                error?.message?.includes('duplicate key') ||
                error?.code === '23505') { // PostgreSQL unique violation error code
                logger.info(`App record already exists for agent ${agentId}, skipping creation`);
            } else {
                logger.error(`Failed to create minimal app record: ${error}`);
                // Continue anyway - initialization will create/update it later
            }
        }

        // Return early response - initialization will happen when user responds via WebSocket
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
                'Pragma': 'no-cache',
                'Connection': 'keep-alive'
            }
        });
    }

    static async deployPreview(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentPreviewResponse>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Deploying preview for agent: ${agentId}`);

            try {
                // Get the agent instance
                const agentInstance = await getAgentStub(env, agentId);

                // Deploy the preview
                const preview = await agentInstance.deployToSandbox();
                if (!preview) {
                    return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
                }
                this.logger.info('Preview deployed successfully', {
                    agentId,
                    previewUrl: preview.previewURL
                });

                return CodingAgentController.createSuccessResponse(preview);
            } catch (error) {
                this.logger.error('Failed to deploy preview', { agentId, error });
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
            }
        } catch (error) {
            this.logger.error('Error deploying preview', error);
            const appError = CodingAgentController.handleError(error, 'deploy preview') as ControllerResponse<ApiResponse<AgentPreviewResponse>>;
            return appError;
        }
    }

    static async deployToCloudflare(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentCloudflareDeployResponse>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentCloudflareDeployResponse>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Deploying to Cloudflare for agent: ${agentId}`);

            try {
                const agentInstance = await getAgentStub(env, agentId);
                const deployment = await agentInstance.deployToCloudflare();

                if (!deployment?.deploymentUrl) {
                    return CodingAgentController.createErrorResponse<AgentCloudflareDeployResponse>('Failed to deploy to Cloudflare', 500);
                }

                this.logger.info('Cloudflare deployment completed', {
                    agentId,
                    deploymentUrl: deployment.deploymentUrl
                });

                return CodingAgentController.createSuccessResponse({
                    deploymentUrl: deployment.deploymentUrl
                });
            } catch (error) {
                this.logger.error('Failed to deploy to Cloudflare', { agentId, error });
                return CodingAgentController.createErrorResponse<AgentCloudflareDeployResponse>('Failed to deploy to Cloudflare', 500);
            }
        } catch (error) {
            this.logger.error('Error deploying to Cloudflare', error);
            const appError = CodingAgentController.handleError(error, 'deploy to cloudflare') as ControllerResponse<ApiResponse<AgentCloudflareDeployResponse>>;
            return appError;
        }
    }

    /**
     * Get all generated files for an agent
     * Used for local development to dump files to disk
     */
    static async getGeneratedFiles(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<{ projectName: string; files: Array<{ filePath: string; fileContents: string; filePurpose: string }> }>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            this.logger.info(`Fetching generated files for agent: ${agentId}`);

            try {
                // Get the agent instance
                const agentInstance = await getAgentStub(env, agentId);

                // Get full state which contains generatedFilesMap
                const state = await agentInstance.getFullState() as CodeGenState;

                if (!state || !state.generatedFilesMap) {
                    return CodingAgentController.createErrorResponse('No generated files found', 404);
                }

                const files = Object.values(state.generatedFilesMap).map(file => ({
                    filePath: file.filePath,
                    fileContents: file.fileContents,
                    filePurpose: file.filePurpose || ''
                }));

                const projectName = state.blueprint?.projectName || state.projectName || 'store';

                this.logger.info(`Retrieved ${files.length} generated files for agent ${agentId}`);

                return CodingAgentController.createSuccessResponse({
                    projectName,
                    files
                });
            } catch (error) {
                this.logger.error('Failed to get generated files', { agentId, error });
                return CodingAgentController.createErrorResponse('Failed to get generated files', 500);
            }
        } catch (error) {
            this.logger.error('Error getting generated files', error);
            return CodingAgentController.handleError(error, 'get generated files') as ControllerResponse<ApiResponse<any>>;
        }
    }
}
