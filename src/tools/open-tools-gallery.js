import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';

export async function handleOpenToolsGallery() {
  const page = getPage();
  const baseUrl = 'https://labs.google/fx/tools/flow';

  await page.goto(baseUrl + '/tools?tab=GALLERY', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const elements = await detectPageElements();
  const screenshot = await takeScreenshot(page, 'tools-gallery');

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
  const elements = await detectPageElements();

  // Try to switch to "My Tools" tab
  const myToolsLocator = page.locator('button:has-text("My Tools"), [role="tab"]:has-text("My Tools")').first();
  if (await myToolsLocator.isVisible().catch(() => false)) {
    await myToolsLocator.click();
    await page.waitForTimeout(1000);
    const myToolsElements = await detectPageElements();
    return {
      discover: elements,
      my_tools: myToolsElements,
      screenshot: await takeScreenshot(page, 'my-tools'),
    };
  }

  return {
    tools_found: elements,
    screenshot: await takeScreenshot(page, 'tools-gallery'),
  };
}

export async function handleOpenTool(args) {
  const page = getPage();
  const toolName = args.name || args.tool_name;

  if (!toolName) {
    throw new Error('Tool name is required');
  }

  logger.info('Opening tool', { toolName });

  await page.goto('https://labs.google/fx/tools/flow/tools?tab=GALLERY', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Try to find and click the tool
  const toolLocator = page.locator(`a:has-text("${toolName}"), button:has-text("${toolName}"), text="${toolName}"`).first();
  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    logger.warn('Tool not found in gallery, trying direct URL');
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    await page.goto(`https://labs.google/fx/tools/flow/tools/${toolSlug}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
  }

  const elements = await detectPageElements();
  return {
    status: 'opened',
    tool: toolName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, `tool-${toolName.replace(/\s/g, '-')}`),
  };
}
