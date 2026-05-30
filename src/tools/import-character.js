import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';

export async function handleImportCharacter(args) {
  const page = getPage();
  logger.info('Importing character', { name: args.name });

  const charsUrl = page.url().includes('labs.google')
    ? page.url().replace(/\/$/, '') + '/characters'
    : 'https://labs.google/fx/tools/flow/characters';

  await page.goto(charsUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    const elements = await detectPageElements();
    return {
      status: 'discovery_needed',
      message: 'Characters page opened. File input for import not auto-detected.',
      elements,
      screenshot: await takeScreenshot(page, 'characters-import'),
    };
  }

  if (args.image_path) {
    await fileInput.setInputFiles(args.image_path);
    await page.waitForTimeout(2000);
  }

  if (args.description) {
    const descInput = await page.$('textarea, [contenteditable="true"]');
    if (descInput) {
      await descInput.click();
      await descInput.fill('');
      await page.waitForTimeout(200);
      await descInput.type(args.description, { delay: 20 });
    }
  }

  await takeScreenshot(page, 'character-import-ready');

  return {
    status: 'ready_for_confirmation',
    message: 'Character import setup complete. Manual confirmation needed.',
    screenshot: await takeScreenshot(page, 'character-import-ready'),
  };
}
