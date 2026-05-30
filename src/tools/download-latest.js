import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

export async function handleDownloadLatest() {
  const page = getPage();
  logger.info('Attempting to download latest result');

  try {
    const downloadBtnLocator = page.locator('button:has-text("Download"), button:has-text("Télécharger"), [aria-label*="download"]').first();
const downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
const downloadBtn = downloadBtnVisible ? downloadBtnLocator : null;
    if (downloadBtn) {
      await downloadBtn.click();
      await page.waitForTimeout(3000);
      return { status: 'download_initiated', message: 'Download button clicked' };
    }

    await takeScreenshot(page, 'download-btn-not-found');
    return { status: 'not_found', message: 'No download button found on current page' };
  } catch (err) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
