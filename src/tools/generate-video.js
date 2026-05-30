import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, findNewFiles, saveMetadata } from '../utils/file-manager.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

function selectVideoModel(requested) {
  const available = get('videoModels', {});
  if (!requested || requested === 'auto') {
    return 'Veo 3.1 - Fast';
  }
  // Smart selection
  if (requested === 'quality' || requested === 'premium') return 'Veo 3.1 - Quality';
  if (requested === 'fast' || requested === 'speed') return 'Veo 3.1 - Fast';
  if (requested === 'lite' || requested === 'test') return 'Veo 3.1 - Lite';
  if (requested === 'flash' || requested === 'simple') return 'Omni Flash';
  if (available[requested]) return requested;
  return null;
}

export async function handleGenerateVideo(args) {
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: args.duration || '4s',
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    references: args.references,
    ingredients: args.ingredients,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Navigate to Flow if not there
    const currentUrl = page.url();
    if (!currentUrl.includes('labs.google')) {
      await page.goto(get('flowUrl', 'https://labs.google/fx/tools/flow'), {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
    }

    // Select model
    const model = selectVideoModel(args.model);
    if (!model) {
      const available = Object.keys(get('videoModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using video model', { model });

    // Select Video mode
    logger.info('Selecting Video mode');
    const videoLocator = page.locator('button:has-text("Video"), [role="tab"]:has-text("Video"), text=Video').first();
    if (await videoLocator.isVisible().catch(() => false)) {
      await videoLocator.click();
      await page.waitForTimeout(1000);
    } else {
      logger.warn('Video mode button not found, continuing with current mode');
      await takeScreenshot(page, 'video-mode-check');
    }

    // Model selection dropdown
    try {
      const modelLocator = page.locator('button:has-text("Omni"), button:has-text("Veo"), [class*="model"] button').first();
      if (await modelLocator.isVisible().catch(() => false)) {
        await modelLocator.click();
        await page.waitForTimeout(500);
        const optLocator = page.locator(`text="${model}"`).first();
        if (await optLocator.isVisible().catch(() => false)) {
          await optLocator.click();
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.press('Escape');
        }
      }
    } catch (err) {
      logger.warn('Could not select video model', { error: err.message });
    }

    // Select ratio
    const ratios = get('videoRatios', ['9:16', '16:9']);
    const ratio = args.ratio || '16:9';
    if (!ratios.includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video`);
    }
    try {
      const ratioBtn = page.locator(`button:has-text("${ratio}")`).first();
      if (await ratioBtn.isVisible().catch(() => false)) {
        await ratioBtn.click();
        await page.waitForTimeout(500);
      }
    } catch { /* ok */ }

    // Select duration
    const durations = get('durations', ['4s', '6s', '8s', '10s']);
    const duration = args.duration || '4s';
    if (!durations.includes(duration)) {
      logger.warn('Duration not available, using 4s', { requested: duration });
    }
    try {
      const durBtn = page.locator(`button:has-text("${duration}")`).first();
      if (await durBtn.isVisible().catch(() => false)) {
        await durBtn.click();
        await page.waitForTimeout(500);
      }
    } catch { /* ok */ }

    // Select quantity
    const qty = Math.min(Math.max(args.quantity || 1, 1), 4);
    try {
      const qtyBtn = page.locator(`button:has-text("x${qty}")`).first();
      if (await qtyBtn.isVisible().catch(() => false)) {
        await qtyBtn.click();
        await page.waitForTimeout(500);
      }
    } catch { /* ok */ }

    // Fill prompt
    const promptLocator = page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    const promptInput = await promptLocator.isVisible().catch(() => false) ? promptLocator : null;
    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input-video');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input');
    }
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(args.prompt, { delay: 20 });
    await page.waitForTimeout(500);

    // Generate (video generation is paid - just set up and report)
    logger.info('Video generation setup complete - not clicking generate (paid feature)');
    await takeScreenshot(page, 'video-ready-to-generate');

    // Return setup info without actually generating
    saveMetadata(job.id, {
      type: 'video',
      model,
      ratio,
      duration,
      quantity: qty,
      prompt: args.prompt,
      status: 'ready_for_confirmation',
      note: 'Video generation is a paid feature. Manual confirmation required to proceed.',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'video',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      duration,
      quantity: qty,
      prompt: args.prompt,
      message: 'Video generation setup complete. Clicking Generate will use Flow credits. Manual confirmation required.',
      screenshot: await takeScreenshot(page, 'video-ready'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-video-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
