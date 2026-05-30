import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';

export async function handleCreateCharacter(args) {
  const job = jobQueue.createJob('create_character', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Ensure we're inside a project
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    // Navigate to the Personnages sidebar section
    await navigateToSidebar(page, 'Personnages');
    await page.waitForTimeout(2000);

    await takeScreenshot(page, 'characters-section');

    // Look for "New Character" button
    const newCharLocator = page.locator(
      'button:has-text("New Character"), button:has-text("Créer"), button:has-text("Nouveau"), text=New Character, text=Nouveau'
    ).first();

    if (!await newCharLocator.isVisible().catch(() => false)) {
      const elements = await detectPageElements(page);
      return {
        status: 'ui_discovered',
        message: 'Characters section opened. New Character button not auto-detected.',
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'characters-ui'),
      };
    }

    await newCharLocator.click();
    await page.waitForTimeout(1500);

    // Fill character description
    const descLocator = page.locator(
      'textarea, [contenteditable="true"], input[placeholder*="cribe"], input[placeholder*="description"]'
    ).first();
    if (await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await descLocator.fill('');
      await page.waitForTimeout(200);
      await descLocator.type(args.description, { delay: 20 });
    }

    // Upload reference image if provided
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
      projectName: args.project_name,
      campaign: args.campaign,
      jobId: job.id,
      status: 'ready_for_confirmation',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'character',
      description: args.description,
      message: 'Character setup complete. Manual confirmation needed to create.',
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
  await navigateToSidebar(page, 'Personnages');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
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
