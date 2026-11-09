import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getProfileSourceDir, getAutomationUserDataDir } from './chrome-paths.js';

// Candidate browser executables per platform, in order of preference.
// Any Chromium-based browser with CDP support works (Chrome, Edge).
const BROWSER_CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${(process.env.LOCALAPPDATA || '').replace(/\\/g, '/')}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
    '/opt/microsoft/msedge/msedge',
  ],
};

/**
 * Resolve the browser executable: config `browserPath` wins, otherwise the
 * first installed candidate for this platform.
 */
export function resolveBrowserPath() {
  const configured = get('browserPath') || get('chromePath');
  if (configured) return configured;
  const candidates = BROWSER_CANDIDATES[process.platform] || BROWSER_CANDIDATES.linux;
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

// Cache folders skipped when cloning a profile (large, often locked, not needed for auth)
const PROFILE_COPY_SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'Service Worker', 'blob_storage',
  'optimization_guide_model_store', 'LOCK', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
]);

/** Copy a profile folder, skipping caches and files locked by a running browser. Returns #skipped. */
function copyProfileBestEffort(src, dest) {
  let skipped = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (PROFILE_COPY_SKIP.has(entry.name)) continue;
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      try {
        if (entry.isDirectory()) walk(a, b);
        else if (entry.isFile()) fs.copyFileSync(a, b);
      } catch { skipped++; }
    }
  };
  walk(src, dest);
  return skipped;
}

let browser = null;
let context = null;
let page = null;
let isConnected = false;

export async function connectToBrowser(options = {}) {
  if (isConnected && page) {
    logger.info('Already connected to browser');
    return { browser, context, page };
  }

  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  try {
    // Try connecting to existing Chrome instance via CDP
    logger.info('Attempting CDP connection', { url: cdpUrl });
    browser = await chromium.connectOverCDP(cdpUrl);
    logger.info('Connected via CDP');

    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
    } else {
      context = await browser.newContext();
    }

    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
    isConnected = true;
    logger.info('Browser connected successfully');
    return { browser, context, page };
  } catch (err) {
    logger.warn('CDP connection failed, will launch new browser', { error: err.message });
    return await launchNewBrowser(cdpPort, options);
  }
}

async function launchNewBrowser(cdpPort, options = {}) {
  const chromePath = options.chromePath || resolveBrowserPath();
  const profileDir = options.profileDir || path.resolve(import.meta.dirname, '../../chrome-profile-kiara');

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Browser not found at ${chromePath}. Set "browserPath" in config/flow.config.json.`);
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--window-size=1920,1080`,
  ];

  if (get('headless', false)) {
    args.push('--headless=new');
  }

  // Kill any existing Chrome on this debugging port
  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
  } catch (e) {
    // No existing instance, that's fine
  }

  logger.info('Launching Chrome with Kiara profile', {
    chromePath,
    profileDir,
    cdpPort,
  });

  browser = await chromium.launch({
    executablePath: chromePath,
    args,
    headless: false,
  });

  context = browser.contexts()[0] || await browser.newContext();
  page = context.pages()[0] || await context.newPage();
  isConnected = true;

  logger.info('New browser launched successfully');
  return { browser, context, page };
}

/**
 * Launch Chrome DIRECTLY (not via Playwright) to avoid automation detection
 * (navigator.webdriver=false). Creates temp user-data-dir with Profile 3 cookies,
 * launches Chrome via shell, then connects Playwright via CDP.
 */
export async function launchChromeDirect(options = {}) {
  const chromePath = options.chromePath || resolveBrowserPath();
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);
  const profileSource = options.profileSource || getProfileSourceDir();
  const profileName = path.basename(profileSource);

  if (isConnected && page) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Browser not found at ${chromePath}. Set "browserPath" in config/flow.config.json.`);
  }

  // One persistent browser profile for the tool, seeded from the user's profile the first
  // time only. A fresh temp copy per launch lost the Google sign-in every time.
  const dataDir = get('browserDataDir') || getAutomationUserDataDir();
  if (!fs.existsSync(path.join(dataDir, profileName))) {
    fs.mkdirSync(dataDir, { recursive: true });
    // "Local State" sits next to the profile folder and holds the cookie encryption key
    const localStateSrc = path.join(path.dirname(profileSource), 'Local State');
    if (fs.existsSync(profileSource)) {
      const skipped = copyProfileBestEffort(profileSource, path.join(dataDir, profileName));
      if (skipped) logger.warn('Some profile files were locked and skipped (close Chrome to copy them)', { skipped });
    }
    if (fs.existsSync(localStateSrc)) {
      try { fs.copyFileSync(localStateSrc, path.join(dataDir, 'Local State')); }
      catch { fs.writeFileSync(path.join(dataDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } })); }
    } else {
      fs.writeFileSync(path.join(dataDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));
    }
    logger.info('Persistent browser profile created (sign in once here)', { dataDir });
  } else {
    logger.info('Reusing persistent browser profile', { dataDir });
  }

  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
    await new Promise(r => setTimeout(r, 1000));
  } catch { }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${dataDir}`,
    `--profile-directory=${profileName}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];
  if (headless) args.push('--headless=new');

  logger.info('Launching browser directly', { chromePath, profileName, cdpPort, headless });

  // Detached: the browser (and its sign-in) survives restarts of the MCP / GUI server
  const chromeProcess = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  chromeProcess.unref();

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  let attempts = 0;
  while (attempts < 20) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      if (resp.ok) break;
    } catch { }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }
  if (attempts >= 20) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Browser CDP failed to start in time (${chromePath}). Close all running instances of this browser and retry.`);
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  context = browser.contexts()[0];
  page = context.pages()[0] || await context.newPage();
  isConnected = true;

  logger.info('Chrome direct + CDP connected', { webdriver: await page.evaluate(() => navigator.webdriver) });
  return { browser, context, page };
}

export async function closeBrowser() {
  if (global.__chromeTempDir) {
    try { fs.rmSync(global.__chromeTempDir, { recursive: true, force: true }); }
    catch (e) { logger.warn('Temp cleanup failed', { error: e.message }); }
    global.__chromeTempDir = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      logger.warn('Error closing browser', { error: err.message });
    }
  }
  browser = null;
  context = null;
  page = null;
  isConnected = false;
  logger.info('Browser disconnected');
}

export function getPage() {
  if (!page) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'Browser not connected. Call connectToBrowser() first.');
  }
  return page;
}

export function getContext() {
  return context;
}

/**
 * True when we hold a usable page. Self-heals stale state: if the user closed our tab
 * but the browser is still open, switch to another open tab (preferring Flow); if the
 * browser itself is gone, drop the connection so the next call reconnects.
 */
export function isBrowserConnected() {
  if (!isConnected) return false;

  if (browser && !browser.isConnected()) {
    logger.warn('Browser connection lost — will reconnect on next use');
    browser = null;
    context = null;
    page = null;
    isConnected = false;
    return false;
  }

  if (page?.isClosed()) {
    const open = (context?.pages() || []).filter(p => !p.isClosed());
    const next = open.find(p => p.url().includes('flow.google.com/project/'))
      || open.find(p => p.url().includes('flow.google.com'))
      || open[0];
    if (!next) {
      logger.warn('All tabs closed — will reconnect on next use');
      page = null;
      isConnected = false;
      return false;
    }
    logger.info('Active tab was closed — switched to another open tab', { url: next.url().substring(0, 80) });
    page = next;
  }
  return true;
}

export function setPage(newPage) {
  page = newPage;
}

export function getBrowser() {
  return browser;
}

export function setBrowser(b) {
  browser = b;
}

export function setConnected(connected) {
  isConnected = connected;
}

export function setContext(ctx) {
  context = ctx;
}
