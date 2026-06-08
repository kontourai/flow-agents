---
name: "frontend-design"
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics."
---

# Frontend Design

Delegate frontend implementation to `tool-worker` with the design guidelines below included in the prompt. The orchestrator's job is to understand the user's requirements, choose an aesthetic direction, and hand off to tool-worker with clear instructions plus the full aesthetics guidelines.

## Trigger Patterns

This skill activates when the user:

- Asks to build a UI, page, component, or web application
- Wants a landing page, dashboard, form, or interactive interface
- Mentions design quality, aesthetics, or visual polish
- Asks for something "that looks good" or "production-grade"

## Workflow

### Step 1: UNDERSTAND REQUIREMENTS
Gather from the user:
- What to build (component, page, app)
- Purpose and audience
- Technical constraints (framework, existing codebase)
- Any aesthetic preferences or references

### Step 2: DELEGATE TO tool-worker
Spawn `tool-worker` with a prompt that includes:
- Delegate to the exact `tool-worker` role; do not spawn an unnamed/default implementation agent.
1. The specific implementation task (what to build, where files go, framework)
2. The **full Design Guidelines section below** — copy it into the delegation prompt so tool-worker has it in context

### Step 3: VERIFY VISUALLY (mandatory)
After tool-worker completes, you MUST delegate to tool-playwright to screenshot the result and confirm it renders correctly. Do NOT skip this step. Do NOT treat implementation as the final step. Visual verification is required before relaying results to the user.

## Design Guidelines

Include everything below this line in the tool-worker delegation prompt.

---

### Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:

- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

### Frontend Aesthetics

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt for distinctive choices that elevate the aesthetic. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, and grain overlays.

### Anti-Patterns (NEVER use)

- Generic font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and cookie-cutter component patterns
- Converging on the same "safe" choices across generations (e.g., Space Grotesk every time)

Vary between light and dark themes, different fonts, different aesthetics. Every design should feel unique to its context.

### Calibration

Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details.
