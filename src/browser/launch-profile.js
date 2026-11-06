import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchChromeDirect, resolveBrowserPath, setPage, setContext, setConnected, setBrowser, isBrowserConnected } from './connect.js';

const CDP_PORT = get('cdpPort', 9222);
const FLOW_APP_URL = 'https://flow.google.com/';
const FLOW_URL = get('flowUrl', FLOW_APP_URL);

export async function launchKiaraProfile(headless = false) {
  if (isBrowserConnected()) {
    logger.info('Browser already connected, reusing');
    return { success: true, message: 'Already connected' };
  }

  const userDataDir = get('chromeUserDataDir') || path.resolve(process.env.HOME || '', '.config/google-chrome');
  const profileName = get('chromeProfile', 'Profile 3');
  const profileSource = path.join(userDataDir, profileName);

  if (!fs.existsSync(profileSource)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR,
      `Profile "${profileName}" not found at ${profileSource}. Check chromeUserDataDir / chromeProfile in config/flow.config.json.`);
  }

  logger.info('Launching Chrome via direct+CDP method (anti-detection)', { profileSource });

  try {
    // Try connecting to existing Chrome instance first
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    logger.info('Found existing Chrome instance, reusing');
    const ctx = existing.contexts()[0];
    // Prefer a tab that's already inside a Flow project, then any Flow tab
    const tabs = ctx?.pages() || [];
    const pg = tabs.find(p => p.url().includes('flow.google.com/project/'))
      || tabs.find(p => p.url().includes('flow.google.com'))
      || tabs[0];
    setBrowser(existing);
    setContext(ctx);
    setConnected(true);
    if (pg) { setPage(pg); return { browser: existing, context: ctx, page: pg }; }
    const newPage = await ctx.newPage();
    setPage(newPage);
    return { browser: existing, context: ctx, page: newPage };
  } catch {
    // Launch Chrome directly (not via Playwright) for anti-detection
    return await launchChromeDirect({
      chromePath: resolveBrowserPath(),
      cdpPort: CDP_PORT,
      headless,
      profileSource,
    });
  }
}

export async function navigateToFlow(page, toolPage) {
  const targetUrl = toolPage === true ? FLOW_APP_URL : FLOW_URL;

  // Already in the Flow app (e.g. inside a project)? Stay there instead of navigating away.
  // Compare the host itself: the sign-in URL contains "continue=https://flow.google.com/"
  const inApp = url => {
    try {
      const u = new URL(url);
      return u.hostname === 'flow.google.com' && !u.pathname.startsWith('/about');
    } catch { return false; }
  };
  if (inApp(page.url())) {
    logger.info('Already in the Flow app — not navigating', { url: page.url().substring(0, 100) });
    return { authenticated: true, url: page.url() };
  }

  logger.info('Navigating to Google Flow', { url: targetUrl });
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    // A freshly launched Edge loads its own new-tab page, which can interrupt ours — retry once
    if (!/interrupted by another navigation/.test(err.message)) throw err;
    await page.waitForTimeout(1500);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  }
  await page.waitForTimeout(2000);

  // The public /about page has no direct link into the app: its "Create with Google Flow"
  // button (JS, no href) opens the app for a signed-in user, or Google sign-in otherwise.
  if (new URL(page.url()).pathname.startsWith('/about')) {
    logger.info('Landed on the public Flow page — clicking "Create with Google Flow"', { from: page.url() });
    const createBtn = page.locator('button:visible').filter({ hasText: /Create with Google Flow|Tạo bằng Google Flow/ }).first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForURL(u => !u.toString().includes('/about'), { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });

  if (new URL(currentUrl).hostname === 'accounts.google.com') {
    return { authenticated: false, url: currentUrl,
      message: 'Google sign-in required: sign in to Google in the open browser window, then retry.' };
  }
  if (!inApp(currentUrl)) {
    // The app redirects signed-out visitors back to the public page
    return { authenticated: false, url: currentUrl, message: 'Not signed in to Google Flow in this browser profile.' };
  }

  return { authenticated: true, url: currentUrl };
}
