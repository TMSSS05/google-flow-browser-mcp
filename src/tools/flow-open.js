import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { get } from '../utils/config.js';

const FLOW_URL = get('flowUrl', 'https://labs.google/fx/tools/flow');

export async function handleFlowOpen(args) {
  const page = getPage();
  const url = args.url || FLOW_URL;
  const waitFor = args.waitFor || 3000;

  logger.info('Opening Flow page', { url: url.substring(0, 80) });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(waitFor);

    const currentUrl = page.url();
    const pageTitle = await page.title();

    await takeScreenshot(page, 'flow-opened');

    // Detect if we're on a login page or the actual Flow
    const pageContent = await page.textContent('body') || '';
    const isLoggedIn = !pageContent.includes('Sign in') && !currentUrl.includes('SignOut');
    const isFlowPage = currentUrl.includes('labs.google/fx/tools/flow') || currentUrl.includes('labs.google');

    return {
      status: isLoggedIn && isFlowPage ? 'connected' : 'needs_login',
      url: currentUrl,
      title: pageTitle,
      isLoggedIn,
      isFlowPage,
    };
  } catch (err) {
    await takeScreenshot(page, 'flow-open-error');
    throw new FlowError(
      ErrorCodes.FLOW_PAGE_NOT_FOUND,
      `Failed to open Flow: ${err.message}`,
      { url }
    );
  }
}
