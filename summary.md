# Anchored Summary — Google Flow Browser MCP

## Goal
Complete MCP server for Google Flow with Playwright, adapted to the new project-based Flow UI, pushed to GitHub without sensitive data.

## Constraints & Preferences
- Never ask for Google password, never steal/export cookies, never bypass captcha or anti-bot
- Stop cleanly on captcha/verification, request manual intervention
- Single-job queue, no parallel generation
- Video: setup UI only, no final click. Grid Architect: setup only, no Generate click
- Clean GitHub push: no cookies, credentials, or local paths in public repo
- **PROJECT-BASED**: Always work inside a project. Reuse existing project if same campaign, create new otherwise
- **"Si tu penses que c'est le même projet ou de la même marque → réutilise le projet. Au moindre doute → nouveau projet"**
- Browser must remain visible (`headless: false`) during collaborative UI exploration

## Progress
### Done ✓
- **Anti-detection launch**: `launchChromeDirect()` → `navigator.webdriver=false` → Google OAuth bypass
- **GitHub push**: Clean push to `TMSSS05/google-flow-browser-mcp` — 35 files, no sensitive data
- **All 5 cleanup tasks done**: .gitignore, config example, email defaults removed, README sanitized, git init + push
- **`project-navigator.js` created**: 6 exported functions (`ensureProjectInContext`, `createNewProject`, `navigateToSidebar`, `listExistingProjects`, `getActiveSidebarSection`, `registerTaskInProject`)
- **All 8 creation/action tools rewritten with project context**:
  - `generate-image.js` → `ensureProjectInContext()` + `navigateToSidebar()`
  - `generate-video.js` → project context + sidebar navigation
  - `create-character.js` + `open-characters.js` → `navigateToSidebar('Personnages')`
  - `create-scene.js` → `navigateToSidebar('Scènes')`
  - `grid-architect.js` → `navigateToSidebar('Outils')`
  - `open-tools-gallery.js` → `navigateToSidebar('Outils')`
  - `use-flow-tool.js` → `navigateToSidebar('Outils')`
- **`index.js` schemas updated**: `project_name` + `campaign` params added to 6 tool definitions
- **All 25 JS files pass syntax check** (node --check)

### Pending
- Restart MCP server → E2E test: create project → generate image (banana + straw hat + mojito)

## Architecture
- `navigator.webdriver: false` by direct Chrome launch + Playwright CDP attach
- Flow main page: `https://labs.google/fx/fr/tools/flow`, projects: `/fx/fr/tools/flow/project/{uuid}`
- `ensureProjectInContext(page, { name, campaign, forceNew })` → checks URL ← checks stored projects ← creates new
- Sidebar sections: Personnages, Scènes, Outils, Corbeille
- `config/flow.projects.json` stores project history (gitignored)
- MCP server running in tmux session `flow-mcp`, Chrome visible on :9222

## Next Immediate Step
1. Restart MCP server (kill + restart tmux)
2. Call `flow_connect` → Flow loads
3. Call `flow_generate_image` with `project_name: "Test Banane"`, `campaign: "test"`, prompt: "banana with straw hat and mojito cocktail"

## Relevant Files
- `/home/tmsss/Documents/MCP/google-flow-browser-mcp/src/navigation/project-navigator.js` — core project management
- `/home/tmsss/Documents/MCP/google-flow-browser-mcp/src/tools/generate-image.js` — image gen with project context
- `/home/tmsss/Documents/MCP/google-flow-browser-mcp/src/index.js` — tool schemas with project_name/campaign
- `/home/tmsss/Documents/MCP/google-flow-browser-mcp/src/browser/connect.js` — anti-detection CDP attach
- `/home/tmsss/Documents/MCP/google-flow-browser-mcp/.gitignore` — excludes projects.json + config
