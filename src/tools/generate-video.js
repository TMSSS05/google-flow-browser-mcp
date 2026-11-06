import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { applyVideoSettings, setVideoAudio } from '../navigation/generation-settings.js';
import { attachFrameImages } from '../navigation/reference-images.js';
import { fillPrompt } from '../navigation/prompt-input.js';
import { get } from '../utils/config.js';

const GENERATE_BTN = 'button[type="submit"]:has-text("arrow_forward")';
const DEFAULT_MODEL = 'Veo 3.1 - Lite';
const SHORTHANDS = {
  auto: DEFAULT_MODEL,
  lite: 'Veo 3.1 - Lite',
  fast: 'Veo 3.1 - Fast',
  quality: 'Veo 3.1 - Quality',
  flash: 'Omni 1.1 Flash',
  'Omni Flash': 'Omni 1.1 Flash',
};

/** Resolve a requested model name (or shorthand) to its label in Flow's model menu, or null. */
export function resolveVideoModel(requested) {
  const name = !requested ? DEFAULT_MODEL : SHORTHANDS[requested] || requested;
  return get('videoModels', {})[name] ? name : null;
}

/**
 * Finished video tiles in the project grid → their media token. A tile shows a thumbnail
 * <img> and only swaps in a <video> while hovered; both point at /asb/<token>=<suffix>.
 * Tiles still rendering have neither, so they are not counted yet.
 * Only tiles near the viewport are rendered, which is fine: new generations appear at the top.
 */
async function collectVideoTiles(page) {
  return page.evaluate(() => {
    const tokens = [];
    for (const t of document.querySelectorAll('flow-video-tile')) {
      const src = t.querySelector('video')?.getAttribute('src') || t.querySelector('img')?.getAttribute('src') || '';
      const m = src.match(/\/asb\/([^=?]+)/);
      if (m) tokens.push(m[1]);
    }
    return tokens;
  }).catch(() => []);
}

/** Text of grid tiles showing a failed generation ("Không thành công" / "Failed"), newest first. */
async function failedTiles(page) {
  return page.evaluate(() => [...document.querySelectorAll('flow-grid-tile-container')]
    .map(t => t.innerText.normalize('NFC'))
    .filter(text => /Không thành công|Failed|Échec/i.test(text))).catch(() => []);
}

/** Hover a finished tile so Flow loads its <video>, and return the playable URL. */
async function videoUrlForToken(page, token) {
  const tile = page.locator('flow-video-tile').filter({
    has: page.locator(`img[src*="${token}"], video[src*="${token}"]`),
  }).first();
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.hover();
  const video = tile.locator('video').first();
  await video.waitFor({ state: 'attached', timeout: 15000 });
  const src = await video.getAttribute('src');
  await page.mouse.move(5, 5); // stop the preview
  if (!src?.includes(token)) throw new Error('video URL not found for the new tile');
  return src;
}

async function scrollGridToTop(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
}

/**
 * Image → video in Flow (Video › Frames): start frame (+ optional end frame) + motion prompt.
 * auto_confirm=false (default) only sets everything up and reports the credit cost Flow shows.
 * auto_confirm=true clicks Generate, waits for the video(s) and downloads them as .mp4.
 */
export async function handleGenerateVideo(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt, model: args.model, ratio: args.ratio, duration: args.duration,
    quantity: args.quantity, start_frame: args.start_frame, end_frame: args.end_frame, auto_confirm: autoConfirm,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    const model = resolveVideoModel(args.model);
    if (!model) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${Object.keys(get('videoModels', {})).join(', ')}`);
    }
    const ratio = args.ratio || '9:16';
    if (!get('videoRatios', ['9:16', '16:9']).includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video (9:16 or 16:9)`);
    }
    const duration = parseInt(args.duration, 10) || 8;
    const quantity = Number(args.quantity) || 1;
    if (!(quantity >= 1 && quantity <= 4)) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Quantity must be 1–4');
    const startFrame = args.start_frame || args.reference_images?.[0];
    if (!startFrame) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'start_frame (image path) is required');
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt (the motion description) is required');

    await ensureProjectInContext(page, { name: args.project_name, campaign: args.campaign });

    // Settings → frames → prompt. Each step verifies itself and throws before any credit is spent.
    const ui = await applyVideoSettings(page, { model, ratio, duration, quantity });
    // Audio off by default: generations with audio sometimes fail ("couldn't generate audio")
    const audio = args.audio === true;
    await setVideoAudio(page, audio);
    const frames = await attachFrameImages(page, { start: startFrame, end: args.end_frame });
    await fillPrompt(page, prompt);

    const base = {
      type: 'video', model_used: ui.model, ratio: ui.ratio, duration: ui.duration, quantity: ui.quantity,
      credits: ui.credits, audio, frames, ui_settings: ui.raw, prompt, jobId: job.id,
    };

    if (!autoConfirm) {
      const result = {
        ...base,
        status: 'ready_for_confirmation',
        message: `Ready. Flow says this will cost ${ui.credits} credits. Nothing generated yet.`,
        screenshot: await takeScreenshot(page, 'video-ready-for-confirmation'),
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // Caller-approved budget: refuse if Flow now asks for more than the user agreed to
    if (args.max_credits != null && ui.credits > Number(args.max_credits)) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `Flow asks ${ui.credits} credits, more than the approved ${args.max_credits}. Not generated.`);
    }

    const generateBtn = page.locator(GENERATE_BTN).first();
    if (!(await generateBtn.isVisible().catch(() => false)) || await generateBtn.isDisabled().catch(() => true)) {
      await takeScreenshot(page, 'video-generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not available');
    }

    const outputDir = args.output_folder || prepareDownload('video', model, job.id).dir;
    fs.mkdirSync(outputDir, { recursive: true });

    await scrollGridToTop(page);
    const existing = new Set(await collectVideoTiles(page));
    const failedBefore = (await failedTiles(page)).length;

    logger.info('⚠️ Clicking Generate for video — credits will be consumed', { credits: ui.credits });
    await generateBtn.click();

    const timeoutMs = get('videoGenerationTimeoutMs', 600000);
    const started = Date.now();
    let fresh = [];
    let lastShot = 0;
    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(5000);
      await scrollGridToTop(page);
      fresh = (await collectVideoTiles(page)).filter(t => !existing.has(t));
      const failed = await failedTiles(page);
      if (failed.length > failedBefore && fresh.length < quantity) {
        // Flow shows a "Không thành công / Failed" tile and refunds the credits
        await takeScreenshot(page, 'video-generation-failed');
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
          `Flow báo tạo video không thành công: ${failed[0].replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      if (fresh.length >= quantity) break;
      const elapsed = Date.now() - started;
      if (elapsed - lastShot >= 60000) {
        lastShot = elapsed;
        logger.info('Still waiting for video...', { elapsed, found: fresh.length });
        await takeScreenshot(page, `video-wait-${Math.round(elapsed / 1000)}s`);
      }
    }
    if (fresh.length > quantity) {
      // More new videos than requested: something else generated in this project meanwhile
      // (another app/tab). Can't tell which one is ours — don't guess.
      await takeScreenshot(page, 'video-ambiguous');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `${fresh.length} new videos appeared but ${quantity} was requested — another generation ran at the same time. ` +
        'Download yours from the Flow project.');
    }
    if (!fresh.length) {
      await takeScreenshot(page, 'video-not-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `No new video appeared within ${Math.round(timeoutMs / 60000)} min. Check the Flow project — it may still be rendering.`);
    }

    const files = [];
    let n = 0;
    for (const token of fresh) {
      try {
        const src = await videoUrlForToken(page, token);
        const response = await page.context().request.get(src, { timeout: 120000 });
        const type = response.headers()['content-type'] || '';
        if (!response.ok() || !type.startsWith('video/')) throw new Error(`HTTP ${response.status()} ${type}`);
        n += 1;
        const dest = path.join(outputDir, `video_${path.parse(startFrame).name}_${job.id}${n > 1 ? `_${n}` : ''}.mp4`);
        fs.writeFileSync(dest, await response.body());
        files.push(dest);
        logger.info('Video downloaded', { dest });
      } catch (err) {
        logger.warn('Failed to download video', { error: err.message });
      }
    }
    if (!files.length) {
      await takeScreenshot(page, 'video-download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Video generated but could not be downloaded');
    }

    const result = { ...base, status: 'success', files, video_count: files.length, credits_consumed: true };
    saveMetadata(job.id, { ...result, start_frame: startFrame, end_frame: args.end_frame || null });
    jobQueue.completeJob(job.id, result);
    return result;
  } catch (err) {
    jobQueue.failJob(job.id, err); // first, so a failed screenshot can't leave the job stuck "running"
    try { await takeScreenshot(getPage(), 'generate-video-error'); } catch { /* browser not connected */ }
    throw err;
  }
}
