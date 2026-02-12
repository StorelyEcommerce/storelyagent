import type {
    Blueprint, DesignDNA, PhaseConceptType,
    FileOutputType,
    Blueprint,
} from '../schemas';
// import type { ScreenshotData } from './types';
import type { ConversationMessage } from '../inferutils/common';
import type { InferenceContext } from '../inferutils/config.types';
import type { ImageAttachment, ProcessedImageAttachment } from 'worker/types/image-attachment';

export interface FileState extends FileOutputType {
    lastDiff: string;
}

export interface FileServingToken {
    token: string;
    createdAt: number;
}

export interface PhaseState extends PhaseConceptType {
    // deploymentNeeded: boolean;
    completed: boolean;
}

export enum CurrentDevState {
    IDLE,
    PHASE_GENERATING,
    PHASE_IMPLEMENTING,
    REVIEWING,
    FINALIZING,
}

export const MAX_PHASES = 10;

export interface CodeGenState {
    blueprint: Blueprint;
    designDNA?: DesignDNA;
    projectName: string,
    query: string;
    generatedFilesMap: Record<string, FileState>;
    generatedPhases: PhaseState[];
    commandsHistory?: string[]; // History of commands run
    lastPackageJson?: string; // Last package.json file contents
    templateName: string;
    sandboxInstanceId?: string;

    shouldBeGenerating: boolean; // Persistent flag indicating generation should be active
    mvpGenerated: boolean;
    reviewingInitiated: boolean;
    agentMode: 'deterministic' | 'smart';
    sessionId: string;
    hostname: string;

    pendingUserInputs: string[];
    currentDevState: CurrentDevState;
    reviewCycles?: number; // Number of review cycles for code review phase
    currentPhase?: PhaseConceptType; // Current phase being worked on

    conversationMessages: ConversationMessage[];
    projectUpdatesAccumulator: string[];
    
    // Deep debug
    lastDeepDebugTranscript: string | null;
    isDeepDebugging?: boolean; // Track if debug session is active
    storeInfoPending?: boolean; // Track if waiting for store info before initialization
    storeStylePending?: boolean; // Track if waiting for store style selection before initialization
    storeStyleMessage?: string; // Message to broadcast when style selection is needed
    storeStyleOptions?: ProcessedImageAttachment[]; // Generated style options for selection
    pendingInitArgs?: {
        query: string;
        language: string;
        frameworks: string[];
        hostname: string;
        inferenceContext: InferenceContext;
        images?: Array<ImageAttachment | ProcessedImageAttachment>;
        storeInfoMessage?: string; // Message to broadcast via WebSocket asking for store info
    }; // Stored init args when waiting for store info before initialization
} 
