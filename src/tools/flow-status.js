import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { get } from '../utils/config.js';
import { readSignedInEmail } from '../browser/account-check.js';

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
      status.oauthRequired = status.currentUrl?.includes('accounts.google.com') || false;

      if (!status.oauthRequired) {
        status.account = await readSignedInEmail(page);
      }
      // Flow is usable once we're on a Flow host AND signed in (the public /about page has no account)
      const onFlowHost = /flow\.google\.com|labs\.google/.test(status.currentUrl || '');
      status.flowAccessible = onFlowHost && !!status.account;
    } catch (err) {
      status.browserError = err.message;
    }
  }

  status.expectedAccount = EXPECTED_ACCOUNT;

  logger.info('Status check', status);
  return status;
}
