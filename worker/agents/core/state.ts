import type {
    Blueprint, DesignDNA, PhaseConceptType,
    FileOutputType,
} from '../schemas';
// import type { ScreenshotData } from './types';
import type { ConversationMessage } from '../inferutils/common';
import type { InferenceContext } from '../inferutils/config.types';
import type { ImageAttachment, ProcessedImageAttachment } from 'worker/types/image-attachment';

export interface FileState extends FileOutputType {
    lastDiff: string;
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

export const MAX_PHASES = 12;

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
    phasesCounter: number;

    pendingUserInputs: string[];
    currentDevState: CurrentDevState;
    reviewCycles?: number; // Number of review cycles for code review phase
    currentPhase?: PhaseConceptType; // Current phase being worked on

    conversationMessages: ConversationMessage[];
    projectUpdatesAccumulator: string[];
    inferenceContext: InferenceContext;

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
