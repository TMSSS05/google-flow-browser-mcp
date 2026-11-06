import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';

const EXPECTED_ACCOUNT = get('expectedAccount', 'your-email@gmail.com');

/**
 * Read the signed-in Google account email from the page.
 * The Google account avatar is a link to accounts.google.com/SignOutOptions whose
 * aria-label contains the email, e.g. "Google Account: Name (me@gmail.com)".
 * This works regardless of UI language. Returns null when not signed in / not found.
 */
export async function readSignedInEmail(page) {
  return page.evaluate(() => {
    const emailRe = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
    const candidates = document.querySelectorAll(
      'a[href*="accounts.google.com/SignOutOptions"], a[aria-label*="@"], [data-account-email]'
    );
    for (const el of candidates) {
      const text = el.getAttribute('data-account-email') || el.getAttribute('aria-label') || '';
      const match = text.match(emailRe);
      if (match) return match[0];
    }
    return null;
  }).catch(() => null);
}

export async function verifyAccount() {
  const page = getPage();
  const currentUrl = page.url();

  logger.info('Verifying Google account on Flow', { expectedAccount: EXPECTED_ACCOUNT });

  try {
    const email = await readSignedInEmail(page);

    if (!email) {
      // Not signed in, or on a page without the account avatar (e.g. the public /about page).
      // Do NOT assume the expected account — report it as unverified.
      logger.warn('Could not detect signed-in account', { currentUrl: currentUrl?.substring(0, 80) });
      return { verified: false, account: null, method: 'not-detected', currentUrl };
    }

    if (email.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) {
      await takeScreenshot(page, 'wrong-account');
      throw new FlowError(
        ErrorCodes.WRONG_GOOGLE_ACCOUNT,
        `Wrong Google account detected. Expected ${EXPECTED_ACCOUNT}, found ${email}`
      );
    }

    logger.info('Account verified via account link', { account: email });
    return { verified: true, account: email, method: 'account-link' };
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(
      ErrorCodes.PLAYWRIGHT_ERROR,
      `Failed to verify account: ${err.message}`
    );
  }
}
