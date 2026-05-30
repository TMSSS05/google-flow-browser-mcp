import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';

export async function handleOpenToolsGallery() {
  const page = getPage();
  await navigateToSidebar(page, 'Outils');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'tools-section');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}

export async function handleListTools() {
  const page = getPage();
  await navigateToSidebar(page, 'Outils');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);

  return {
    tools_found: elements,
    screenshot: await takeScreenshot(page, 'tools-section'),
  };
}

export async function handleOpenTool(args) {
  const page = getPage();
  const toolName = args.name || args.tool_name;

  if (!toolName) {
    throw new Error('Tool name is required');
  }

  logger.info('Opening tool', { toolName, projectName: args.project_name });

  await navigateToSidebar(page, 'Outils');
  await page.waitForTimeout(2000);

  // Try to find and click the tool within the project's tools section
  const toolLocator = page.locator(
    `a:has-text("${toolName}"), button:has-text("${toolName}"), text="${toolName}"`
  ).first();
  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    logger.warn('Tool not found in sidebar, trying direct URL');
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    await page.goto(`https://labs.google/fx/tools/flow/tools/${toolSlug}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
  }

  const elements = await detectPageElements(page);
  return {
    status: 'opened',
    tool: toolName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, `tool-${toolName.replace(/\s/g, '-')}`),
  };
}
