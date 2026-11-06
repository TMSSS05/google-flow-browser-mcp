import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

/** Replace the composer prompt with `text` and verify Flow received all of it. */
export async function fillPrompt(page, text) {
  const candidates = [
    page.locator('[contenteditable="true"]:visible').first(),
    page.locator('textarea:visible').first(),
  ];
  let input = null;
  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) { input = c; break; }
  }
  if (!input) {
    await takeScreenshot(page, 'no-prompt-input');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find the prompt input in the Flow project');
  }
  await page.keyboard.press('Escape'); // close any open panel first
  await page.waitForTimeout(400);
  await input.click();
  await input.fill('');
  await page.waitForTimeout(200);
  // Insert in one go: typing char-by-char exceeds the action timeout on long prompts
  await page.keyboard.insertText(text);
  await page.waitForTimeout(500);
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const typed = norm((await input.textContent()) || '');
  if (typed !== norm(text)) {
    await takeScreenshot(page, 'prompt-mismatch');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Prompt in Flow doesn't match what was sent (${typed.length}/${text.length} chars). Generation aborted.`);
  }
}
