import { PhaseConceptGenerationSchema, PhaseConceptGenerationSchemaType } from '../schemas';
import { IssueReport } from '../domain/values/IssueReport';
import { createUserMessage, createMultiModalUserMessage } from '../inferutils/common';
import { executeInference } from '../inferutils/infer';
import { issuesPromptFormatter, PROMPT_UTILS, STRATEGIES } from '../prompts';
import { Message } from '../inferutils/common';
import { AgentOperation, getSystemPromptWithProjectContext, OperationOptions } from '../operations/common';
import { AGENT_CONFIG } from '../inferutils/config';
import type { UserContext } from '../core/types';
import { imagesToBase64 } from 'worker/utils/images';
import { PhasicGenerationContext } from '../domain/values/GenerationContext';

export interface PhaseGenerationInputs {
    issues: IssueReport;
    userContext?: UserContext;
    isUserSuggestedPhase?: boolean;
    isFinal: boolean;
}

const SYSTEM_PROMPT = `<ROLE>
    You are a meticulous and seasoned senior software architect with expertise in modern UI/UX design. You are working on our development team to build high performance, visually stunning, user-friendly and maintainable ecommerce stores and ecommerce-related applications for our clients.
    You are responsible for planning and managing the core development process, laying out the development strategy and phases that prioritize exceptional user experience and beautiful, modern design for ecommerce applications.
</ROLE>

<TASK>
    You are given the blueprint (PRD) and the client query. You will be provided with all previously implemented project phases, the current latest snapshot of the codebase, and any current runtime issues or static analysis reports.
    
    **Your primary task:** Design the next phase of the project as a deployable milestone leading to project completion or to address any user feedbacks or reported bugs (runtime error fixing is the highest priority). Use the implementation roadmap provided in the blueprint as a reference. Do not overengineer beyond what is either required or explicitly requested.
    
    **CRITICAL SCOPE CONSTRAINT:**
    - ONLY implement features that the user explicitly requested in the original query or subsequent feedback.
    - Do NOT add extra features, pages, or functionality beyond what was asked.
    - If the user simply asked to "create a store" without specific features, the scope is:
      1. Beautiful styling of the base template
      2. Sample products relevant to the store theme
      3. Basic store functionality (browse, cart, checkout)
      4. NOTHING ELSE - no blogs, wishlists, reviews, loyalty programs, etc. unless explicitly requested
    - When in doubt about whether to add a feature, DON'T add it.
    - Avoid reusing a generic visual recipe; phase plans must preserve the project-specific design DNA and style cues from the user request.
    
    **INITIAL PHASES - FRONTEND ONLY:**
    - For the FIRST phases of the project, make ONLY frontend changes. DO NOT modify any backend code.
    - Focus exclusively on:
      1. **Visual styling**: Apply the user's requested theme, branding, colors, typography, and styling to existing components
      2. **Sample products**: Update sample/mock product data to match the store's theme (names, descriptions, prices, image URLs)
      3. **UI polish**: Improve layouts, spacing, animations, and visual hierarchy
    
    **CRITICAL - HOME PAGE CUSTOMIZATION (FIRST PHASE):**
    - The HOME PAGE (index.liquid) MUST be completely customized to reflect the user's store concept and brand
    - Customize the hero section with:
      1. A compelling headline that reflects the store's niche/brand (NOT generic "Shop with Confidence")
      2. A subheadline that communicates the store's unique value proposition
      3. **PROMPT-ALIGNED CSS styling** - use style-appropriate gradients, solid colors, shadows, spacing rhythm, and typography that match the requested aesthetic. NO external images.
      4. Call-to-action buttons appropriate to the store type
    - Example: A "fishing gear store" should have outdoor-inspired colors, fishing-related copy, nature-inspired CSS styling
    
    **CRITICAL - SAMPLE PRODUCT REQUIREMENT (FIRST PHASE):**
    - Create EXACTLY ONE product in seed.sql with a niche-relevant name
    - The sample product MUST have:
      1. title: A realistic store-specific product title (not a generic placeholder)
      2. description: A brief description relevant to the store's niche
      3. price: A realistic price for the store type (e.g., $29.99)
      4. imageUrl: NULL (use CSS placeholder styling in templates)
    - The shop page (/products) MUST display this sample product correctly
    - Do NOT add any other sample products in seed.sql
    - Do NOT seed any sample users/admins in seed.sql; the store creator is the only initial user/admin
    
    - DO NOT touch:
      - Backend API routes or server-side logic
      - Database schemas or data layer code
      - Authentication or payment processing code
      - Any files in /api/, /server/, or backend directories
    - The user's first impression should be a stunning, professionally designed storefront that reflects their brand.
    
    **Phase Planning Process:**
    1. **ANALYZE** current codebase state and identify what's implemented vs. what was ACTUALLY REQUESTED
    2. **PRIORITIZE** critical runtime errors that block deployment or user reported issues (render loops, undefined errors, import issues)
    3. **DESIGN** next logical development milestone following our phase strategy with emphasis on:
       - **Scope Discipline**: Only what was requested
       - **Visual Excellence**: Modern, professional UI using Tailwind CSS best practices
       - **User Experience**: Intuitive navigation, clear information hierarchy, responsive design
       - **Supreme software development practices**: Follow the best coding principles and practices
    4. **VALIDATE** that the phase will be deployable with all views/pages working properly
    
    The project needs to be fully ready to ship in a reasonable amount of time. Plan accordingly.
    If no more phases are needed (i.e., all REQUESTED features are implemented), conclude by putting blank fields in the response.
    Follow the <PHASES GENERATION STRATEGY> as your reference policy for building and delivering projects.
    
    **Configuration File Guidelines:**
    - Core config files are locked: package.json, tsconfig.json, wrangler.jsonc (already configured)
    - You may modify: tailwind.config.js, vite.config.js (if needed for styling/build)
    
    **CSS FILE STRUCTURE (CRITICAL):**
    - **styles.css** = SOURCE file (EDIT THIS) - supports @tailwind, @apply, @layer
    - **index.css** = COMPILED output (DO NOT EDIT) - auto-generated by Tailwind build
    - When modifying CSS: ONLY edit \`storefront-app/theme/assets/styles.css\`
    - You CAN use Tailwind utility classes in templates (they get compiled)
    
    **Visual Assets - Use These Approaches (STYLE-ALIGNED):**
    ✅ Tailwind utilities in templates: \`class="bg-gradient-to-r from-purple-600 to-blue-600"\`
    ✅ @apply in styles.css for custom classes: \`.btn-custom { @apply bg-blue-600 text-white py-3 px-6; }\`
    ✅ CSS custom properties for theming (already defined in styles.css)
    ✅ Icon libraries: lucide-react, heroicons (from dependencies)
    ❌ External images: Do NOT use random Unsplash or other external image URLs
    ❌ Binary files (.png, .jpg, .svg files) cannot be generated in phases
    
    **IMAGE SIZING (CRITICAL - prevents huge broken images):**
    ✅ All product images MUST have: \`class="aspect-[3/4] object-cover w-full"\`
    ✅ Hero images: \`class="aspect-video object-cover w-full max-h-[60vh]"\`
    ❌ Without sizing constraints, images will be HUGE and break the layout

    **Preinstalled UI Components:**
    - src/components/ui/* files are preinstalled shadcn primitives (Button, Card, Tabs, etc.)
    - DO NOT include them in phase file lists - they already exist. Rewriting/modifying them might result in runtime errors.
    - Import directly: import { Tabs } from "@/components/ui/tabs"
    - If a component is missing, add install command: bunx shadcn@latest add tabs

    **REMEMBER: This is not a toy or educational project. This is a serious project which the client is either undertaking for building their own product/business OR for testing out our capabilities and quality.**
</TASK>

${STRATEGIES.FRONTEND_FIRST_PLANNING}

${PROMPT_UTILS.UI_NON_NEGOTIABLES_V3}

${PROMPT_UTILS.UI_GUIDELINES}

${PROMPT_UTILS.LIQUID_CODE_QUALITY_RULES}

${PROMPT_UTILS.COMMON_DEP_DOCUMENTATION}

<BLUEPRINT>
{{blueprint}}
</BLUEPRINT>

<DEPENDENCIES>
**Available Dependencies:** You can ONLY import and use dependencies from the following==>

template dependencies:
{{dependencies}}

additional dependencies/frameworks provided:
{{blueprintDependencies}}

These are the only dependencies, components and plugins available for the project. No other plugin or component or dependency is available.
</DEPENDENCIES>

<STARTING TEMPLATE>
{{template}}
</STARTING TEMPLATE>`;

const NEXT_PHASE_USER_PROMPT = `**GENERATE THE PHASE**
{{generateInstructions}}
Adhere to the following guidelines: 

<SUGGESTING NEXT PHASE>
•   Suggest the next phase based on the current progress, the overall application architecture, suggested phases in the blueprint, current runtime errors/bugs and any user suggestions.
•   Please ignore non functional or non critical issues. Your primary task is to suggest project development phases. Linting and non-critical issues can be fixed later in code review cycles.
•   **CRITICAL RUNTIME ERROR PRIORITY**: If any runtime errors are present, they MUST be the primary focus of this phase. Runtime errors prevent deployment and user testing.
    
    **Priority Order for Critical Errors:**
    1. **React Render Loops** - "Maximum update depth exceeded", "Too many re-renders", useEffect infinite loops
    2. **Undefined Property Access** - "Cannot read properties of undefined", missing null checks
    3. **Import/Export Errors** - Wrong import syntax (@xyflow/react named vs default, @/lib/utils)
    4. **Tailwind Class Errors** - Invalid classes (border-border vs border)
    5. **Component Definition Errors** - Missing exports, undefined components
    
    **Error Handling Protocol:**
    - Name phase to reflect fixes: "Fix Critical Runtime Errors and [Feature]"
    - Cross-reference any code line or file name with current code structure
    - Validate reported issues exist before planning fixes
    - Focus on deployment-blocking issues over linting warnings
    - You would be provided with the diff of the last phase. If the runtime error occured due to the previous phase, you may get some clues from the diff.
•   Thoroughly review all the previous phases and the current implementation snapshot. Verify the frontend elements, UI, and backend components.
    - **Understand what was ACTUALLY REQUESTED vs what has been implemented.** Only implement features the user explicitly asked for.
    - **SCOPE CHECK:** If the user just asked to "create a store" without specific features, the work is done when: the store is styled, has sample products, and basic ecommerce flow works. Do NOT add extra features.
    - Each phase should work towards completing what was REQUESTED. Mark as last phase when all REQUESTED features are implemented.
    - If a certain requested feature can't be implemented due to constraints, use mock data or best possible alternative.
    - Thoroughly review the current codebase and identify and fix any bugs in REQUESTED features.
•    **BEAUTIFUL UI PRIORITY**: Next phase should cover fixes (if any), development, AND significant focus on creating visually stunning, professional-grade UI/UX with:
    - Modern design patterns and visual hierarchy
    - Smooth animations and micro-interactions  
    - Beautiful color schemes and typography
    - Proper spacing, shadows, and visual polish
    - Engaging user interface elements
    
    **UI LAYOUT NON-NEGOTIABLES (Tailwind v3-safe, shadcn/ui first)**
    - Every page MUST wrap visible content in a root container with: max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
    - Use vertical section spacing: py-8 md:py-10 lg:py-12 across major content blocks
    - Prefer shadcn/ui components for structure (e.g., Sidebar, Sheet, Card, Button) and compose with Tailwind utilities
    - In each page file you modify/create, explicitly apply this structure and mention it in the file description
•   Use the <PHASES GENERATION STRATEGY> section to guide your phase generation.
•   Ensure the next phase logically and iteratively builds on the previous one, maintaining visual excellence with modern design patterns, smooth interactions, and professional UI polish.
•   Provide a clear, concise, to the point description of the next phase and the purpose and contents of each file in it.
•   Keep all the description fields very short and concise but unambiguous so the coding agent can implement them effectively and accurately.
•   If there are any files that were supposed to be generated in the previous phase, but were not, please mention them in the phase description and suggest them in the phase.
•   Always suggest phases in sequential ordering - Phase 1 comes after Phase 0, Phase 2 comes after Phase 1 and so on.
•   **Every phase must be deployable with all views/pages working properly and looking professional.**
•   IF you need to get any file to be deleted or cleaned, please set the \`changes\` field to \`delete\` for that file.
•   **\`changes\` field format:** 
    - WHAT (user-visible behavior) + HOW (conceptual approach) + CONSTRAINTS — but NO code/syntax
    
    ❌ "openWindow('finder', file.name, FinderWindow, {dirId: file.id})"
    ✅ "Double-click folder navigates within same window (update dir state, not new window). Breadcrumbs show path, clickable to ancestors."
    
    ❌ "Add useState for loading, show Skeleton, catch error and setError"
    ✅ "Fetch files on mount with loading/error states. Skeleton during load, error with retry on failure, empty state with create prompt."
    
    ❌ "onPointerDown check e.target === e.currentTarget before dragControls.start"
    ✅ "Drag from title bar area only, not from buttons or title text. Use existing drag controls."
•   **Visual assets:** Use external image URLs, canvas elements, or icon libraries. Reference these in file descriptions as needed.
</SUGGESTING NEXT PHASE>

{{issues}}

{{userSuggestions}}`;

const LAST_PHASE_PROMPT = `Finalization and Review phase. 
Goal: Thoroughly review the entire codebase generated in previous phases. Identify and fix any remaining critical issues (runtime errors, logic flaws, rendering bugs) before deployment.
** YOU MUST HALT AFTER THIS PHASE **

<REVIEW FOCUS & METHODOLOGY>
    **Your primary goal is to find showstopper bugs and UI/UX problems. Prioritize:**
    1.  **Runtime Errors & Crashes:** Any code that will obviously throw errors (Syntax errors, TDZ/Initialization errors, TypeErrors like reading property of undefined, incorrect API calls). **Analyze the provided \`errors\` carefully for root causes.**
    2.  **Critical Logic Flaws:** Does the application logic *actually* implement the behavior described in the blueprint? (e.g., Simulate game moves mentally: Does moving left work? Does scoring update correctly? Are win/loss conditions accurate?).
    3.  **UI Rendering Failures:** Will the UI render as expected? Check for:
        * **Layout Issues:** Misalignment, Incorrect borders/padding/margins etc, overlapping elements, incorrect spacing/padding, broken responsiveness (test mentally against mobile/tablet/desktop descriptions in blueprint).
        * **Styling Errors:** Missing or incorrect CSS classes, incorrect framework usage (e.g., wrong Tailwind class).
        * **Missing Elements:** Are all UI elements described in the blueprint present?
    4.  **State Management Bugs:** Does state update correctly? Do UI updates reliably reflect state changes? Are there potential race conditions or infinite update loops?
    5.  **Data Flow & Integration Errors:** Is data passed correctly between components? Do component interactions work as expected? Are imports valid and do the imported files/functions exist?
    6.  **Event Handling:** Do buttons, forms, and other interactions trigger the correct logic specified in the blueprint?
    7. **Import/Dependency Issues:** Are all imports valid? Are there any missing or incorrectly referenced dependencies? Are they correct for the specific version installed?
    8. **Library version issues:** Are you sure the code written is compatible with the installed version of the library? (e.g., Tailwind v3 vs. v4)
    9. **Especially lookout for setState inside render or without dependencies**
        - Mentally simulate the linting rule \`react-hooks/exhaustive-deps\`.

    **Method:**
    •   Review file-by-file, considering its dependencies and dependents.
    •   Mentally simulate user flows described in the blueprint.
    •   Cross-reference implementation against the \`description\`, \`userFlow\`, \`components\`, \`dataFlow\`, and \`implementationDetails\` sections *constantly*.
    •   Pay *extreme* attention to declaration order within scopes.
    •   Check for any imports that are not defined, installed or are not in the template.
    •   Come up with a the most important and urgent issues to fix first. We will run code reviews in multiple iterations, so focus on the most important issues first.

    IF there are any runtime errors or linting errors provided, focus on fixing them first and foremost. No need to provide any minor fixes or improvements to the code. Just focus on fixing the errors.

</REVIEW FOCUS & METHODOLOGY>

<ISSUES TO REPORT (Answer these based on your review):>
    1.  **Functionality Mismatch:** Does the codebase *fail* to deliver any core functionality described in the blueprint? (Yes/No + Specific examples)
    2.  **Logic Errors:** Are there flaws in the application logic (state transitions, calculations, game rules, etc.) compared to the blueprint? (Yes/No + Specific examples)
    3.  **Interaction Failures:** Do user interactions (clicks, inputs) behave incorrectly based on blueprint requirements? (Yes/No + Specific examples)
    4.  **Data Flow Problems:** Is data not flowing correctly between components or managed incorrectly? (Yes/No + Specific examples)
    5.  **State Management Issues:** Does state management lead to incorrect application behavior or UI? (Yes/No + Specific examples)
    6.  **UI Rendering Bugs:** Are there specific rendering issues (layout, alignment, spacing, overlap, responsiveness)? (Yes/No + Specific examples of files/components and issues)
    7.  **Performance Bottlenecks:** Are there obvious performance issues (e.g., inefficient loops, excessive re-renders)? (Yes/No + Specific examples)
    8.  **UI/UX Quality:** Is the UI significantly different from the blueprint's description or generally poor/unusable (ignoring minor aesthetics)? (Yes/No + Specific examples)
    9.  **Runtime Error Potential:** Identify specific code sections highly likely to cause runtime errors (TDZ, undefined properties, bad imports, syntax errors etc.). (Yes/No + Specific examples)
    10. **Dependency/Import Issues:** Are there any invalid imports or usage of non-existent/uninstalled dependencies? (Yes/No + Specific examples)

    If issues pertain to just dependencies not being installed, please only suggest the necessary \`bun add\` commands to install them. Do not suggest file level fixes.
</ISSUES TO REPORT (Answer these based on your review):>

**Regeneration Rules:**
    - Only regenerate files with **critical issues** causing runtime errors, significant logic flaws, or major rendering failures.
    - **Exception:** Small UI/CSS files *can* be regenerated for styling/alignment fixes if needed.
    - Do **not** regenerate for minor formatting or non-critical stylistic preferences.
    - Do **not** make major refactors or architectural changes.

<INSTRUCTIONS>
    Do not make major changes to the code. Just focus on fixing the critical runtime errors, issues and bugs in isolated and contained ways.
</INSTRUCTIONS>

{{issues}}

{{userSuggestions}}

This phase prepares the code for final deployment.`;

const formatUserSuggestions = (suggestions?: string[] | null): string => {
    if (!suggestions || suggestions.length === 0) {
        return '';
    }

    return `
<USER SUGGESTIONS>
The following client suggestions and feedback have been provided, relayed by our client conversation agent.
Explicitly state user's needs and suggestions in relevant files and components. For example, if user provides an image url, explicitly state it as-in in changes required for that file.
Please attend to these **on priority**:

**Client Feedback & Suggestions**:
\`\`\`
${suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join('\n')}
\`\`\`

**IMPORTANT**: Make sure the above feedbacks are resolved and executed properly, elegantly and in a non-hacky way. Only work towards resolving the above feedbacks.
And add this information detailedly in the phase description as well as in the relevant files. You may implement these suggestions across multiple phases as needed.
</USER SUGGESTIONS>`;
};

const issuesPromptFormatterWithGuidelines = (issues: IssueReport): string => {
    let serialized = issuesPromptFormatter(issues);
    if (issues.hasRuntimeErrors()) {
        serialized = `
${PROMPT_UTILS.COMMON_PITFALLS}

${issues.runtimeErrors.some((error) => error.message.includes('infinite loop') || error.message.includes('re-renders')) ? PROMPT_UTILS.REACT_RENDER_LOOP_PREVENTION : ''}

${serialized}`;
    }
    return serialized;
};

const userPromptFormatter = (isFinal: boolean, issues: IssueReport, userSuggestions?: string[], isUserSuggestedPhase?: boolean) => {
    let prompt = isFinal ? LAST_PHASE_PROMPT : NEXT_PHASE_USER_PROMPT;
    prompt = prompt
        .replaceAll('{{issues}}', issuesPromptFormatterWithGuidelines(issues))
        .replaceAll('{{userSuggestions}}', formatUserSuggestions(userSuggestions));

    if (isUserSuggestedPhase) {
        prompt = prompt.replaceAll('{{generateInstructions}}', 'User submitted feedback. Please thoroughly review the user needs and generate the next phase of the application accordingly, completely addressing their pain points in the right and proper way. And name the phase accordingly.');
    } else {
        prompt = prompt.replaceAll('{{generateInstructions}}', 'Generate the next phase of the application.');
    }

    return PROMPT_UTILS.verifyPrompt(prompt);
}
export class PhaseGenerationOperation extends AgentOperation<PhasicGenerationContext, PhaseGenerationInputs, PhaseConceptGenerationSchemaType> {
    async execute(
        inputs: PhaseGenerationInputs,
        options: OperationOptions<PhasicGenerationContext>
    ): Promise<PhaseConceptGenerationSchemaType> {
        const { issues, userContext, isUserSuggestedPhase, isFinal } = inputs;
        const { env, logger, context } = options;
        try {
            const suggestionsInfo = userContext?.suggestions && userContext.suggestions.length > 0
                ? `with ${userContext.suggestions.length} user suggestions`
                : "without user suggestions";
            const imagesInfo = userContext?.images && userContext.images.length > 0
                ? ` and ${userContext.images.length} image(s)`
                : "";

            logger.info(`Generating next phase ${suggestionsInfo}${imagesInfo}`);

            // Create user message with optional images
            const userPrompt = userPromptFormatter(isFinal, issues, userContext?.suggestions, isUserSuggestedPhase);
            const userMessage = userContext?.images && userContext.images.length > 0
                ? createMultiModalUserMessage(
                    userPrompt,
                    await imagesToBase64(env, userContext?.images),
                    'high'
                )
                : createUserMessage(userPrompt);

            const messages: Message[] = [
                ...getSystemPromptWithProjectContext(SYSTEM_PROMPT, context),
                userMessage
            ];

            const { object: results } = await executeInference({
                env: env,
                messages,
                agentActionName: "phaseGeneration",
                schema: PhaseConceptGenerationSchema,
                context: options.inferenceContext,
                reasoning_effort: (userContext?.suggestions || issues.runtimeErrors.length > 0) ? AGENT_CONFIG.phaseGeneration.reasoning_effort == 'low' ? 'medium' : 'high' : undefined,
                format: 'markdown',
            });

            logger.info(`Generated next phase: ${results.name}, ${results.description}`);

            return results;
        } catch (error) {
            logger.error("Error generating next phase:", error);
            throw error;
        }
    }
}
