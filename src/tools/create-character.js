import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';

export async function handleCreateCharacter(args) {
  const job = jobQueue.createJob('create_character', args);

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Navigate to characters page
    const currentUrl = page.url();
    const baseUrl = 'https://labs.google/fx/tools/flow';
    const charsUrl = currentUrl.includes('labs.google')
      ? currentUrl.replace(/\/$/, '') + '/characters'
      : baseUrl + '/characters';

    await page.goto(charsUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await takeScreenshot(page, 'characters-page');

    // Look for "New Character" button
    const newCharLocator = page.locator('button:has-text("New Character"), button:has-text("Créer"), text=New Character, text=Nouveau').first();
    if (!await newCharLocator.isVisible().catch(() => false)) {
      const elements = await detectPageElements();
      return {
        status: 'ui_discovered',
        message: 'Characters page opened. New Character button not auto-detected. UI elements found.',
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'characters-ui'),
      };
    }

    await newCharLocator.click();
    await page.waitForTimeout(1500);

    // Look for description input
    const descLocator = page.locator('textarea, [contenteditable="true"], input[placeholder*="cribe"], input[placeholder*="description"]').first();
    if (await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await descLocator.fill('');
      await page.waitForTimeout(200);
      await descLocator.type(args.description, { delay: 20 });
    }

    // Look for reference image upload
    if (args.reference_image) {
      const fileLocator = page.locator('input[type="file"]').first();
      if (await fileLocator.isVisible().catch(() => false)) {
        await fileLocator.setInputFiles(args.reference_image);
        await page.waitForTimeout(2000);
        logger.info('Reference image uploaded');
      }
    }

    // Try to select model
    if (args.model) {
      try {
        const modelLocator = page.locator(`button:has-text("${args.model}")`).first();
        if (await modelLocator.isVisible().catch(() => false)) {
          await modelLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    await takeScreenshot(page, 'character-ready');

    saveMetadata(job.id, {
      type: 'character',
      description: args.description,
      model: args.model,
      referenceImage: args.reference_image,
      jobId: job.id,
      status: 'ready_for_confirmation',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'character',
      description: args.description,
      message: 'Character setup complete. Manual confirmation needed to create (may use credits).',
      screenshot: await takeScreenshot(page, 'character-ready'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'create-character-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}

export async function handleListCharacters() {
  const page = getPage();
  const charsUrl = page.url().includes('labs.google')
    ? page.url().replace(/\/$/, '') + '/characters'
    : 'https://labs.google/fx/tools/flow/characters';

  await page.goto(charsUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const elements = await detectPageElements();
  const characterCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Créer') && b.text.length > 2
  );

  return {
    status: 'success',
    characters_found: characterCards,
    raw_elements: elements,
    screenshot: await takeScreenshot(page, 'characters-list'),
  };
}
