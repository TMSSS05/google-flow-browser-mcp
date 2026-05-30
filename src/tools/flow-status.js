import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { get } from '../utils/config.js';

const EXPECTED_ACCOUNT = get('expectedAccount', 'your-email@gmail.com');

export async function handleFlowStatus() {
  const status = {
    browser: isBrowserConnected(),
    account: null,
    flowAccessible: false,
    oauthRequired: false,
    currentUrl: null,
    pageTitle: null,
    queue: jobQueue.getStatus(),
  };

  if (isBrowserConnected()) {
    try {
      const page = getPage();
      status.currentUrl = page.url();
      status.pageTitle = await page.title();
      status.flowAccessible = status.currentUrl?.includes('labs.google') || false;
      status.oauthRequired = status.currentUrl?.includes('accounts.google.com') || false;

      if (status.flowAccessible && !status.oauthRequired) {
        const accountEl = await page.$('[data-account-email], [aria-label*="gmail"]');
        if (accountEl) {
          status.account = await accountEl.textContent();
        }
      }
    } catch (err) {
      status.browserError = err.message;
    }
  }

  status.expectedAccount = EXPECTED_ACCOUNT;

  logger.info('Status check', status);
  return status;
}
