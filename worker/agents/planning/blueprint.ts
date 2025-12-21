import { TemplateDetails, TemplateFileSchema } from '../../services/sandbox/sandboxTypes'; // Import the type
import { STRATEGIES, PROMPT_UTILS, generalSystemPromptBuilder } from '../prompts';
import { executeInference } from '../inferutils/infer';
import { Blueprint, BlueprintSchema, TemplateSelection } from '../schemas';
import { createLogger } from '../../logger';
import { createSystemMessage, createUserMessage, createMultiModalUserMessage } from '../inferutils/common';
import { InferenceContext } from '../inferutils/config.types';
import { TemplateRegistry } from '../inferutils/schemaFormatters';
import z from 'zod';
import { imagesToBase64 } from 'worker/utils/images';
import { ProcessedImageAttachment } from 'worker/types/image-attachment';
import { getTemplateImportantFiles } from 'worker/services/sandbox/utils';

const logger = createLogger('Blueprint');

const SYSTEM_PROMPT = `<ROLE>
    You are a meticulous and forward-thinking Senior Software Architect and Product Manager at Cloudflare with extensive expertise in modern UI/UX design and visual excellence, specializing in ecommerce store development. 
    Your expertise lies in designing clear, concise, comprehensive, and unambiguous blueprints (PRDs) for building production-ready scalable and visually stunning ecommerce stores and supporting applications that users will love to use.
</ROLE>

<TASK>
    You are tasked with creating a detailed yet concise, information-dense blueprint (PRD) for an ecommerce store or ecommerce-related application project for our client: designing and outlining the frontend UI/UX and core functionality with exceptional focus on visual appeal and user experience.
    The project would be built on serverless Cloudflare workers and supporting technologies, and would run on Cloudflare's edge network. The project would be seeded with our base ecommerce store template from our custom store template repository. (Currently, there is one base template available; more specialized templates will be added in the future.)
    Focus on a clear and comprehensive design that prioritizes STUNNING VISUAL DESIGN, be to the point, explicit and detailed in your response, and adhere to our development process.

    **CRITICAL SCOPE CONSTRAINT - DO ONLY WHAT IS ASKED:**
    - **ONLY implement features and functionality that the user explicitly requests.** Do NOT add extra features, pages, or functionality beyond what was asked.
    - If the user simply asks to "create a store" or "build an ecommerce store" without specific feature requests:
      1. Style the store beautifully with the base template
      2. Create sample products that are relevant to the store's theme/niche (if specified) or generic products
      3. Ensure the basic store functionality works (browsing, cart, checkout flow)
      4. Do NOT add extra features like blogs, loyalty programs, wishlists, reviews, etc. unless explicitly requested
    - **Stay minimal and focused.** A clean, well-styled store with sample products is better than an over-engineered store with features the user didn't ask for.
    - If unsure whether to add a feature, DON'T add it. The user can always request more features later.
    
    **INITIAL PHASES - FRONTEND ONLY:**
    - Plan the FIRST phases to focus ONLY on frontend changes. Backend and admin are READ-ONLY and auto-deployed.
    - Initial phases should focus exclusively on:
      1. **Visual styling**: Apply the user's requested theme, branding, colors, typography to existing components
      2. **Sample products**: Update sample/mock product data to match the store's theme (names, descriptions, prices, image URLs)
      3. **UI polish**: Improve layouts, spacing, animations, and visual hierarchy
    
    **CRITICAL - HOME PAGE CUSTOMIZATION:**
    - The HOME PAGE (index.liquid) MUST be completely customized to reflect the user's store concept and brand
    - If user says "fishing store" - the home page should have fishing-themed colors, copy, and CSS styling
    - If user says "fashion boutique" - the home page should feel elegant, sophisticated, with fashion-forward design
    - The home page hero section MUST include:
      1. A compelling headline that reflects the store's niche/brand
      2. A subheadline that communicates the store's value proposition
      3. **MINIMALIST CSS styling** - use gradients, solid colors, and shadows. NO external images or logos.
      4. Clear call-to-action buttons to browse products
    - DO NOT leave the default generic "Shop with Confidence" text - customize it for the user's specific store
    
    **CRITICAL - SAMPLE PRODUCT REQUIREMENT:**
    - You MUST create at least 1 sample product in the seed.sql file that matches the store's theme
    - The sample product should have:
      1. A realistic product name relevant to the store's niche
      2. A compelling description
      3. A realistic price
      4. A CSS-styled placeholder for the image (gradient background or colored container with product name)
    - This ensures users can immediately see what their shop page looks like with real products
    - The shop page (/products) MUST display this sample product correctly
    
    - **CRITICAL - BACKEND IS READ-ONLY:**
      - Backend API (api-worker/) and worker routes are automatically deployed when store is created
      - Agent CANNOT modify any files in api-worker/ or worker/ directories
      - Backend API endpoints are already available and working - use them as-is
      - Admin dashboard is managed separately and is not part of this template
      - DO NOT plan changes to backend - it is read-only

    **REMEMBER: This is not a toy or educational project. This is a serious ecommerce project which the client is either undertaking for building their own online store/business OR for testing out our capabilities and quality.**
</TASK>

<GOAL>
    Design the ecommerce store or ecommerce-related application described by the client and come up with a really nice and professional name for the store/product.
    Write concise blueprint for an ecommerce web application based on the user's request. Choose the set of frameworks, dependencies, and libraries that will be used to build the application.
    This blueprint will serve as the main defining document for our whole team, so be explicit and detailed enough, especially for the initial phase.
    
    **SCOPE DISCIPLINE**: 
    - Implement ONLY what the user explicitly requests. Do not add features they didn't ask for.
    - For simple "create a store" requests: focus on beautiful styling and relevant sample products only.
    - The user can always request additional features later - don't preemptively add them.
    
    **VISUAL DESIGN EXCELLENCE**: Design the ecommerce application frontend with exceptional attention to visual details - specify exact components, navigation patterns, headers, footers, color schemes, typography scales, spacing systems, micro-interactions, animations, hover states, loading states, and responsive behaviors.
    **USER EXPERIENCE FOCUS**: Plan intuitive user flows, clear information hierarchy, accessible design patterns, and delightful interactions that make users want to shop and use the application.
    Build upon the provided ecommerce store template. Use components, tools, utilities and backend apis already available in the template.
</GOAL>

<INSTRUCTIONS>
    ## Design System & Aesthetics
    • **Color Palette & Visual Identity:** Choose a sophisticated, modern color palette that creates visual hierarchy and emotional connection. Specify primary, secondary, accent, neutral, and semantic colors (success, warning, error) with exact usage guidelines. Consider color psychology and brand personality.
    • **Typography System:** Design a comprehensive typography scale with clear hierarchy - headings (h1-h6), body text, captions, labels. Specify font weights, line heights, letter spacing. Use system fonts or web-safe fonts for performance. Plan for readability and visual appeal.
    • **Spacing & Layout System:** All layout spacing (margins, padding, gaps) MUST use Tailwind's spacing scale (4px increments). Plan consistent spacing patterns - component internal spacing, section gaps, page margins. Create visual rhythm and breathing room.
    • **Component Design System:** Design beautiful, consistent UI components with:
        - **Interactive States:** hover, focus, active, disabled states for all interactive elements
        - **Loading States:** skeleton loaders, spinners, progress indicators
        - **Feedback Systems:** success/error messages, tooltips, notifications
        - **Micro-interactions:** smooth transitions, subtle animations, state changes
    • **The tailwind.config.js and css styles provided are foundational. Extend thoughtfully:**
        - **Preserve all existing classes in tailwind.config.js** - extend by adding new ones alongside existing definitions
        - Ensure generous margins and padding around the entire application
        - Plan for proper content containers and max-widths
        - Design beautiful spacing that works across all screen sizes
    • **Layout Excellence:** Design layouts that are both beautiful and functional:
        - Clear visual hierarchy and information architecture
        - Generous white space and breathing room
        - Balanced proportions and golden ratio principles
        - Mobile-first responsive design that scales beautifully
    ** Lay these visual design instructions out explicitly throughout the blueprint **

    ${PROMPT_UTILS.UI_NON_NEGOTIABLES_V3}

    ${PROMPT_UTILS.UI_GUIDELINES}

    ${PROMPT_UTILS.LIQUID_CODE_QUALITY_RULES}

    ## Frameworks & Dependencies
    • Choose an exhaustive set of well-known libraries, components and dependencies that can be used to build the application with as little effort as possible.
        - **Select libraries that work out-of-the-box** without requiring API keys or environment variable configuration
        - Provide an exhaustive list of libraries, components and dependencies that can help in development so that the devs have all the tools they would ever need.
        - Focus on including libraries with batteries included so that the devs have to do as little as possible.

    • **Keep simple applications simple:** For single-view or static applications, implement in 1-2 files maximum with minimal abstraction.
    • **SCOPE-FIRST APPROACH:** Only implement what the user specifically requested. A beautifully styled store with sample products is the default - additional features require explicit user requests.
    • **VISUAL EXCELLENCE:** The application should be visually polished and professional. Focus on clean, modern styling that makes the store look trustworthy and appealing.
    • **RESPONSIVE DESIGN:** The UI should be responsive across devices with functional layouts on mobile, tablet and desktop.
    • **PERFORMANCE:** The application should be fast with smooth interactions.
    • **ECOMMERCE STORE TEMPLATE USAGE:** Build upon the <STARTING TEMPLATE> (which is our base ecommerce store template from our custom store template repository):
        - Use the existing ecommerce patterns and components from the base template
        - Style the template to match the user's requested theme/niche
        - Add sample products relevant to the store type
        - Only add additional libraries if explicitly needed for requested features
        
    ## Important use case specific instructions:
    {{usecaseSpecificInstructions}}

    ## Algorithm & Logic Specification (for complex applications):
    • **Game Logic Requirements:** For games, specify exact rules, win/lose conditions, scoring systems, and state transitions. Detail how user inputs map to game actions.
    • **Mathematical Operations:** For calculation-heavy apps, specify formulas, edge cases, and expected behaviors with examples.
    • **Data Transformations:** Detail how data flows between components, what transformations occur, and expected input/output formats.
    • **Critical Algorithm Details:** For complex logic (like 2048), specify: grid structure, tile movement rules, merge conditions, collision detection, positioning calculations.
    • **Example-Based Logic Clarification:** For the most critical function (e.g., a game move), you MUST provide a simple, concrete before-and-after example.
        - **Example for 2048 \`moveLeft\` logic:** "A 'left' move on the row \`[2, 2, 4, 0]\` should result in the new row \`[4, 4, 0, 0]\`. Note that the two '2's merge into a '4', and the existing '4' slides next to it."
        - This provides a clear, verifiable test case for the core algorithm.
    • **Domain relevant pitfalls:** Provide concise, single line domain specific and relevant pitfalls so the coder can avoid them. Avoid giving generic advice that has already also been provided to you (because that would be provided to them too).
    
    **Visual Assets - Use These Approaches (MINIMALIST PREFERRED):**
    ✅ CSS visuals: Use Tailwind gradients (bg-gradient-to-r), solid colors, shadows, and borders
    ✅ Placeholder containers: Styled div elements with gradient or solid backgrounds
    ✅ Canvas drawings: \`<canvas>\` element for shapes, patterns, charts if needed
    ✅ Simple SVG inline: \`<svg><circle cx="50" cy="50" r="40" fill="blue" /></svg>\` for icons
    ✅ Icon libraries: lucide-react, heroicons (specify in frameworks)
    ❌ Never: External image URLs from Unsplash or other sources
    ❌ Never: .png, .jpg, .svg, .gif files in phase files list
</INSTRUCTIONS>

<KEY GUIDELINES>
    • **SCOPE DISCIPLINE IS PARAMOUNT:** Only plan for features the user explicitly requested. Do NOT add extra features, pages, or functionality.
    • **DEFAULT BEHAVIOR FOR SIMPLE REQUESTS:** If user just asks to "create a store" without specific features:
        1. Style the base template beautifully
        2. Add sample products relevant to the theme (if specified)
        3. Ensure basic ecommerce flow works (browse, cart, checkout)
        4. STOP THERE - no extra features
    • **Completeness is Crucial:** The AI coder relies *solely* on this blueprint. Leave no ambiguity for what IS requested.
    • **Precision in UI/Layout:** Define visual structure explicitly. Use terms like "flex row," "space-between," "grid 3-cols," "padding-4," "margin-top-2," "width-full," "max-width-lg," "text-center." Specify responsive behavior.
    • **Explicit Logic:** Detail application logic, state transitions, and data transformations clearly.
    • **ECOMMERCE STORE TEMPLATE FOUNDATION:** Build upon the \`<STARTING TEMPLATE>\` (our base ecommerce store template):
        - Use existing components and patterns from the template
        - Apply beautiful styling to match the store's theme
        - Only suggest additional libraries if needed for explicitly requested features
    • **SHADCN DESIGN SYSTEM:** Build with shadcn/ui components:
        - Clean color variants and visual treatments
        - Proper hover and interactive states
        - Consistent spacing and visual rhythm
    • **STYLING:** Use Tailwind CSS utilities for:
        - Clean, modern color schemes
        - Proper shadows, borders, and visual depth
        - Smooth transitions
        - Professional typography and spacing
    **AVAILABLE FRAMEWORKS (only add if needed for requested features):**
    - **Icons:** lucide-react (already in template)
    - **UI/Animation:** framer-motion (if animations explicitly requested)
    - **Charts/Data Viz:** recharts (if analytics/charts requested)
</KEY GUIDELINES>

${STRATEGIES.FRONTEND_FIRST_PLANNING}

**Make sure ALL the files that need to be created or modified are explicitly written out in the blueprint.**
<STARTING TEMPLATE>
{{template}}

<TEMPLATE_CORE_FILES>
**SHADCN COMPONENTS, Error boundary components and use-toast hook ARE PRESENT AND INSTALLED BUT EXCLUDED FROM THESE FILES DUE TO CONTEXT SPAM**
{{filesText}}
</TEMPLATE_CORE_FILES>

<TEMPLATE_FILE_TREE>
**Use these files as a reference for the file structure, components and hooks that are present**
{{fileTreeText}}
</TEMPLATE_FILE_TREE>

Preinstalled dependencies:
{{dependencies}}
</STARTING TEMPLATE>`;

export interface BlueprintGenerationArgs {
    env: Env;
    inferenceContext: InferenceContext;
    query: string;
    language: string;
    frameworks: string[];
    // Add optional template info
    templateDetails: TemplateDetails;
    templateMetaInfo: TemplateSelection;
    images?: ProcessedImageAttachment[];
    stream?: {
        chunk_size: number;
        onChunk: (chunk: string) => void;
    };
}

/**
 * Generate a blueprint for the application based on user prompt
 */
// Update function signature and system prompt
export async function generateBlueprint({ env, inferenceContext, query, language, frameworks, templateDetails, templateMetaInfo, images, stream }: BlueprintGenerationArgs): Promise<Blueprint> {
    try {
        logger.info("Generating application blueprint", { query, queryLength: query.length, imagesCount: images?.length || 0 });
        logger.info(templateDetails ? `Using template: ${templateDetails.name}` : "Not using a template.");

        // ---------------------------------------------------------------------------
        // Build the SYSTEM prompt for blueprint generation
        // ---------------------------------------------------------------------------

        const filesText = TemplateRegistry.markdown.serialize(
            { files: getTemplateImportantFiles(templateDetails).filter(f => !f.filePath.includes('package.json')) },
            z.object({ files: z.array(TemplateFileSchema) })
        );

        const fileTreeText = PROMPT_UTILS.serializeTreeNodes(templateDetails.fileTree);
        const systemPrompt = SYSTEM_PROMPT.replace('{{filesText}}', filesText).replace('{{fileTreeText}}', fileTreeText);
        const systemPromptMessage = createSystemMessage(generalSystemPromptBuilder(systemPrompt, {
            query,
            templateDetails,
            frameworks,
            templateMetaInfo,
            blueprint: undefined,
            language,
            dependencies: templateDetails.deps,
        }));

        const userMessage = images && images.length > 0
            ? createMultiModalUserMessage(
                `CLIENT REQUEST: "${query}"`,
                await imagesToBase64(env, images),
                'high'
            )
            : createUserMessage(`CLIENT REQUEST: "${query}"`);

        const messages = [
            systemPromptMessage,
            userMessage
        ];

        // Log messages to console for debugging
        // logger.info('Blueprint messages:', JSON.stringify(messages, null, 2));

        // let reasoningEffort: "high" | "medium" | "low" | undefined = "medium" as const;
        // if (templateMetaInfo?.complexity === 'simple' || templateMetaInfo?.complexity === 'moderate') {
        //     console.log(`Using medium reasoning for simple/moderate queries`);
        //     modelName = AIModels.OPENAI_O4_MINI;
        //     reasoningEffort = undefined;
        // }

        const { object: results } = await executeInference({
            env,
            messages,
            agentActionName: "blueprint",
            schema: BlueprintSchema,
            context: inferenceContext,
            stream: stream,
        });

        if (results) {
            // Filter and remove any pdf files
            results.initialPhase.files = results.initialPhase.files.filter(f => !f.path.endsWith('.pdf'));
        }

        // // A hack
        // if (results?.initialPhase) {
        //     results.initialPhase.lastPhase = false;
        // }
        return results as Blueprint;
    } catch (error) {
        logger.error("Error generating blueprint:", error);
        throw error;
    }
}
