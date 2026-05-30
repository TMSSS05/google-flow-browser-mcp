# Google Flow Browser MCP

MCP server for OpenCode to control [Google Flow](https://labs.google/fx/tools/flow) via browser automation (Playwright + CDP) using the user's own Google account.

## Architecture

```
google-flow-browser-mcp/
├── config/
│   ├── flow.config.example.json     # Config template (copy to flow.config.json)
│   └── selectors.map.json           # UI selectors (auto-populated by discover_ui)
├── scripts/
│   ├── start-browser.sh             # Launch Chrome with configured profile + CDP
│   ├── start-mcp.sh                 # Start the MCP server
│   ├── test-flow-image.sh           # Quick connectivity test
│   └── register-opencode.sh         # Register MCP in OpenCode config
├── src/
│   ├── index.js                     # MCP server entry point (tool router)
│   ├── browser/
│   │   ├── connect.js               # CDP connection management
│   │   ├── launch-profile.js        # Chrome profile launcher
│   │   ├── account-check.js         # Verify the Google account
│   │   ├── safe-actions.js          # Safe click, fill, UI detection
│   ├── tools/
│   │   ├── flow-open.js             # Open/navigate Flow
│   │   ├── flow-status.js           # Connection status check
│   │   ├── generate-image.js        # Image generation (Nano Banana, Imagen)
│   │   ├── generate-video.js        # Video generation (paid - setup only)
│   │   ├── download-latest.js       # Download generated files
│   │   ├── create-character.js      # Create character in Flow
│   │   ├── import-character.js      # Import character JSON
│   │   ├── open-characters.js       # List characters
│   │   ├── create-scene.js          # Create scene in Flow
│   │   ├── open-tools-gallery.js    # Open tools gallery
│   │   ├── grid-architect.js        # Grid Architect (batch shots)
│   │   ├── discover-ui.js           # UI discovery & selector mapping
│   │   └── use-flow-tool.js         # Generic tool opener
│   ├── queue/
│   │   └── job-queue.js             # Single-job queue
│   └── utils/
│       ├── config.js                # Config loader
│       ├── logger.js                # Structured logging
│       ├── errors.js                # Error codes/types
│       ├── file-manager.js          # File download/save
│       └── screenshots.js           # Screenshot capture
└── output/                          # Generated files land here
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `flow_connect` | Launch Chrome, connect CDP, navigate to Google Flow |
| `flow_disconnect` | Close browser and clean up |
| `flow_status` | Check connection status, Flow loaded, account, queue state |
| `flow_account_check` | Verify logged-in account matches expected email |
| `flow_discover_ui` | Navigate to a Flow page and discover buttons/inputs/links |
| `flow_generate_image` | Generate an image with Nano Banana or Imagen models |
| `flow_generate_video` | Set up video generation — stops before final click (paid) |
| `flow_download_latest` | Download most recent generated file |
| `flow_create_character` | Create a new character in Flow Characters |
| `flow_import_character` | Import character from JSON file |
| `flow_open_characters` | Open characters page and list existing characters |
| `flow_create_scene` | Create a scene with characters and prompt |
| `flow_open_tools_gallery` | Open tools gallery and list available tools |
| `flow_use_grid_architect` | Open Grid Architect and configure batch shot generation |
| `flow_use_tool` | Open any tool by name in Google Flow |
| `flow_screenshot` | Take a screenshot of current Flow page |
| `flow_queue_status` | Check job queue state |

## Setup

```bash
# 1. Install dependencies
cd /path/to/google-flow-browser-mcp
npm install

# 2. Configure your profile
cp config/flow.config.example.json config/flow.config.json
# Edit flow.config.json with your Chrome profile path and account

# 3. Start Chrome with CDP
chmod +x scripts/*.sh
./scripts/start-browser.sh

# 4. Start MCP server (in another terminal)
./scripts/start-mcp.sh

# 5. Register in OpenCode
./scripts/register-opencode.sh
```

## Safety Rules

- Uses your own Google account (configured in flow.config.json)
- Never asks for Google password
- Never steals/exports cookies
- Never bypasses captcha or anti-bot
- Stops cleanly on verification/captcha, requests manual intervention
- Single-job queue — no parallel generation
- Video generation: stops at "ready to generate" — no credit consumption
- Backups OpenCode config before any modification

## Configuration

Edit `config/flow.config.json` (see `config/flow.config.example.json` for all options):

| Key | Description |
|-----|-------------|
| `expectedAccount` | Your Google account email |
| `chromeProfile` | Chrome profile directory name (e.g., "Profile 3") |
| `chromeUserDataDir` | Path to Chrome user data directory |
| `cdpPort` | Chrome DevTools Protocol port (default: 9222) |
| `browserMode` | "direct-cdp" (recommended) or "playwright" |
| `flowUrl` | Google Flow URL |
| `locale` | UI locale (e.g., "fr", "en") |
