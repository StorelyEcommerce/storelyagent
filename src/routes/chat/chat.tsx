import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
} from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { MonacoEditor } from '../../components/monaco-editor/monaco-editor';
import { AnimatePresence, motion } from 'framer-motion';
import {
	ArrowRight,
	Expand,
	GitBranch,
	Github,
	ImageIcon,
	LoaderCircle,
	MoreHorizontal,
	RefreshCw,
	RotateCcw,
	X,
} from 'lucide-react';
import clsx from 'clsx';
import { UserMessage, AIMessage } from './components/messages';
import { PhaseTimeline } from './components/phase-timeline';
import { PreviewIframe } from './components/preview-iframe';
import { ViewModeSwitch } from './components/view-mode-switch';
import { type DebugMessage } from './components/debug-panel';
import { useChat } from './hooks/use-chat';
import {
	type BlueprintType,
	type FileType,
	type ModelConfigsInfo,
	type PhasicBlueprint,
	type ProjectType,
	SUPPORTED_IMAGE_MIME_TYPES,
	normalizeProjectType,
} from '@/api-types';
import { Copy } from './components/copy';
import { useFileContentStream } from './hooks/use-file-content-stream';
import { logger } from '@/utils/logger';
import { useApp } from '@/hooks/use-app';
import { useAuth } from '@/contexts/auth-context';
import { useGitHubExport } from '@/hooks/use-github-export';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useImageUpload } from '@/hooks/use-image-upload';
import { useDragDrop } from '@/hooks/use-drag-drop';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { sendWebSocketMessage } from './utils/websocket-helpers';
import { detectContentType, isDocumentationPath } from './utils/content-detector';
import { mergeFiles } from '@/utils/file-helpers';
import { ChatModals } from './components/chat-modals';
import { useVault } from '@/hooks/use-vault';
import { VaultUnlockModal } from '@/components/vault';
import { featureRegistry } from '@/features';
import { AgentModeDisplay } from '@/components/agent-mode-display';
import { ImageAttachmentPreview } from '@/components/image-attachment-preview';
import { ModelConfigInfo } from '@/components/shared/ModelConfigInfo';
import { Blueprint } from './components/blueprint';
import { FileExplorer } from './components/file-explorer';

const isPhasicBlueprint = (blueprint?: BlueprintType | null): blueprint is PhasicBlueprint =>
	!!blueprint && 'implementationRoadmap' in blueprint;

export default function Chat() {
	const { chatId: urlChatId } = useParams();

	const [searchParams] = useSearchParams();
	const userQuery = searchParams.get('query');
	const agentMode = searchParams.get('agentMode') || 'deterministic';
	const urlProjectType = searchParams.get('projectType');
	const projectTypeFromUrl: ProjectType = normalizeProjectType(urlProjectType);

	// Extract images from URL params if present
	const userImages = useMemo(() => {
		const imagesParam = searchParams.get('images');
		if (!imagesParam) return undefined;
		try {
			return JSON.parse(decodeURIComponent(imagesParam));
		} catch (error) {
			console.error('Failed to parse images from URL:', error);
			return undefined;
		}
	}, [searchParams]);

	// Load existing app data if chatId is provided
	const { app, loading: appLoading, refetch: refetchApp } = useApp(urlChatId);

	// Navigation - moved up so it can be used in callbacks passed to hooks
	const navigate = useNavigate();

	// If we have an existing app, use its data
	const displayQuery = app ? app.originalPrompt || app.title : userQuery || '';
	const appTitle = app?.title;

	// Manual refresh trigger for preview
	const [manualRefreshTrigger, setManualRefreshTrigger] = useState(0);

	// Debug message utility - still needed for passing to useChat (logs to console only, no panel)
	const addDebugMessage = useCallback(
		(
			type: DebugMessage['type'],
			message: string,
			details?: string,
			source?: string,
			messageType?: string,
			rawMessage?: unknown,
		) => {
			// Debug messages are now only logged to console, not shown in UI
			if (import.meta.env.DEV) {
				console.debug('[Debug]', type, message, { details, source, messageType, rawMessage });
			}
		},
		[],
	);

	// Handle guardrail rejection - navigate to home and show rejection message
	const handleGuardrailRejection = useCallback((message: string) => {
		toast.warning('Request not allowed', {
			description: message,
			duration: 8000,
		});
		navigate('/');
	}, [navigate]);

	const { state: vaultState, requestUnlock, clearUnlockRequest } = useVault();
	const handleVaultUnlockRequired = useCallback(
		(reason: string) => {
			requestUnlock(reason);
		},
		[requestUnlock],
	);

	const {
		messages,
		edit,
		bootstrapFiles,
		chatId,
		query,
		files,
		isGeneratingBlueprint,
		isBootstrapping,
		totalFiles,
		websocket,
		sendUserMessage,
		blueprint,
		previewUrl,
		clearEdit,
		projectStages,
			phaseTimeline,
			isThinking,
			waitingForStoreInfo,
		// Generation control (stop button in chat)
		isGenerating,
		// Preview refresh control
		shouldRefreshPreview,
		// Preview deployment state
		isPreviewDeploying,
		// Issue tracking and debugging state
		runtimeErrorCount,
		staticIssueCount,
		isDebugging,
		// Behavior type from backend
		behaviorType,
		projectType,
		// Template metadata
		templateDetails,
	} = useChat({
		chatId: urlChatId,
		query: userQuery,
		images: userImages,
		projectType: projectTypeFromUrl,
		onDebugMessage: addDebugMessage,
		onVaultUnlockRequired: handleVaultUnlockRequired,
		onGuardrailRejection: handleGuardrailRejection,
	});

	// GitHub export functionality - use urlChatId directly from URL params
	const githubExport = useGitHubExport(websocket, urlChatId, refetchApp);
	const { user } = useAuth();

	const [activeFilePath, setActiveFilePath] = useState<string>();
	const [view, setView] = useState<'editor' | 'preview' | 'docs' | 'blueprint' | 'terminal' | 'presentation'>(
		'editor',
	);

	// Terminal state
	// const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([]);

	// Debug panel removed

	const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
	const [isGitCloneModalOpen, setIsGitCloneModalOpen] = useState(false);

	// Model config info state
	const [modelConfigs, setModelConfigs] = useState<ModelConfigsInfo | undefined>();
	const [loadingConfigs, setLoadingConfigs] = useState(false);

	// Handler for model config info requests
	const handleRequestConfigs = useCallback(() => {
		if (!websocket) return;

		setLoadingConfigs(true);
		websocket.send(JSON.stringify({
			type: 'get_model_configs'
		}));
	}, [websocket]);

	// Listen for model config info WebSocket messages
	useEffect(() => {
		if (!websocket) return;

		const handleMessage = (event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data);
				if (message.type === 'model_configs_info') {
					setModelConfigs(message.configs);
					setLoadingConfigs(false);
				}
			} catch (error) {
				logger.error('Error parsing WebSocket message for model configs:', error);
			}
		};

		websocket.addEventListener('message', handleMessage);

		return () => {
			websocket.removeEventListener('message', handleMessage);
		};
	}, [websocket]);

	type AgentWebSocket = {
		send: (data: string) => void;
		readyState: number;
		addEventListener: (type: 'open', listener: () => void) => void;
		removeEventListener: (type: 'open', listener: () => void) => void;
	};

	const WS_OPEN = 1;

	const sendVaultStatusToAgent = useCallback(
		(ws: AgentWebSocket) => {
			if (vaultState.status === 'unlocked') {
				ws.send(JSON.stringify({ type: 'vault_unlocked' }));
			} else if (vaultState.status === 'locked') {
				ws.send(JSON.stringify({ type: 'vault_locked' }));
			}
		},
		[vaultState.status],
	);

	useEffect(() => {
		if (!websocket) return;

		const ws = websocket as unknown as AgentWebSocket;
		const handleOpen = () => sendVaultStatusToAgent(ws);
		ws.addEventListener('open', handleOpen);

		if (ws.readyState === WS_OPEN) {
			sendVaultStatusToAgent(ws);
		}

		return () => {
			ws.removeEventListener('open', handleOpen);
		};
	}, [sendVaultStatusToAgent, websocket]);

	useEffect(() => {
		if (!websocket) return;
		const ws = websocket as unknown as AgentWebSocket;
		if (ws.readyState !== WS_OPEN) return;
		sendVaultStatusToAgent(ws);
	}, [sendVaultStatusToAgent, vaultState.status, websocket]);

	const hasSeenPreview = useRef(false);
	const prevMarkdownCountRef = useRef(0);
	const hasSwitchedFile = useRef(false);
	// const wasChatDisabled = useRef(true);
	// const hasShownWelcome = useRef(false);

	const editorRef = useRef<HTMLDivElement>(null);
	const previewRef = useRef<HTMLIFrameElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);

	const [newMessage, setNewMessage] = useState('');
	const [showTooltip, setShowTooltip] = useState(false);

	// Word count utilities
	const MAX_WORDS = 4000;
	const countWords = (text: string): number => {
		return text.trim().split(/\s+/).filter(word => word.length > 0).length;
	};

	const { images, addImages, removeImage, clearImages, isProcessing } = useImageUpload({
		onError: (error) => {
			console.error('Chat image upload error:', error);
		},
	});
	const imageInputRef = useRef<HTMLInputElement>(null);

	// Fake stream bootstrap files
	const { streamedFiles: streamedBootstrapFiles } =
		useFileContentStream(bootstrapFiles, {
			tps: 600,
			enabled: isBootstrapping,
		});

	// Merge streamed bootstrap files with generated files
	const allFiles = useMemo(() => {
		let result: FileType[];

		if (templateDetails?.allFiles) {
			const templateFiles = Object.entries(templateDetails.allFiles).map(
				([filePath, fileContents]) => ({
					filePath,
					fileContents,
				})
			);
			result = mergeFiles(templateFiles, files);
		} else {
			result = files;
		}

		// Use feature module's processFiles if available (e.g., for presentations to filter demo slides)
		const featureModule = featureRegistry.getModule(projectType);
		if (featureModule?.processFiles) {
			result = featureModule.processFiles(result, templateDetails);
		}

		return result;
	}, [files, templateDetails, projectType]);

	const handleFileClick = useCallback((file: FileType) => {
		logger.debug('handleFileClick()', file);
		clearEdit();
		setActiveFilePath(file.filePath);
		setView('editor');
		if (!hasSwitchedFile.current) {
			hasSwitchedFile.current = true;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleViewModeChange = useCallback((mode: 'preview' | 'editor' | 'docs' | 'blueprint' | 'presentation') => {
		setView(mode);
	}, []);

	const handleResetConversation = useCallback(() => {
		if (!websocket) return;
		sendWebSocketMessage(websocket, 'clear_conversation');
		setIsResetDialogOpen(false);
	}, [websocket]);

	// // Terminal functions
	// const handleTerminalCommand = useCallback((command: string) => {
	// 	if (websocket && websocket.readyState === WebSocket.OPEN) {
	// 		// Add command to terminal logs
	// 		const commandLog: TerminalLog = {
	// 			id: `cmd-${Date.now()}`,
	// 			content: command,
	// 			type: 'command',
	// 			timestamp: Date.now()
	// 		};
	// 		setTerminalLogs(prev => [...prev, commandLog]);

	// 		// Send command via WebSocket
	// 		websocket.send(JSON.stringify({
	// 			type: 'terminal_command',
	// 			command,
	// 			timestamp: Date.now()
	// 		}));
	// 	}
	// }, [websocket, setTerminalLogs]);

	const generatingCount = useMemo(
		() =>
			files.reduce(
				(count, file) => (file.isGenerating ? count + 1 : count),
				0,
			),
		[files],
	);

	const codeGenState = useMemo(() => {
		return projectStages.find((stage) => stage.id === 'code')?.status;
	}, [projectStages]);

	const generatingFile = useMemo(() => {
		// code gen status should be active
		if (codeGenState === 'active') {
			for (let i = files.length - 1; i >= 0; i--) {
				if (files[i].isGenerating) return files[i];
			}
		}
		return undefined;
	}, [files, codeGenState]);

	const activeFile = useMemo(() => {
		if (!hasSwitchedFile.current && generatingFile) {
			return generatingFile;
		}
		if (!hasSwitchedFile.current && isBootstrapping) {
			return streamedBootstrapFiles.find(
				(file) => file.filePath === activeFilePath,
			);
		}
		return (
			files.find((file) => file.filePath === activeFilePath) ??
			streamedBootstrapFiles.find(
				(file) => file.filePath === activeFilePath,
			) ??
			// Fallback to allFiles for template files that were merged in
			allFiles.find((file) => file.filePath === activeFilePath)
		);
	}, [
		activeFilePath,
		generatingFile,
		files,
		streamedBootstrapFiles,
		isBootstrapping,
		allFiles,
	]);

	const isPhase1Complete = useMemo(() => {
		return phaseTimeline.length > 0 && phaseTimeline[0].status === 'completed';
	}, [phaseTimeline]);

	const isGitHubExportReady = useMemo(() => {
		if (behaviorType === 'agentic') {
			return files.length > 0 && !!urlChatId;
		}
		return isPhase1Complete && !!urlChatId;
	}, [behaviorType, files.length, isPhase1Complete, urlChatId]);

	// Detect if agentic mode is showing static content (docs, markdown)
	const isStaticContent = useMemo(() => {
		if (behaviorType !== 'agentic' || files.length === 0) return false;
		return files.every(file => isDocumentationPath(file.filePath.toLowerCase()));
	}, [behaviorType, files]);

	// Detect content type (documentation detection - works in any projectType)
	const contentDetection = useMemo(() => {
		return detectContentType(files);
	}, [files]);

    const hasDocumentation = useMemo(() => {
        return Object.values(contentDetection.Contents).some(bundle => bundle.type === 'markdown');
    }, [contentDetection]);

	const showMainView = useMemo(() => {
		// For agentic mode: show preview panel when files exist or preview URL exists
		if (behaviorType === 'agentic') {
			const hasFiles = files.length > 0;
			const hasPreview = !!previewUrl;
			const result = hasFiles || hasPreview;
			return result;
		}
		// For phasic mode: keep existing logic
		const result = streamedBootstrapFiles.length > 0 || !!blueprint || files.length > 0;
		return result;
	}, [behaviorType, blueprint, files.length, previewUrl, streamedBootstrapFiles.length]);

	const [mainMessage, ...otherMessages] = useMemo(() => messages, [messages]);

	const { scrollToBottom } = useAutoScroll(messagesContainerRef, { behavior: 'smooth', watch: [messages] });

	const prevMessagesLengthRef = useRef(0);

	useEffect(() => {
		// Force scroll when a new message is appended (length increase)
		if (messages.length > prevMessagesLengthRef.current) {
			requestAnimationFrame(() => scrollToBottom());
		}
		prevMessagesLengthRef.current = messages.length;
	}, [messages.length, scrollToBottom]);

	useEffect(() => {
		// When preview URL is available, show preview immediately
		const shouldShowPreview = previewUrl && !hasSeenPreview.current && (isPhase1Complete || previewUrl.includes('trycloudflare.com'));
		if (shouldShowPreview) {
			setView('preview');
			setShowTooltip(true);
			setTimeout(() => setShowTooltip(false), 3000);
			hasSeenPreview.current = true;
		} else if (isStaticContent && files.length > 0 && !hasDocumentation) {
			// For other static content (non-documentation), show editor view
			setView('editor');
			// Auto-select first file if none selected
			if (!activeFilePath) {
				setActiveFilePath(files[0].filePath);
			}
			hasSeenPreview.current = true;
		} else if (previewUrl) {
			const isExistingChat = urlChatId !== 'new';
			const shouldSwitch =
				behaviorType === 'agentic' ||
				(behaviorType === 'phasic' && isPhase1Complete) ||
				(isExistingChat && behaviorType !== 'phasic');

			if (shouldSwitch) {
				setView('preview');
				setShowTooltip(true);
				setTimeout(() => {
					setShowTooltip(false);
				}, 3000);
				hasSeenPreview.current = true;
			}
		}

		// Update ref for next comparison
		prevMarkdownCountRef.current = files.length;
	}, [previewUrl, isPhase1Complete, isStaticContent, files, activeFilePath, behaviorType, hasDocumentation, projectType, urlChatId]);

	useEffect(() => {
		if (chatId) {
			navigate(`/chat/${chatId}`, {
				replace: true,
			});
		}
	}, [chatId, navigate]);

	useEffect(() => {
		if (!edit) return;
		if (files.some((file) => file.filePath === edit.filePath)) {
			setActiveFilePath(edit.filePath);
			setView('editor');
		}
	}, [edit, files]);

	useEffect(() => {
		if (
			isBootstrapping &&
			streamedBootstrapFiles.length > 0 &&
			!hasSwitchedFile.current
		) {
			setActiveFilePath(streamedBootstrapFiles.at(-1)!.filePath);
		} else if (
			view === 'editor' &&
			!activeFile &&
			files.length > 0 &&
			!hasSwitchedFile.current
		) {
			setActiveFilePath(files.at(-1)!.filePath);
		}
	}, [view, activeFile, files, isBootstrapping, streamedBootstrapFiles]);

	// Preserve active file when generation completes
	useEffect(() => {
		if (!generatingFile && activeFile && !hasSwitchedFile.current) {
			// Generation just ended, preserve the current active file
			setActiveFilePath(activeFile.filePath);
		}
	}, [generatingFile, activeFile]);

	useEffect(() => {
		if (view !== 'blueprint' && isGeneratingBlueprint) {
			setView('blueprint');
		} else if (
			!hasSwitchedFile.current &&
			view === 'blueprint' &&
			!isGeneratingBlueprint
		) {
			setView('editor');
		}
	}, [isGeneratingBlueprint, view]);

	const isRunning = useMemo(() => {
		return (
			isBootstrapping || isGeneratingBlueprint // || codeGenState === 'active'
		);
	}, [isBootstrapping, isGeneratingBlueprint]);

	// Check if chat input should be disabled (before blueprint completion, or during debugging)
	const isChatDisabled = useMemo(() => {
		// Store-info collection must stay interactive before blueprint generation starts.
		if (waitingForStoreInfo) {
			return false;
		}

		const blueprintStage = projectStages.find(
			(stage) => stage.id === 'blueprint',
		);
		const blueprintNotCompleted = !blueprintStage || blueprintStage.status !== 'completed';

		return blueprintNotCompleted || isDebugging;
	}, [projectStages, isDebugging, waitingForStoreInfo]);

	const chatFormRef = useRef<HTMLFormElement>(null);
	const { isDragging: isChatDragging, dragHandlers: chatDragHandlers } = useDragDrop({
		onFilesDropped: addImages,
		accept: [...SUPPORTED_IMAGE_MIME_TYPES],
		disabled: isChatDisabled,
	});

	const onNewMessage = useCallback(
		(e: FormEvent) => {
			e.preventDefault();

			// Don't submit if chat is disabled or message is empty
			if (isChatDisabled || !newMessage.trim()) {
				return;
			}

			// When generation is active, send as conversational AI suggestion
			websocket?.send(
				JSON.stringify({
					type: 'user_suggestion',
					message: newMessage,
					images: images.length > 0 ? images : undefined,
				}),
			);
			sendUserMessage(newMessage);
			setNewMessage('');
			// Clear images after sending
			if (images.length > 0) {
				clearImages();
			}
			// Ensure we scroll after sending our own message
			requestAnimationFrame(() => scrollToBottom());
		},
		[newMessage, websocket, sendUserMessage, isChatDisabled, scrollToBottom, images, clearImages],
	);

	const [progress, total] = useMemo((): [number, number] => {
		// Calculate phase progress instead of file progress
		const completedPhases = phaseTimeline.filter(p => p.status === 'completed').length;

		// Get predicted phase count from blueprint, fallback to current phase count
		const predictedPhaseCount = isPhasicBlueprint(blueprint)
			? blueprint.implementationRoadmap.length
			: 0;
		const totalPhases = Math.max(predictedPhaseCount, phaseTimeline.length, 1);

		return [completedPhases, totalPhases];
	}, [phaseTimeline, blueprint]);

	if (import.meta.env.DEV) {
		logger.debug({
			messages,
			files,
			blueprint,
			query,
			userQuery,
			chatId,
			previewUrl,
			generatingFile,
			activeFile,
			bootstrapFiles,
			streamedBootstrapFiles,
			isGeneratingBlueprint,
			view,
			totalFiles,
			generatingCount,
			isBootstrapping,
			activeFilePath,
			progress,
			total,
			isRunning,
			projectStages,
		});
	}

	return (
		<div className="size-full flex flex-col min-h-0 text-text-primary">
			<div className="flex-1 flex min-h-0 overflow-hidden justify-center">
				<motion.div
					layout="position"
					className="flex-1 shrink-0 flex flex-col basis-0 max-w-lg relative z-10 h-full min-h-0"
				>
					<div
						className={clsx(
							'flex-1 overflow-y-auto min-h-0 chat-messages-scroll',
							isDebugging && 'animate-debug-pulse'
						)}
						ref={messagesContainerRef}
					>
						<div className="pt-5 px-4 pb-4 text-sm flex flex-col gap-5">
							{appLoading ? (
								<div className="flex items-center gap-2 text-text-tertiary">
									<LoaderCircle className="size-4 animate-spin" />
									Loading app...
								</div>
							) : (
								<>
									{(appTitle || chatId) && (
										<div className="flex items-center justify-between mb-2">
											<div className="text-lg font-semibold">{appTitle}</div>
										</div>
									)}
									<UserMessage
										message={query ?? displayQuery}
									/>
									{import.meta.env
										.VITE_AGENT_MODE_ENABLED && (
											<div className="flex justify-between items-center py-2 border-b border-border-primary/50 mb-4">
												<AgentModeDisplay
													mode={
														agentMode as
														| 'deterministic'
														| 'smart'
													}
												/>
											</div>
										)}
								</>
							)}

							{/* Hide the initial "Thinking..." message when waiting for store info */}
							{mainMessage && !(waitingForStoreInfo && mainMessage.content === 'Thinking...') && (
								<div className="relative">
									<AIMessage
										message={mainMessage.content}
										isThinking={mainMessage.ui?.isThinking}
										toolEvents={mainMessage.ui?.toolEvents}
									/>
									{chatId && (
										<div className="absolute right-1 top-1">
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														className="hover:bg-bg-3/80 cursor-pointer"
													>
														<MoreHorizontal className="h-4 w-4" />
														<span className="sr-only">Chat actions</span>
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-56">
													<DropdownMenuItem
														onClick={(e) => {
															e.preventDefault();
															setIsResetDialogOpen(true);
														}}
													>
														<RotateCcw className="h-4 w-4 mr-2" />
														Reset conversation
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									)}
								</div>
							)}

							{otherMessages
								.filter(message => message.role === 'assistant' && message.ui?.isThinking)
								.map((message) => (
									<div key={message.conversationId} className="mb-4">
										<AIMessage
											message={message.content}
											isThinking={true}
											toolEvents={message.ui?.toolEvents}
										/>
									</div>
								))}

							{isThinking && !otherMessages.some(m => m.ui?.isThinking) && (
								<div className="mb-4">
									<AIMessage
										message="Planning next phase..."
										isThinking={true}
									/>
								</div>
							)}

							{otherMessages
								.filter(message => !message.ui?.isThinking)
								.map((message) => {
									if (message.role === 'assistant') {
										return (
											<AIMessage
												key={message.conversationId}
												message={message.content}
												isThinking={message.ui?.isThinking}
												toolEvents={message.ui?.toolEvents}
											/>
										);
									}
									return (
										<UserMessage
											key={message.conversationId}
											message={message.content}
										/>
									);
								})}

							{!waitingForStoreInfo && (
								<PhaseTimeline
									projectStages={projectStages}
									phaseTimeline={phaseTimeline}
									files={files}
									view={view}
									activeFile={activeFile}
									onFileClick={handleFileClick}
									isThinkingNext={isThinking}
									isPreviewDeploying={isPreviewDeploying}
									progress={progress}
									total={total}
									parentScrollRef={messagesContainerRef}
									onViewChange={(viewMode) => {
										setView(viewMode);
										hasSwitchedFile.current = true;
									}}
									runtimeErrorCount={runtimeErrorCount}
									staticIssueCount={staticIssueCount}
									isDebugging={isDebugging}
									isGenerating={isGenerating}
									isThinking={isThinking}
								/>
							)}

						</div>
					</div>

					<form
						ref={chatFormRef}
						onSubmit={onNewMessage}
						className="shrink-0 p-4 pb-5 bg-transparent"
						{...chatDragHandlers}
					>
						<input
							ref={imageInputRef}
							type="file"
							accept={SUPPORTED_IMAGE_MIME_TYPES.join(',')}
							multiple
							onChange={(e) => {
								const files = Array.from(e.target.files || []);
								if (files.length > 0) {
									addImages(files);
								}
								e.target.value = '';
							}}
							className="hidden"
							disabled={isChatDisabled}
						/>
						<div className="relative">
							{isChatDragging && (
								<div className="absolute inset-0 flex items-center justify-center bg-accent/10 backdrop-blur-sm rounded-xl z-50 pointer-events-none">
									<p className="text-accent font-medium">Drop images here</p>
								</div>
							)}
							{images.length > 0 && (
								<div className="mb-2">
									<ImageAttachmentPreview
										images={images}
										onRemove={removeImage}
										compact
									/>
								</div>
							)}
							<textarea
								value={newMessage}
								onChange={(e) => {
									const newValue = e.target.value;
									const newWordCount = countWords(newValue);

									// Only update if within word limit
									if (newWordCount <= MAX_WORDS) {
										setNewMessage(newValue);
										const ta = e.currentTarget;
										ta.style.height = 'auto';
										ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
									}
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										if (!e.shiftKey) {
											// Submit on Enter without Shift
											e.preventDefault();
											onNewMessage(e);
										}
										// Shift+Enter will create a new line (default textarea behavior)
									}
								}}
								disabled={isChatDisabled}
								placeholder={
									isDebugging
										? 'Deep debugging in progress... Please abort to continue'
										: isChatDisabled
											? 'Please wait for blueprint completion...'
											: isRunning
												? 'Chat with AI while generating...'
												: 'Chat with AI...'
								}
								rows={1}
								className="w-full bg-bg-2 border border-text-primary/10 rounded-xl px-3 pr-20 py-2 text-sm outline-none focus:border-white/20 drop-shadow-2xl text-text-primary placeholder:!text-text-primary/50 disabled:opacity-50 disabled:cursor-not-allowed resize-none overflow-y-auto no-scrollbar min-h-[36px] max-h-[120px]"
								style={{
									// Auto-resize based on content
									height: 'auto',
									minHeight: '36px'
								}}
								ref={(textarea) => {
									if (textarea) {
										// Auto-resize textarea based on content
										textarea.style.height = 'auto';
										textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
									}
								}}
							/>
							<div className="absolute right-1.5 bottom-2.5 flex items-center gap-1">
								{(isGenerating || isGeneratingBlueprint || isDebugging) && (
									<button
										type="button"
										onClick={() => {
											if (websocket) {
												sendWebSocketMessage(websocket, 'stop_generation');
											}
										}}
										className="p-1.5 rounded-md hover:bg-red-500/10 text-text-tertiary hover:text-red-500 transition-all duration-200 group relative"
										aria-label="Stop generation"
										title="Stop generation"
									>
										<X className="size-4" strokeWidth={2} />
										<span className="absolute -top-8 right-0 px-2 py-1 bg-bg-1 border border-border-primary rounded text-xs text-text-secondary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
											Stop
										</span>
									</button>
								)}
								<button
									type="button"
									onClick={() => imageInputRef.current?.click()}
									disabled={isChatDisabled || isProcessing}
									className="p-1.5 rounded-md hover:bg-bg-3 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
									aria-label="Upload image"
									title="Upload image"
								>
									<ImageIcon className="size-4" strokeWidth={1.5} />
								</button>
								<button
									type="submit"
									disabled={!newMessage.trim() || isChatDisabled}
									className="p-1.5 rounded-md bg-accent/90 hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent text-white disabled:text-text-primary transition-colors"
								>
									<ArrowRight className="size-4" />
								</button>
							</div>
						</div>
					</form>
				</motion.div>

				<AnimatePresence mode="wait">
					{showMainView && (
						<motion.div
							layout="position"
							className="flex-1 flex shrink-0 basis-0 p-4 pl-0 ml-2 z-30 min-h-0"
							initial={{ opacity: 0, scale: 0.84 }}
							animate={{ opacity: 1, scale: 1 }}
							transition={{ duration: 0.3, ease: 'easeInOut' }}
						>
							{view === 'preview' && previewUrl && (
								<div className="flex-1 flex flex-col bg-bg-3 rounded-xl shadow-md shadow-bg-2 overflow-hidden border border-border-primary">
									<div className="grid grid-cols-3 px-2 h-10 border-b bg-bg-2">
										<div className="flex items-center">
											<ViewModeSwitch
												view={view}
												onChange={handleViewModeChange}
												previewAvailable={!!previewUrl}
												showTooltip={showTooltip}
												hasDocumentation={hasDocumentation}
											/>
										</div>

										<div className="flex items-center justify-center">
											<div className="flex items-center gap-2">
												<span className="text-sm font-mono text-text-50/70">
													{blueprint?.title ??
														'Preview'}
												</span>
												<Copy text={previewUrl} />
												<button
													className="p-1 hover:bg-bg-2 rounded transition-colors"
													onClick={() => {
														setManualRefreshTrigger(
															Date.now(),
														);
													}}
													title="Refresh preview"
												>
													<RefreshCw className="size-4 text-text-primary/50" />
												</button>
											</div>
										</div>

										<div className="flex items-center justify-end gap-1.5">
											{/* <button
												className="flex items-center gap-1.5 px-2 py-1 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white rounded-md transition-all duration-200 text-xs font-medium shadow-sm"
												onClick={() => handleDeployToCloudflare(chatId!)}
												disabled={isDeploying}
												title="Save & Deploy"
											>
												{isDeploying ? (
													<LoaderCircle className="size-3 animate-spin" />
												) : (
													<Save className="size-3" />
												)}
												{isDeploying ? 'Deploying...' : 'Save'}
											</button> */}
											<ModelConfigInfo
												configs={modelConfigs}
												onRequestConfigs={handleRequestConfigs}
												loading={loadingConfigs}
											/>
											<button
												className="group relative flex items-center gap-1.5 p-1.5 group-hover:pl-2 group-hover:pr-2.5 rounded-full group-hover:rounded-md transition-all duration-300 ease-in-out hover:bg-bg-4 border border-transparent hover:border-border-primary hover:shadow-sm overflow-hidden"
												onClick={() => setIsGitCloneModalOpen(true)}
												title="Clone Repository"
											>
												<GitBranch className="size-3.5 text-brand-primary transition-colors duration-300 flex-shrink-0" />
												<span className="max-w-0 group-hover:max-w-[70px] opacity-0 group-hover:opacity-100 overflow-hidden transition-all duration-300 ease-in-out whitespace-nowrap text-xs font-medium text-text-primary">
													Git Clone
												</span>
											</button>
											<button
												className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-all duration-200 text-xs font-medium shadow-sm ${isGitHubExportReady
													? 'bg-gray-800 hover:bg-gray-900 text-white'
													: 'bg-gray-600 text-gray-400 cursor-not-allowed'
													}`}
												onClick={isGitHubExportReady ? githubExport.openModal : undefined}
												disabled={!isGitHubExportReady}
												title={
													isGitHubExportReady
														? "Export to GitHub"
														: !isPhase1Complete
															? "Complete Phase 1 to enable GitHub export"
															: "Waiting for chat session to initialize..."
												}
												aria-label={
													isGitHubExportReady
														? "Export to GitHub"
														: !isPhase1Complete
															? "GitHub export disabled - complete Phase 1 first"
															: "GitHub export disabled - waiting for chat session"
												}
											>
												<Github className="size-3.5" />
												GitHub
											</button>
											<button
												className="p-1.5 rounded-full transition-all duration-300 ease-in-out hover:bg-bg-4 border border-transparent hover:border-border-primary hover:shadow-sm"
												onClick={() => {
													previewRef.current?.requestFullscreen();
												}}
												title="Fullscreen"
											>
												<Expand className="size-3.5 text-text-primary/60 hover:text-brand-primary transition-colors duration-300" />
											</button>
										</div>
									</div>
									<PreviewIframe
										src={previewUrl}
										ref={previewRef}
										className="flex-1 w-full h-full border-0"
										title="Preview"
										shouldRefreshPreview={
											shouldRefreshPreview
										}
										manualRefreshTrigger={
											manualRefreshTrigger
										}
										webSocket={websocket}
										shouldLoad={!isGenerating}
									/>
								</div>
							)}

							{view === 'blueprint' && (
								<div className="flex-1 flex flex-col bg-bg-3 rounded-xl shadow-md shadow-bg-2 overflow-hidden border border-border-primary">
									{/* Toolbar */}
									<div className="grid grid-cols-3 px-2 h-10 bg-bg-2 border-b">
										<div className="flex items-center">
											<ViewModeSwitch
												view={view}
												onChange={handleViewModeChange}
												previewAvailable={!!previewUrl}
												showTooltip={showTooltip}
												hasDocumentation={hasDocumentation}
											/>
										</div>

										<div className="flex items-center justify-center">
											<div className="flex items-center gap-2">
												<span className="text-sm text-text-50/70 font-mono">
													Blueprint.md
												</span>
												{previewUrl && (
													<Copy text={previewUrl} />
												)}
											</div>
										</div>

										<div className="flex items-center justify-end">
											{/* Right side - can add actions here if needed */}
										</div>
									</div>
									<div className="flex-1 overflow-y-auto bg-bg-3">
										<div className="py-12 mx-auto">
											<Blueprint
												blueprint={
													blueprint ??
													({} as BlueprintType)
												}
												className="w-full max-w-2xl mx-auto"
											/>
										</div>
									</div>
								</div>
							)}


							{/* Disabled terminal for now */}
							{/* {view === 'terminal' && (
								<div className="flex-1 flex flex-col bg-bg-3 rounded-xl shadow-md shadow-bg-2 overflow-hidden border border-border-primary">
									<div className="grid grid-cols-3 px-2 h-10 bg-bg-2 border-b">
										<div className="flex items-center">
											<ViewModeSwitch
												view={view}
												onChange={handleViewModeChange}
												previewAvailable={!!previewUrl}
												showTooltip={showTooltip}
												terminalAvailable={true}
											/>
										</div>

										<div className="flex items-center justify-center">
											<div className="flex items-center gap-3">
												<span className="text-sm font-mono text-text-50/70">
													Terminal
												</span>
												<div className={clsx(
													'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
													websocket && websocket.readyState === WebSocket.OPEN
														? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
														: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
												)}>
													<div className={clsx(
														'size-1.5 rounded-full',
														websocket && websocket.readyState === WebSocket.OPEN ? 'bg-green-500' : 'bg-red-500'
													)} />
													{websocket && websocket.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'}
												</div>
											</div>
										</div>

										<div className="flex items-center justify-end gap-1.5">
											<button
												onClick={() => {
													const logText = terminalLogs
														.map(log => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.content}`)
														.join('\n');
													navigator.clipboard.writeText(logText);
												}}
												className={clsx(
													"h-7 w-7 p-0 rounded-md transition-all duration-200",
													"text-gray-500 hover:text-gray-700",
													"dark:text-gray-400 dark:hover:text-gray-200",
													"hover:bg-gray-100 dark:hover:bg-gray-700"
												)}
												title="Copy all logs"
											>
												<Copy text="" />
											</button>
											<ModelConfigInfo
												configs={modelConfigs}
												onRequestConfigs={handleRequestConfigs}
												loading={loadingConfigs}
											/>
										</div>
									</div>
									<div className="flex-1">
										<Terminal
											logs={terminalLogs}
											onCommand={handleTerminalCommand}
											isConnected={!!websocket && websocket.readyState === WebSocket.OPEN}
											className="h-full"
										/>
									</div>
								</div>
							)} */}

							{view === 'editor' && (
								<div className="flex-1 flex flex-col bg-bg-3 rounded-xl shadow-md shadow-bg-2 overflow-hidden border border-border-primary">
									{activeFile && (
										<div className="grid grid-cols-3 px-2 h-10 bg-bg-2 border-b">
											<div className="flex items-center">
												<ViewModeSwitch
													view={view}
													onChange={
														handleViewModeChange
													}
													previewAvailable={
														!!previewUrl
													}
													showTooltip={showTooltip}
													hasDocumentation={hasDocumentation}
												/>
											</div>

											<div className="flex items-center justify-center">
												<div className="flex items-center gap-2">
													<span className="text-sm font-mono text-text-50/70">
														{activeFile.filePath}
													</span>
													{previewUrl && (
														<Copy
															text={previewUrl}
														/>
													)}
												</div>
											</div>

											<div className="flex items-center justify-end gap-1.5">
												{/* <button
													className="flex items-center gap-1.5 px-2 py-1 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white rounded-md transition-all duration-200 text-xs font-medium shadow-sm"
													onClick={() => handleDeployToCloudflare(chatId!)}
													disabled={isDeploying}
													title="Save & Deploy"
												>
													{isDeploying ? (
														<LoaderCircle className="size-3 animate-spin" />
													) : (
														<Save className="size-3" />
													)}
													{isDeploying ? 'Deploying...' : 'Save'}
												</button>
												<button
													className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-all duration-200 text-xs font-medium shadow-sm ${
														isPhase1Complete
															? 'bg-gray-800 hover:bg-gray-900 text-white'
															: 'bg-gray-600 text-gray-400 cursor-not-allowed'
													}`}
													onClick={isPhase1Complete ? githubExport.openModal : undefined}
													disabled={!isPhase1Complete}
													title={isPhase1Complete ? "Export to GitHub" : "Complete Phase 1 to enable GitHub export"}
													aria-label={isPhase1Complete ? "Export to GitHub" : "GitHub export disabled - complete Phase 1 first"}
												>
													<Github className="size-3.5" />
													GitHub
												</button> */}
												<ModelConfigInfo
													configs={modelConfigs}
													onRequestConfigs={handleRequestConfigs}
													loading={loadingConfigs}
												/>
												<button
													className="p-1.5 rounded-full transition-all duration-300 ease-in-out hover:bg-bg-4 border border-transparent hover:border-border-primary hover:shadow-sm"
													onClick={() => {
														editorRef.current?.requestFullscreen();
													}}
													title="Fullscreen"
												>
													<Expand className="size-3.5 text-text-primary/60 hover:text-brand-primary transition-colors duration-300" />
												</button>
											</div>
										</div>
									)}
									<div className="flex-1 relative">
										<div
											className="absolute inset-0 flex"
											ref={editorRef}
										>
											<FileExplorer
												files={files}
												currentFile={activeFile}
												onFileClick={handleFileClick}
											/>
											<div className="flex-1">
												<MonacoEditor
													className="h-full"
													createOptions={{
														value:
															activeFile?.fileContents ||
															'',
														language:
															activeFile?.language ||
															'plaintext',
														readOnly: true,
														minimap: {
															enabled: false,
														},
														lineNumbers: 'on',
														scrollBeyondLastLine: false,
														fontSize: 13,
														theme: 'v1-dev',
														automaticLayout: true,
													}}
													find={
														edit &&
															edit.filePath ===
															activeFile?.filePath
															? edit.search
															: undefined
													}
													replace={
														edit &&
															edit.filePath ===
															activeFile?.filePath
															? edit.replacement
															: undefined
													}
												/>
											</div>
										</div>
									</div>
								</div>
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* Debug Panel - Removed for production */}

			<ChatModals
				debugMessages={[]}
				chatId={chatId}
				onClearDebugMessages={() => {}}
				isResetDialogOpen={isResetDialogOpen}
				onResetDialogChange={setIsResetDialogOpen}
				onResetConversation={handleResetConversation}
				githubExport={githubExport}
				app={app}
				urlChatId={urlChatId}
				isGitCloneModalOpen={isGitCloneModalOpen}
				onGitCloneModalChange={setIsGitCloneModalOpen}
				user={user}
			/>

			<VaultUnlockModal
				open={vaultState.unlockRequested && vaultState.status === 'locked'}
				onOpenChange={(open) => {
					if (!open) clearUnlockRequest();
				}}
				reason={vaultState.unlockReason ?? undefined}
			/>
		</div>
	);
}
