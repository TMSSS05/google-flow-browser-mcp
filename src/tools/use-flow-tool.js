import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';

export async function handleUseFlowTool(args) {
  const page = getPage();
  const toolName = args.tool_name || args.name;

  if (!toolName) {
    throw new Error('Tool name is required');
  }

  const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
  const toolUrl = `https://labs.google/fx/tools/flow/tools/${toolSlug}`;

  await page.goto(toolUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const elements = await detectPageElements();

  if (args.params && typeof args.params === 'object') {
    for (const [key, value] of Object.entries(args.params)) {
      if (typeof value === 'string') {
        const input = await page.$(`[name="${key}"], [placeholder="${key}"], [aria-label="${key}"]`);
        if (input) {
          await input.click();
          await input.fill('');
          await page.waitForTimeout(200);
          await input.type(value, { delay: 10 });
        }
      }
    }
  }

  await takeScreenshot(page, `tool-${toolSlug}-setup`);

  return {
    status: 'tool_opened',
    tool: toolName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, `tool-${toolSlug}`),
  };
}
