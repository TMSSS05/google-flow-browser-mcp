import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';

export async function handleOpenScenes() {
  const page = getPage();
  await navigateToSidebar(page, 'Scènes');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'scenes-section');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}

export async function handleCreateScene(args) {
  const page = getPage();

  await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  await navigateToSidebar(page, 'Scènes');
  await page.waitForTimeout(2000);
  await takeScreenshot(page, 'scenes-section');

  const elements = await detectPageElements(page);
  const newSceneLocator = page.locator(
    'button:has-text("New Scene"), button:has-text("Créer"), button:has-text("Nouvelle scène")'
  ).first();

  if (await newSceneLocator.isVisible().catch(() => false)) {
    await newSceneLocator.click();
    await page.waitForTimeout(1500);

    if (args.description) {
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      if (await inputLocator.isVisible().catch(() => false)) {
        await inputLocator.click();
        await inputLocator.fill('');
        await page.waitForTimeout(200);
        await inputLocator.type(args.description, { delay: 20 });
      }
    }

    if (args.reference_image) {
      const fileInputLocator = page.locator('input[type="file"]').first();
      if (await fileInputLocator.isVisible().catch(() => false)) {
        await fileInputLocator.setInputFiles(args.reference_image);
        await page.waitForTimeout(2000);
      }
    }

    saveMetadata('scene-' + Date.now(), {
      type: 'scene',
      description: args.description,
      referenceImage: args.reference_image,
      projectName: args.project_name,
      campaign: args.campaign,
    });
  }

  return {
    status: 'ready_for_confirmation',
    elements,
    screenshot: await takeScreenshot(page, 'scene-ready'),
  };
}

export async function handleListScenes() {
  const page = getPage();
  await navigateToSidebar(page, 'Scènes');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const sceneCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Créer') && b.text.length > 2
  );

  return {
    scenes_found: sceneCards,
    screenshot: await takeScreenshot(page, 'scenes-list'),
  };
}
