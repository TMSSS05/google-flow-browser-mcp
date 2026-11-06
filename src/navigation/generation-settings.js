import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

// The composer's settings chip reads e.g. "🍌 Nano Banana 2.1 crop_16_9 x4".
// Its aria-label is localized, so we match on its class. In Agent mode it's empty.
const CHIP_SELECTOR = 'button.settings-trigger-button';
// "Agent" toggle chip next to the prompt; when pressed, Generate goes to the Flow Agent.
const AGENT_CHIP = 'button.agent-mode-chip';

// Material icon name shown on the chip → ratio
const RATIO_ICONS = {
  crop_16_9: '16:9',
  crop_landscape: '4:3',
  crop_square: '1:1',
  crop_portrait: '3:4',
  crop_9_16: '9:16',
};

// Names used by callers that no longer exist verbatim in the Flow model menu
const MODEL_ALIASES = {
  'Nano Banana 2': 'Nano Banana 2.1',
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveModelLabel(model) {
  return MODEL_ALIASES[model] || model;
}

/**
 * Read the current generation settings from the composer chip.
 * Returns { model, ratio, quantity, raw } or null if the chip isn't visible.
 */
export async function readGenerationSettings(page) {
  const chip = page.locator(CHIP_SELECTOR).first();
  if (!(await chip.isVisible().catch(() => false))) return null;

  const raw = ((await chip.textContent()) || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null; // Agent mode hides the settings summary
  const iconMatch = raw.match(/crop_[a-z0-9_]+/);
  const qtyMatch = raw.match(/x(\d)\s*$/);
  const model = raw
    .slice(0, iconMatch ? iconMatch.index : raw.length)
    .replace(/[^\p{L}\p{N}.\s-]/gu, '')
    .trim();

  return {
    model,
    ratio: iconMatch ? RATIO_ICONS[iconMatch[0]] || iconMatch[0] : null,
    quantity: qtyMatch ? Number(qtyMatch[1]) : null,
    raw,
  };
}

/** Turn off Agent mode so Generate runs a direct generation with the chip's settings. */
async function ensureAgentModeOff(page) {
  const chip = page.locator(AGENT_CHIP).first();
  if (!(await chip.isVisible().catch(() => false))) return;
  if ((await chip.getAttribute('aria-pressed')) !== 'true') return;

  logger.info('Agent mode is on — turning it off');
  await chip.click();
  await page.waitForTimeout(800);
  if ((await chip.getAttribute('aria-pressed')) === 'true') {
    await takeScreenshot(page, 'agent-mode-stuck');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not turn off Agent mode in the composer');
  }
}

async function openSettings(page) {
  const radios = page.locator('[role="radio"]:visible');
  if (await radios.first().isVisible().catch(() => false)) return;
  await page.locator(CHIP_SELECTOR).first().click();
  await page.waitForTimeout(800);
}

async function selectRadio(page, pattern, label) {
  await openSettings(page);
  const radio = page.locator('[role="radio"]:visible').filter({ hasText: pattern }).first();
  if (!(await radio.isVisible().catch(() => false))) {
    await takeScreenshot(page, `setting-${label}-not-found`);
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Setting option "${label}" not found in Flow settings panel`);
  }
  if ((await radio.getAttribute('aria-checked')) !== 'true') {
    await radio.click();
    await page.waitForTimeout(400);
  }
}

async function selectModel(page, modelLabel) {
  await openSettings(page);
  const dropdown = page.locator('button[aria-haspopup="menu"]:visible').filter({ hasText: 'arrow_drop_down' }).first();
  if (!(await dropdown.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Model dropdown not found in Flow settings panel');
  }
  if (new RegExp(`${escapeRe(modelLabel)}\\s*arrow_drop_down`).test((await dropdown.textContent()) || '')) {
    return; // already selected
  }
  await dropdown.click();
  await page.waitForTimeout(600);

  // Compare whole names (icon stripped) so "Nano Banana 2" never matches "Nano Banana 2.1"
  const items = page.locator('[role="menuitem"]:visible');
  const names = (await items.allTextContents()).map(menuItemName);
  const index = names.indexOf(modelLabel);
  if (index < 0) {
    await page.keyboard.press('Escape');
    throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
      `Model "${modelLabel}" not in Flow model menu. Available: ${names.join(', ')}`);
  }
  await items.nth(index).click();
  await page.waitForTimeout(600);
}

// Menu items and the dropdown carry an icon before the name: "🍌 Nano Banana 2.1",
// "volume_upVeo 3.1 - Lite" (material icon ligature). Return just the name.
function menuItemName(text) {
  return text.trim()
    .replace(/\s*arrow_drop_down\s*$/, '')
    .replace(/^[a-z_]+(?=[^a-z_])/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

/**
 * Put the composer in IMAGE mode with the requested model, ratio and quantity,
 * then re-read the chip and fail if anything doesn't match.
 * Does NOT touch the Generate button.
 */
export async function applyImageSettings(page, { model, ratio, quantity }) {
  const modelLabel = resolveModelLabel(model);
  logger.info('Applying image settings in UI', { modelLabel, ratio, quantity });

  await ensureAgentModeOff(page);
  await selectRadio(page, /^\s*image/, 'image-mode');
  await selectRadio(page, new RegExp(`${escapeRe(ratio)}\\s*$`), `ratio-${ratio}`);
  await selectRadio(page, new RegExp(`^\\s*x${quantity}\\s*$`), `quantity-x${quantity}`);
  await selectModel(page, modelLabel);

  // Confirm image mode is still the checked option before closing the panel
  await openSettings(page);
  const imageChecked = await page.locator('[role="radio"]:visible')
    .filter({ hasText: /^\s*image/ }).first().getAttribute('aria-checked').catch(() => null);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const actual = await readGenerationSettings(page);
  const mismatches = [];
  if (imageChecked !== 'true') mismatches.push('mode is not Image');
  if (!actual) mismatches.push('settings chip not readable');
  else {
    if (actual.model !== modelLabel) mismatches.push(`model "${actual.model}" ≠ "${modelLabel}"`);
    if (actual.ratio !== ratio) mismatches.push(`ratio "${actual.ratio}" ≠ "${ratio}"`);
    if (actual.quantity !== quantity) mismatches.push(`quantity x${actual.quantity} ≠ x${quantity}`);
  }
  const agentOn = await page.locator(AGENT_CHIP).first().getAttribute('aria-pressed').catch(() => null);
  if (agentOn === 'true') mismatches.push('Agent mode is on');
  if (mismatches.length) {
    await takeScreenshot(page, 'image-settings-mismatch');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `🚨 Settings not applied: ${mismatches.join('; ')}. Generation aborted.`, { actual });
  }

  logger.info('✅ Image settings verified in UI', actual);
  return actual;
}

// ---------------------------------------------------------------- video

/** Credits Flow says the current settings will cost ("Quá trình tạo sẽ tốn 12 tín dụng"). */
async function readCreditCost(page) {
  const text = (await page.locator('.cdk-overlay-pane:visible').allInnerTexts().catch(() => [])).join(' ');
  const m = text.normalize('NFC').match(/(\d+)\s*(tín dụng|credits?|crédits?)/i);
  return m ? Number(m[1]) : null;
}

async function isChecked(page, pattern) {
  const radio = page.locator('[role="radio"]:visible').filter({ hasText: pattern }).first();
  return (await radio.getAttribute('aria-checked').catch(() => null)) === 'true';
}

/**
 * Put the composer in VIDEO › Frames mode (start/end frame) with the requested model,
 * ratio, duration (seconds) and quantity, read the credit cost Flow shows, then verify.
 * Does NOT touch the Generate button. Returns { model, ratio, duration, quantity, credits, raw }.
 */
export async function applyVideoSettings(page, { model, ratio, duration, quantity }) {
  logger.info('Applying video settings in UI', { model, ratio, duration, quantity });
  const videoRe = /^\s*videocam/;
  const framesRe = /^\s*crop_free/; // "Khung hình" / "Frames"
  const ratioRe = new RegExp(`${escapeRe(ratio)}\\s*$`);
  // "8 giây" / "8s": match the number only (Flow's Vietnamese text may use another Unicode form)
  const durationRe = new RegExp(`^\\s*${duration}(?!\\d)[^\\dx]*$`);
  const quantityRe = new RegExp(`^\\s*x${quantity}\\s*$`);

  await ensureAgentModeOff(page);
  await selectRadio(page, videoRe, 'video-mode');
  await selectRadio(page, framesRe, 'frames-mode');
  // Model before duration: the available durations depend on it (Veo has no 10 s)
  await selectModel(page, model);
  await selectRadio(page, ratioRe, `ratio-${ratio}`);
  await selectRadio(page, durationRe, `duration-${duration}s`);
  await selectRadio(page, quantityRe, `quantity-x${quantity}`);
  await page.waitForTimeout(500);

  await openSettings(page);
  const credits = await readCreditCost(page);
  const dropdownText = await page.locator('.cdk-overlay-pane button[aria-haspopup="menu"]:visible')
    .filter({ hasText: 'arrow_drop_down' }).first().textContent().catch(() => '');
  const checks = {
    'video mode': await isChecked(page, videoRe),
    'frames mode': await isChecked(page, framesRe),
    [`ratio ${ratio}`]: await isChecked(page, ratioRe),
    [`duration ${duration}s`]: await isChecked(page, durationRe),
    [`quantity x${quantity}`]: await isChecked(page, quantityRe),
    [`model ${model}`]: menuItemName(dropdownText || '') === model,
  };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const raw = ((await page.locator(CHIP_SELECTOR).first().textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
  const agentOn = await page.locator(AGENT_CHIP).first().getAttribute('aria-pressed').catch(() => null);
  const mismatches = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => `${k} not set`);
  if (agentOn === 'true') mismatches.push('Agent mode is on');
  if (credits == null) mismatches.push('credit cost not readable');
  if (mismatches.length) {
    await takeScreenshot(page, 'video-settings-mismatch');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `🚨 Video settings not applied: ${mismatches.join('; ')}. Generation aborted.`, { raw });
  }
  const result = { model, ratio, duration, quantity, credits, raw };
  logger.info('✅ Video settings verified in UI', result);
  return result;
}

/**
 * Flow's view menu (⚙ next to the grid) has a global "Return videos without audio" switch.
 * With audio on, some generations fail ("Không tạo được âm thanh") — so callers can turn it off.
 */
export async function setVideoAudio(page, withAudio) {
  const menuBtn = page.locator('button').filter({ hasText: /^\s*settings_2\s*$/ }).first();
  if (!(await menuBtn.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Flow view settings button (settings_2) not found');
  }
  await menuBtn.click();
  const switches = page.locator('[role="menu"] button[role="switch"]');
  await switches.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  // Match the label after Unicode normalization (Flow's Vietnamese may use decomposed accents)
  const index = await switches.evaluateAll(els => els.findIndex(e => {
    const label = (e.getAttribute('aria-label') || e.closest('.toggle-container')?.textContent || '').normalize('NFC').toLowerCase();
    return /không có âm thanh|without audio|no audio|sans audio|sans son/.test(label);
  })).catch(() => -1);
  const toggle = switches.nth(Math.max(index, 0));
  if (index < 0) {
    await page.keyboard.press('Escape');
    await takeScreenshot(page, 'audio-toggle-missing');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, '"Return videos without audio" switch not found in Flow view settings');
  }
  const wantNoAudio = !withAudio;
  if (((await toggle.getAttribute('aria-checked')) === 'true') !== wantNoAudio) {
    await toggle.click();
    await page.waitForTimeout(500);
  }
  const ok = ((await toggle.getAttribute('aria-checked')) === 'true') === wantNoAudio;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (!ok) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Could not turn video audio ${withAudio ? 'on' : 'off'}`);
  logger.info('Video audio setting', { withAudio });
}
