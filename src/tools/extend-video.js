// Flow scene editor: "＋ › Kéo dài" (Extend) — continue a generated video with more 4-second
// shots that start from where it ends, so characters / outfits / place stay consistent.
// Flow's UI here is in the account's language (Vietnamese); English labels are fallbacks.
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

const L = {
  addClip: /^(Thêm đoạn video|Add clip)$/i,
  extend: /Kéo dài|Extend/i,
  settings: /Điều kiện kích hoạt cài đặt|settings/i,
  generate: /^(Bắt đầu tạo|Generate|Create)$/i,
  download: /Tải nội dung nghe nhìn xuống|Download/i,
  original: /720p|Kích thước gốc|Original/i,
  back: /Nút quay lại|Go back|Back/i,
  promptHint: /Tiếp theo là gì\?|What happens next\?/i,
};
const STEP_TIMEOUT_MS = 8 * 60 * 1000;

/** Longest "MM:SS:FF" clock on the page = the scene's total length in seconds. */
async function sceneSeconds(page) {
  return page.evaluate(() => {
    let best = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount) continue;
      const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(el.textContent.trim());
      if (m) best = Math.max(best, Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100);
    }
    return best;
  }).catch(() => 0);
}
/** "12%" progress labels while Flow renders. */
async function progressShown(page) {
  return page.evaluate(() => [...document.querySelectorAll('body *')]
    .some(el => !el.childElementCount && /^\d{1,3}%$/.test(el.textContent.trim()))).catch(() => false);
}

/** Close an open menu / popover. Escape with nothing open would leave the scene editor. */
async function closeMenus(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.locator('.cdk-overlay-backdrop, [role=menu]').count().catch(() => 0);
    if (!open) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}

/** Back in the scene editor of this film (Flow can drop to the project grid). */
async function ensureEditor(page, editUrl) {
  if (page.url().startsWith(editUrl)) return;
  logger.warn('Left the scene editor — reopening it', { url: page.url() });
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: L.addClip }).last().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2000);
}

/**
 * Is the scene editor idle? While a clip renders Flow keeps "＋ › Kéo dài" disabled (the timeline
 * already shows a placeholder for the new clip, so its length alone can't tell).
 */
async function editorIdle(page) {
  try {
    await page.getByRole('button', { name: L.addClip }).last().click({ timeout: 5000 });
    const item = page.getByRole('menuitem', { name: L.extend }).first();
    await item.waitFor({ timeout: 5000 });
    const disabled = (await item.getAttribute('disabled')) != null || (await item.getAttribute('aria-disabled')) === 'true';
    return !disabled;
  } catch { return false; }
  finally { await closeMenus(page); }
}
/** Wait until the editor is idle (e.g. before downloading). */
async function waitIdle(page, ms = 5 * 60 * 1000, editUrl = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (editUrl) await ensureEditor(page, editUrl);
    if (!(await progressShown(page)) && await editorIdle(page)) return true;
    await page.waitForTimeout(5000);
  }
  return false;
}

/** Open a video of the project grid in the scene editor, by its media token. */
async function openVideo(page, token) {
  const tile = page.locator('flow-video-tile').filter({ has: page.locator(`img[src*="${token}"], video[src*="${token}"]`) }).first();
  await tile.waitFor({ state: 'attached', timeout: 30000 });
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 30000 });
  await page.getByRole('button', { name: L.addClip }).last().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  return page.url().split('?')[0];
}

/** Credits Flow says one extension costs (from the settings popover), or null if not shown. */
async function extendCost(page) {
  const toggle = page.getByRole('button', { name: L.settings }).first();
  const label = page.locator('.credit-cost-label').first();
  try {
    await toggle.click();
    await label.waitFor({ timeout: 5000 });
    const text = await page.locator('.cdk-overlay-pane').allInnerTexts();
    const m = /(\d+)\s*(tín dụng|credits?)/i.exec(text.join(' '));
    return m ? Number(m[1]) : null;
  } catch { return null; }
  finally {
    // close it with the same button (Escape could leave the editor); it must not cover the prompt
    for (let i = 0; i < 3 && await label.isVisible().catch(() => false); i++) {
      await toggle.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await closeMenus(page);
  }
}

/** One extension: ＋ › Kéo dài › prompt › generate › wait until the timeline got longer. */
async function extendOnce(page, prompt, maxCredits, editUrl) {
  await ensureEditor(page, editUrl);
  // the clock renders a moment after the editor — a 0 here would make any length look "grown"
  let before = 0;
  for (let i = 0; i < 20 && !(before > 0); i++) { before = await sceneSeconds(page); if (!(before > 0)) await page.waitForTimeout(500); }
  if (!(before > 0)) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Không đọc được thời lượng video trong trình dựng cảnh của Flow.');
  await page.getByRole('button', { name: L.addClip }).last().click();
  await page.getByRole('menuitem', { name: L.extend }).first().click();
  await page.getByText(L.promptHint).first().waitFor({ timeout: 15000 });
  const cost = await extendCost(page);
  if (maxCredits != null && cost != null && cost > maxCredits) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Flow báo kéo dài tốn ${cost} credit, hơn mức đã duyệt ${maxCredits}.`);
  }
  const box = page.getByRole('textbox', { name: L.promptHint }).first();
  await box.focus(); // focus, not click: nothing on top of it can get in the way
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(500);
  const go = page.getByRole('button', { name: L.generate }).last();
  if (await go.isDisabled().catch(() => true)) throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Nút tạo (kéo dài) đang tắt.');
  logger.info('⚠️ Extending video — credits will be consumed', { cost, before });
  await go.click();

  const started = Date.now();
  let sawProgress = false;
  await page.waitForTimeout(15000); // the placeholder + progress take a moment to show up
  while (Date.now() - started < STEP_TIMEOUT_MS) {
    await page.waitForTimeout(5000);
    const busy = await progressShown(page);
    sawProgress ||= busy;
    if (busy) continue;
    // no progress label: done only once Flow lets us extend again (and rendering really ran)
    if (!sawProgress && Date.now() - started < 60000) continue;
    await ensureEditor(page, editUrl);
    if (!(await editorIdle(page))) continue;
    const now = await sceneSeconds(page);
    if (now > before + 1) return { cost, seconds: now };
    break; // idle again but the scene didn't grow → this extension failed
  }
  await takeScreenshot(page, 'extend-failed');
  throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, sawProgress ? 'Flow không kéo dài được đoạn này (có thể bị từ chối nội dung).' : 'Hết thời gian chờ kéo dài video.');
}

/** Close popovers / toasts left over from generating (they can cover the toolbar). */
async function clearOverlays(page) {
  await closeMenus(page);
  await page.mouse.move(5, 5).catch(() => {});
  for (const close of await page.getByRole('button', { name: /^(Đóng|Close|Dismiss)$/i }).all().catch(() => [])) await close.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** Download the whole scene (all clips joined by Flow) as the original-size mp4. */
export async function downloadScene(page, outFile, editUrl = null) {
  if (editUrl) await ensureEditor(page, editUrl);
  const button = page.getByRole('button', { name: L.download }).first();
  const item = page.getByRole('menuitem', { name: L.original }).first();
  // Right after an extension the toolbar can ignore clicks for a while (Flow is still saving the
  // scene): keep trying, and reload the editor once if it stays stuck.
  for (let attempt = 0; ; attempt++) {
    await clearOverlays(page);
    await button.click({ timeout: 10000, force: attempt % 3 === 2 }).catch(() => {});
    if (await item.waitFor({ timeout: 10000 }).then(() => true, () => false)) break;
    if (attempt >= 7) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Không mở được menu tải xuống của Flow.');
    if (attempt === 3) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await button.waitFor({ timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else await page.waitForTimeout(4000);
  }
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), item.click()]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await dl.saveAs(outFile);
  return outFile;
}

/**
 * Open the video `token`, extend it once per step (step.prompt), then download the joined film.
 * steps are mutable status objects ({ prompt, status, error }) so a caller can show progress.
 * Stops at the first failed step but still downloads what was made. Returns { file, seconds }.
 */
export async function extendVideoChain(page, { token, steps, outFile, maxCredits = null, isCancelled = () => false }) {
  const editUrl = await openVideo(page, token);
  let failure = null;
  try {
    for (const step of steps) {
      if (isCancelled()) { step.status = 'cancelled'; continue; }
      if (failure) { step.status = 'error'; step.error = 'Dừng vì đoạn trước lỗi.'; continue; }
      step.status = 'running';
      try {
        const r = await extendOnce(page, step.prompt, maxCredits, editUrl);
        step.status = 'done';
        step.seconds = r.seconds;
      } catch (err) {
        step.status = 'error';
        step.error = err.message;
        failure = err;
        logger.warn('Extend step failed', { error: err.message });
      }
    }
    await waitIdle(page, 5 * 60 * 1000, editUrl);
    const seconds = await sceneSeconds(page);
    // The toolbar of an editor that just generated sometimes stops responding; a freshly opened
    // editor (back to the grid → open the same video) downloads fine — so retry that way.
    let file;
    for (let attempt = 1; ; attempt++) {
      try { file = await downloadScene(page, outFile, editUrl); break; }
      catch (err) {
        logger.warn('Film download failed', { attempt, error: err.message });
        await takeScreenshot(page, `film-download-failed-${attempt}`).catch(() => {});
        if (attempt >= 3) throw err;
        await page.goto(editUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); // a fresh editor
        await page.getByRole('button', { name: L.addClip }).last().waitFor({ timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await waitIdle(page, 60000, editUrl);
      }
    }
    logger.info('Extended film downloaded', { file, seconds });
    return { file, seconds, failed: Boolean(failure) };
  } finally {
    // back to the project grid so the next generation finds its controls
    await page.getByRole('button', { name: L.back }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }
}
