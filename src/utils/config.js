import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FLOW_HOME = path.resolve(__dirname, '..', '..');

const configPath = path.join(FLOW_HOME, 'config', 'flow.config.json');
let config;

try {
  const raw = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(raw);
} catch (err) {
  console.error(`[CONFIG] Failed to load config from ${configPath}: ${err.message}`);
  config = {};
}

// ── Environment overrides ───────────────────────────────────────────
// Load ./.env (if present) without overriding variables already set by the
// shell or the MCP client, then let FLOW_* env vars override flow.config.json.
const envPath = path.join(FLOW_HOME, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath); // Node >= 20.12; never overrides existing vars
  } catch (err) {
    console.error(`[CONFIG] Failed to load ${envPath}: ${err.message}`);
  }
}

const ENV_MAP = {
  FLOW_URL: ['flowUrl', 'string'],
  FLOW_EXPECTED_ACCOUNT: ['expectedAccount', 'string'],
  FLOW_CHROME_PATH: ['chromePath', 'string'],
  FLOW_CHROME_USER_DATA_DIR: ['chromeUserDataDir', 'string'],
  FLOW_CHROME_PROFILE: ['chromeProfile', 'string'],
  FLOW_AUTOMATION_USER_DATA_DIR: ['automationUserDataDir', 'string'],
  FLOW_REFRESH_PROFILE_COPY: ['refreshProfileCopy', 'boolean'],
  FLOW_BROWSER_PATH: ['browserPath', 'string'],
  FLOW_BROWSER_DATA_DIR: ['browserDataDir', 'string'],
  FLOW_CDP_PORT: ['cdpPort', 'number'],
  FLOW_HEADLESS: ['headless', 'boolean'],
  FLOW_LOCALE: ['locale', 'string'],
};

for (const [envName, [key, type]] of Object.entries(ENV_MAP)) {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') continue;
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isNaN(n)) config[key] = n;
  } else if (type === 'boolean') {
    config[key] = /^(1|true|yes|on)$/i.test(raw.trim());
  } else {
    config[key] = raw;
  }
}

export default config;

export function get(key, fallback = undefined) {
  return config[key] !== undefined ? config[key] : fallback;
}

export function getFlowHome() {
  return config.flowHome || FLOW_HOME;
}
