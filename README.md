
<div align="center">

# 🧠 Google Flow Browser MCP

**Control [Google Flow](https://labs.google/fx/tools/flow) — image & video generation — directly from your AI agent via MCP.**

<p>
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Version 1.0.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node >= 18">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License MIT">
  <img src="https://img.shields.io/badge/MCP-server-8A2BE2?style=flat-square" alt="MCP Server">
  <img src="https://img.shields.io/badge/OpenCode-ready-4CAF50?style=flat-square" alt="OpenCode Ready">
</p>

<br>

[✨ Features](#-features) •
[🚀 Quick Start](#-quick-start) •
[🔧 Tools](#-tools) •
[⚙️ Configuration](#️-configuration) •
[🛡️ Safety](#️-safety--ethics)

<br>

</div>

---

> **🇫🇷 Ce serveur MCP permet à votre agent AI (OpenCode) d'utiliser Google Flow pour générer des images et des vidéos, via votre propre compte Google et sans partager vos identifiants.**

---

## 📸 What It Does

This MCP server connects your AI agent to **[Google Flow](https://labs.google/fx/tools/flow)** — Google's creative suite for image and video generation. Your agent can:

- 🎨 **Generate images** with Nano Banana Pro, Nano Banana 2, or Imagen 4
- 🎬 **Create videos** and scenes with characters
- 🧑 **Manage characters** and scenes in your Flow workspace
- 🖼️ **Use Grid Architect** for batch shot generation
- 🔍 **Discover and control** any Flow tool programmatically

All through your **own Google account** — no API keys, no third-party tokens.

---

## ✨ Features

<table>
<tr>
  <td width="50%">

### 🎯 For AI Agents
  </td>
  <td width="50%">

### 🔒 For Humans
  </td>
</tr>
<tr>
  <td>

- **15+ MCP tools** ready to use
- **Smart job queue** — no parallel conflicts
- **Auto-discover UI** — adapts to Flow changes
- **Structured logging** for debugging
- **Safe actions** — resilient click/fill logic
  </td>
  <td>

- **Your account, your data** — no token sharing
- **No password asked** — ever
- **Clean safety rules** — stops on captcha/verification
- **Config backup** before any modification
- **Single-job queue** — no runaway generation
  </td>
</tr>
</table>

---

## 🚀 Quick Start

### Prerequisites

| What | Why |
|------|-----|
| **Node.js ≥ 18** | Runtime for the MCP server |
| **Google Chrome** | Required for browser automation |
| **OpenCode** | AI agent that connects to MCP servers |
| **A Google account** | To use Google Flow (yours, not shared) |

### 1️⃣ Install

```bash
git clone https://github.com/TMSSS05/google-flow-browser-mcp.git
cd google-flow-browser-mcp
npm install
```

### 2️⃣ Configure your Google profile

```bash
cp config/flow.config.example.json config/flow.config.json
```

Edit `config/flow.config.json`:

```json
{
  "expectedAccount": "your.email@gmail.com",
  "chromeProfile": "Profile 3",
  "chromeUserDataDir": "/home/you/.config/google-chrome"
}
```

> 💡 **Finding your Chrome profile:**  
> Open Chrome and go to `chrome://version/`. Look for **"Profile Path"** — the last folder name is your profile (e.g., `Profile 3`), and the path before it is your `chromeUserDataDir`.

### 3️⃣ Make scripts executable

```bash
chmod +x scripts/*.sh
```

### 4️⃣ Start Chrome with CDP

```bash
./scripts/start-browser.sh
```

> This launches Chrome with remote debugging enabled on port 9222 using your configured profile.

### 5️⃣ Start the MCP server

```bash
# In a separate terminal:
./scripts/start-mcp.sh
```

### 6️⃣ Register with OpenCode

```bash
./scripts/register-opencode.sh
```

> 🔄 **Restart OpenCode** after registration for the changes to take effect.

### ✅ Verify it works

```bash
./scripts/test-flow-image.sh
```

---

## 🏗️ Architecture

```
google-flow-browser-mcp/
│
├── 📂 config/
│   ├── flow.config.example.json    # Configuration template
│   └── selectors.map.json          # UI selectors (auto-populated)
│
├── 📂 scripts/
│   ├── start-browser.sh            # Launch Chrome + CDP
│   ├── start-mcp.sh                # Start the MCP server
│   ├── test-flow-image.sh          # Quick integration test
│   └── register-opencode.sh        # Register in OpenCode config
│
├── 📂 src/
│   ├── index.js                    # MCP server entry point
│   │
│   ├── 📁 browser/                 # Chrome & CDP management
│   │   ├── connect.js              # CDP connection manager
│   │   ├── launch-profile.js       # Chrome profile launcher
│   │   ├── account-check.js        # Verify Google account
│   │   └── safe-actions.js         # Safe click, fill, detection
│   │
│   ├── 📁 tools/                   # All MCP tool implementations
│   │   ├── flow-open.js            # Navigate to Flow
│   │   ├── flow-status.js          # Connection status
│   │   ├── generate-image.js       # Image generation
│   │   ├── generate-video.js       # Video generation (setup only)
│   │   ├── download-latest.js      # Download generated files
│   │   ├── create-character.js     # Create a character
│   │   ├── import-character.js     # Import character JSON
│   │   ├── open-characters.js      # List characters
│   │   ├── create-scene.js         # Create a scene
│   │   ├── open-tools-gallery.js   # Open tools gallery
│   │   ├── grid-architect.js       # Batch shot generation
│   │   ├── discover-ui.js          # UI discovery & mapping
│   │   └── use-flow-tool.js        # Generic tool opener
│   │
│   ├── 📁 queue/                   # Job management
│   │   └── job-queue.js            # Single-job queue
│   │
│   └── 📁 utils/                   # Helpers
│       ├── config.js               # Config loader
│       ├── logger.js               # Structured logging
│       ├── errors.js               # Error codes & types
│       ├── file-manager.js         # File download/save
│       └── screenshots.js          # Screenshot capture
│
└── 📂 output/                      # Generated files land here
```

---

## 🔧 Tools

All tools are organized by function for easy discovery.

### 🌐 Connection & Status

| Tool | Description |
|------|-------------|
| `flow_connect` | Launch Chrome, connect CDP, navigate to Google Flow |
| `flow_disconnect` | Close browser and clean up all connections |
| `flow_status` | Full status: connection, Flow loaded, account, queue state |
| `flow_account_check` | Verify logged-in account matches configured email |
| `flow_screenshot` | Capture a screenshot of the current Flow page |

### 🎨 Image Generation

| Tool | Description |
|------|-------------|
| `flow_generate_image` | Generate image with **Nano Banana Pro**, **Nano Banana 2**, or **Imagen 4**. Supports aspect ratios, reference images, and brand-based model selection. |
| `flow_download_latest` | Download the most recently generated file |

### 🎬 Video Generation

| Tool | Description |
|------|-------------|
| `flow_generate_video` | Set up video generation (Omni Flash, Veo models, custom duration/ratio). ⚠️ **Stops at "ready to generate" — no credit consumed.** |
| `flow_create_scene` | Create a video scene with characters and a text prompt |

### 👤 Characters

| Tool | Description |
|------|-------------|
| `flow_create_character` | Create a new character with name, description, and optional reference images |
| `flow_import_character` | Import a character from a saved JSON file |
| `flow_open_characters` | Open the characters page and list all existing characters |

### 🛠️ Tools & Discovery

| Tool | Description |
|------|-------------|
| `flow_open_tools_gallery` | Open the tools gallery and browse available tools |
| `flow_use_tool` | Open any Flow tool by name with optional parameters |
| `flow_use_grid_architect` | Configure Grid Architect for batch shot generation with theme prompts, visual logic, and reference images |
| `flow_discover_ui` | Discover and map all interactive elements (buttons, inputs, headings) on any Flow page |

### 📊 Queue & Monitoring

| Tool | Description |
|------|-------------|
| `flow_queue_status` | Check job queue: active job, pending queue, completed and failed history |

---

## ⚙️ Configuration

Edit `config/flow.config.json` (copy from `config/flow.config.example.json`):

### 🔑 Essential

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `expectedAccount` | `string` | — | Your Google account email ✅ **REQUIRED** |
| `chromeProfile` | `string` | `"Profile 3"` | Chrome profile directory name |
| `chromeUserDataDir` | `string` | — | Full path to Chrome user data directory ✅ **REQUIRED** |
| `flowUrl` | `string` | *Flow labs URL* | Google Flow URL (supports `fr`, `en` locales) |

### 🔧 Advanced

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cdpPort` | `number` | `9222` | Chrome DevTools Protocol port |
| `browserMode` | `string` | `"direct-cdp"` | `"direct-cdp"` (recommended) or `"playwright"` |
| `headless` | `boolean` | `true` | Run Chrome in headless mode |
| `locale` | `string` | `"fr"` | UI locale (`"fr"`, `"en"`, etc.) |

### ⏱️ Timing

| Key | Default | Description |
|-----|---------|-------------|
| `jobTimeoutMs` | `300000` (5 min) | Max job execution time |
| `actionDelayMs` | `800` | Delay between UI actions (anti-detection) |
| `generationPollIntervalMs` | `5000` (5s) | How often to poll for generation completion |
| `maxPollAttempts` | `120` | Max polling attempts before timeout |
| `downloadWaitMs` | `30000` (30s) | Wait time for file download |

### 🎨 Models & Ratios

| Key | Description |
|-----|-------------|
| `imageModels` | Available models: `Nano Banana Pro`, `Nano Banana 2`, `Imagen 4` |
| `videoModels` | Available models: `Omni Flash`, `Veo 3.1 - Lite/Fast/Quality` |
| `ratios` | Supported aspect ratios: `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |

---

## 🛡️ Safety & Ethics

This project is built with **safety-first design**:

| ✅ Principle | How it's enforced |
|-------------|-------------------|
| **Your account only** | Uses your own Google profile — never asks for or stores passwords |
| **No credential theft** | Never exports cookies, tokens, or session data |
| **No bypass** | Stops cleanly on captcha, login walls, or verification challenges |
| **No parallel abuse** | Single-job queue prevents concurrent generation |
| **Credit-safe video** | Video generation sets up parameters but stops before the final "Generate" click (no credit consumed) |
| **Config backup** | Backs up OpenCode config before any modification |

> ⚠️ **This is a browser automation tool.** Use it responsibly and in accordance with Google's Terms of Service.

---

## ❓ FAQ

### Getting Started

<details>
<summary><strong>Which Chrome profile should I use?</strong></summary>

Open Chrome and go to `chrome://version/`. The **Profile Path** shows both your user data directory and profile name. For example:
- `/home/you/.config/google-chrome/Profile 3` → `chromeUserDataDir: "/home/you/.config/google-chrome"`, `chromeProfile: "Profile 3"`

You need a profile where you're already logged into your Google account.
</details>

<details>
<summary><strong>Can I use this without OpenCode?</strong></summary>

Yes! Any MCP-compatible client (Claude Desktop, Continue.dev, etc.) can connect to this server. Just point your MCP config to `node /path/to/src/index.js`.
</details>

### Troubleshooting

<details>
<summary><strong>Chrome doesn't start</strong></summary>

Make sure Chrome is installed at the expected path. On Linux, the default is `/opt/google/chrome/chrome`. Edit `scripts/start-browser.sh` to set the correct `CHROME` path for your system.
</details>

<details>
<summary><strong>CDP port already in use</strong></summary>

The script checks for existing Chrome instances on port 9222. If something else is using that port, you can change `cdpPort` in `config/flow.config.json` (and update the script's `CDP_PORT` variable).
</details>

<details>
<summary><strong>"Expected account mismatch"</strong></summary>

Verify that `expectedAccount` in `config/flow.config.json` matches the email logged into your Chrome profile. Use `flow_account_check` to verify.
</details>

<details>
<summary><strong>Flow UI changed and tools don't work</strong></summary>

Run `flow_discover_ui` to re-map selectors. The `selectors.map.json` will auto-update with new UI element positions.
</details>

### Usage

<details>
<summary><strong>How do I generate images?</strong></summary>

Your AI agent calls `flow_generate_image` with a text prompt. Optionally specify model (`Nano Banana 2` is default), aspect ratio, and reference images. The server waits for completion and makes the file available for download.
</details>

<details>
<summary><strong>Can I generate videos for free?</strong></summary>

`flow_generate_video` sets up the video parameters (model, ratio, duration) but **stops before clicking Generate**. This lets you review the setup before consuming credits. The actual generation requires a paid Google Flow subscription.
</details>

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 📄 License

[MIT](./LICENSE) © TMSSS05

---

<div align="center">
  <sub>Built with ❤️ for the OpenCode ecosystem</sub>
  <br>
  <sub>
    <a href="https://github.com/TMSSS05/google-flow-browser-mcp/issues">Report Issue</a> ·
    <a href="https://github.com/TMSSS05/google-flow-browser-mcp/discussions">Discussion</a>
  </sub>
</div>
