import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';

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
  const chromePath = options.chromePath || '/opt/google/chrome/chrome';
  const profileDir = options.profileDir || path.resolve(import.meta.dirname, '../../chrome-profile-kiara');

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
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
  const chromePath = options.chromePath || '/opt/google/chrome/chrome';
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);
  const profileSource = options.profileSource || path.resolve(process.env.HOME, '.config/google-chrome/Profile 3');

  if (isConnected && page) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  const tempDir = `/tmp/chrome-kiara-cdp-${Date.now()}`;
  fs.mkdirSync(tempDir, { recursive: true });

  const localStateSrc = path.resolve(path.dirname(profileSource), '../Local State');
  if (fs.existsSync(profileSource)) {
    fs.cpSync(profileSource, path.join(tempDir, 'Profile 3'), { recursive: true });
  }
  if (fs.existsSync(localStateSrc)) {
    fs.cpSync(localStateSrc, path.join(tempDir, 'Local State'));
  } else {
    fs.writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));
  }

  logger.info('Temp profile created with cookies', { tempDir });

  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
    await new Promise(r => setTimeout(r, 1000));
  } catch { }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempDir}`,
    '--profile-directory=Profile 3',
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];
  if (headless) args.push('--headless=new');

  logger.info('Launching Chrome directly', { chromePath, cdpPort, headless });

  const chromeProcess = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, 'Chrome CDP failed to start in time');
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  context = browser.contexts()[0];
  page = context.pages()[0] || await context.newPage();
  isConnected = true;
  global.__chromeTempDir = tempDir;

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

export function isBrowserConnected() {
  return isConnected;
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
