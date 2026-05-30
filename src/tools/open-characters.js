import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';

export async function handleOpenCharacters() {
  const page = getPage();
  const baseUrl = 'https://labs.google/fx/tools/flow';

  await page.goto(baseUrl + '/characters', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const elements = await detectPageElements();
  const screenshot = await takeScreenshot(page, 'characters-page');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}
