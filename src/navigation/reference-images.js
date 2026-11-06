import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// Composer "+" button: opens the "add ingredient" panel (upload + project media list).
// aria-label is localized, so match the icon text.
const ADD_BTN = 'button[aria-haspopup="true"][aria-label]';
const PANEL = '.cdk-overlay-pane';
// Attached image chip in the composer: an ingredient, or a start/end frame in video
// Frames mode. Clicking it removes it.
const CHIP = 'button.chip-container';
// Empty start / end frame slots in video Frames mode
const FRAME_SLOT = '.empty-chip';
const FRAME_LABELS = {
  start: /Bắt đầu|Start|Début/,
  end: /Kết thúc|End|Fin/,
};

const uploadButton = page => page.locator(`${PANEL} button`).filter({ hasText: 'upload' }).first();

async function openAddPanel(page) {
  // The upload button is always present in the open panel, even for a project with no media yet
  if (await uploadButton(page).isVisible().catch(() => false)) return;
  await page.locator(ADD_BTN).filter({ hasText: /^\s*add\s*$/ }).last().click();
  await uploadButton(page).waitFor({ state: 'visible', timeout: 10000 });
}

/** Opens the "pick a frame image" panel for the start or end slot. */
function frameOpener(slot) {
  return async page => {
    if (await uploadButton(page).isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); // a panel for another slot may be open
      await page.waitForTimeout(400);
    }
    const target = page.locator(FRAME_SLOT).filter({ hasText: FRAME_LABELS[slot] }).first();
    if (!(await target.isVisible().catch(() => false))) {
      await takeScreenshot(page, `frame-slot-${slot}-missing`);
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Empty ${slot} frame slot not found (is Video › Frames mode on?)`);
    }
    await target.click();
    await uploadButton(page).waitFor({ state: 'visible', timeout: 10000 });
  };
}

/** Remove images left in the composer by a previous run (ingredients or frames). */
export async function clearReferenceImages(page) {
  const chips = page.locator(CHIP);
  for (let n = await chips.count(); n > 0; n--) {
    await chips.first().click();
    await page.waitForTimeout(300);
  }
}

/**
 * Put one local image into the composer through a Flow media panel opened by `openPanel`.
 * Reuses an upload with the same file name when the project already has it, otherwise uploads.
 */
async function attachOne(page, file, openPanel) {
  const name = path.basename(file);
  await openPanel(page);
  const option = page.locator(`${PANEL} [role="option"]`).filter({ hasText: name }).first();

  // Already uploaded to this project (e.g. earlier shot of the same batch)? Reuse it.
  const search = page.locator(`${PANEL} input`).first();
  const canSearch = await search.isVisible().catch(() => false);
  if (canSearch) {
    await search.fill(name);
    await page.waitForTimeout(1000);
  }
  const alreadyUploaded = await option.isVisible().catch(() => false);
  if (canSearch && !alreadyUploaded) await search.fill('');

  if (alreadyUploaded) {
    logger.info('Reusing image already in project', { name });
  } else {
    logger.info('Uploading image', { name });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), uploadButton(page).click()]);
    await chooser.setFiles(file);

    // The upload shows up in the panel's media list under its file name once processed
    try {
      await option.waitFor({ state: 'visible', timeout: 60000 });
    } catch {
      await takeScreenshot(page, 'reference-upload-timeout');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Uploaded image "${name}" did not appear in Flow's media list`);
    }
  }

  const chipsBefore = await page.locator(CHIP).count();
  await option.click();
  await page.waitForTimeout(800);
  // Picking a search result may attach it right away and close the panel; otherwise it is
  // only previewed and needs "Add to prompt". Handle both.
  const attachedDirectly = (await page.locator(CHIP).count()) > chipsBefore;
  if (!attachedDirectly) {
    const addBtn = page.locator(`${PANEL} button`).filter({ hasText: /Thêm vào câu lệnh|Add to prompt|Ajouter/ }).first();
    if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
  }
  try {
    await page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length > n, [CHIP, chipsBefore], { timeout: 10000 });
  } catch {
    await takeScreenshot(page, 'reference-attach-failed');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Could not attach "${name}" to the prompt`);
  }
  logger.info('Image attached', { name });
}

/** Wait for every chip thumbnail to load, then check the count. Returns the chip count. */
async function verifyChips(page, expected) {
  // The caller reads the media uuids from these thumbnails to keep its own inputs out of the results
  await page.waitForFunction(([sel, n]) => {
    const imgs = Array.from(document.querySelectorAll(`${sel} img`));
    return imgs.length >= n && imgs.every(i => /\/image\/[a-f0-9-]{36}/.test(i.src || ''));
  }, [CHIP, expected], { timeout: 20000 }).catch(() => logger.warn('Chip thumbnails did not finish loading'));

  const attached = await page.locator(CHIP).count();
  if (attached !== expected) {
    await takeScreenshot(page, 'reference-count-mismatch');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Expected ${expected} image(s) in the prompt, found ${attached}. Generation aborted.`);
  }
  return attached;
}

function checkFiles(files) {
  for (const f of files) {
    if (!fs.existsSync(f)) throw new FlowError(ErrorCodes.INVALID_PARAMS, `Image not found: ${f}`);
  }
}

/**
 * Upload local images and attach them to the composer as prompt ingredients.
 * Flow lists an upload by its file name, so files should have unique names.
 * Uploading does not consume credits. Returns the number of attached images.
 */
export async function attachReferenceImages(page, files) {
  checkFiles(files);
  await clearReferenceImages(page);
  for (const file of files) await attachOne(page, file, openAddPanel);
  return verifyChips(page, files.length);
}

/**
 * Video Frames mode: set the start frame (and optionally the end frame) from local images.
 * The composer must already be in Video › Frames mode. Returns the number of frames set.
 */
export async function attachFrameImages(page, { start, end }) {
  if (!start) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'A start frame image is required');
  const files = [start, end].filter(Boolean);
  checkFiles(files);
  await clearReferenceImages(page);
  await attachOne(page, start, frameOpener('start'));
  if (end) await attachOne(page, end, frameOpener('end'));
  return verifyChips(page, files.length);
}
