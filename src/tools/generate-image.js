import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { applyImageSettings } from '../navigation/generation-settings.js';
import { attachReferenceImages, clearReferenceImages } from '../navigation/reference-images.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

// The composer's Generate button (arrow_forward icon). Never use a bare [type="submit"].
const GENERATE_BTN = 'button[type="submit"]:has-text("arrow_forward")';

/**
 * Map of media uuid → image URL for project images currently in the DOM.
 * Flow serves them from flow-content.google/image/<uuid>; older builds used
 * media.getMediaUrlRedirect?name=<uuid>.
 * Reference images attached to the prompt (chips) are excluded — their uploads also
 * show up as project tiles and must never be mistaken for generated output.
 */
async function collectImageSources(page, excludeUuids = []) {
  return page.evaluate(exclude => {
    const uuidOf = src => (src.match(/flow-content\.google\/image\/([a-f0-9-]{36})/) ||
      src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/) || [])[1];
    const skip = new Set(exclude);
    for (const i of document.querySelectorAll('button.chip-container img')) skip.add(uuidOf(i.src || ''));
    const out = {};
    for (const img of document.querySelectorAll('img')) {
      const uuid = uuidOf(img.src || '');
      if (uuid && img.width > 100 && !skip.has(uuid)) out[uuid] = img.src;
    }
    return out;
  }, excludeUuids).catch(() => ({}));
}

/** Media uuids of the reference images currently attached to the prompt. */
async function attachedReferenceUuids(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('button.chip-container img'))
    .map(i => ((i.src || '').match(/\/image\/([a-f0-9-]{36})/) || [])[1]).filter(Boolean)).catch(() => []);
}

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2';
  }
  if (available[requested]) return requested;
  return null;
}

function selectRatio(requested) {
  const ratios = get('ratios', []);
  if (!requested || ratios.includes(requested)) {
    return requested || '1:1'; // matches the tool schema default
  }
  return null;
}

export async function handleGenerateImage(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '1:1',
    auto_confirm: autoConfirm,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    useTool: args.use_tool,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    // STEP 2: Model selection (config-level, before UI interaction)
    const model = selectModel(args.model);
    if (!model) {
      const available = Object.keys(get('imageModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using model', { model });

    // 🛡️ SAFETY: Verify model is an IMAGE model, NOT a video model
    const imageModels = get('imageModels', {});
    const videoModels = get('videoModels', {});
    if (!imageModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 BLOCAGE SÉCURITÉ: "${model}" est un modèle VIDÉO, pas IMAGE. ` +
        `Utiliser flow_generate_video pour les vidéos. Modèles image: ${Object.keys(imageModels).join(', ')}`);
    }
    if (videoModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 BLOCAGE SÉCURITÉ: "${model}" est aussi un modèle VIDÉO. ` +
        `Refus de générer pour éviter des crédits vidéo. Modèles image: ${Object.keys(imageModels).join(', ')}`);
    }

    // STEP 3: Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${get('ratios', []).join(', ')}`);
    }

    const quantity = Number(args.quantity) || 1;
    if (!get('quantities', [1, 2, 3, 4]).includes(quantity)) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `Quantity ${quantity} not available. Available: ${get('quantities', [1, 2, 3, 4]).join(', ')}`);
    }

    // STEP 4: Set Image mode + model + ratio + quantity in the settings panel,
    // then verify via the composer chip. Throws (no generation) on any mismatch.
    const uiSettings = await applyImageSettings(page, { model, ratio, quantity });

    // STEP 4b: Attach reference images (product / character) as prompt ingredients.
    // Always clear leftovers so a previous job's references don't leak into this one.
    const referenceImages = args.reference_images || args.references || [];
    const referenceCount = referenceImages.length
      ? await attachReferenceImages(page, referenceImages)
      : (await clearReferenceImages(page), 0);

    // STEP 5: Find the prompt input (contenteditable div at bottom toolbar)
    let promptInput = null;

    const promptCandidates = [
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        logger.info('Found prompt input on page');
        break;
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Expected [contenteditable] or textarea.'
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // STEP 6: Fill the prompt
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    // Insert in one go: typing char-by-char exceeds the 30s action timeout on long ad prompts
    await page.keyboard.insertText(args.prompt);
    await page.waitForTimeout(500);
    const typed = ((await promptInput.textContent()) || '').replace(/\s+/g, ' ').trim();
    if (typed !== args.prompt.replace(/\s+/g, ' ').trim()) {
      await takeScreenshot(page, 'prompt-mismatch');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        `Prompt in Flow doesn't match what was sent (${typed.length}/${args.prompt.length} chars). Generation aborted.`);
    }
    logger.info('Prompt filled', { promptLength: args.prompt.length });

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: '✅ Prompt, modèle et ratio sont prêts. Aucun crédit consommé. ' +
          'Pour générer et consommer des crédits, rappelle avec auto_confirm=true.',
        model_used: uiSettings.model,
        ratio: uiSettings.ratio,
        quantity: uiSettings.quantity,
        ui_settings: uiSettings.raw,
        reference_images: referenceCount,
        prompt: args.prompt,
        account: get('expectedAccount'),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // 🛡️ SAFETY: Pre-generation screenshot verification
    logger.info('⚠️ auto_confirm=true — vérifications de sécurité avant clic Generate');
    const preGenScreenshot = await takeScreenshot(page, 'pre-generate-verification');

    // STEP 8: Find generate button
    const generateBtnLocator = page.locator(GENERATE_BTN).first();
    const generateBtnVisible = await generateBtnLocator.isVisible().catch(() => false);
    if (!generateBtnVisible) {
      await takeScreenshot(page, 'no-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
    }

    const isDisabled = await generateBtnLocator.isDisabled().catch(() => false);
    if (isDisabled) {
      await takeScreenshot(page, 'generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }

    // STEP 9: Prepare output directory
    const outputDir = args.output_folder || prepareDownload('image', model, job.id).dir;
    if (args.output_folder) {
      if (!fs.existsSync(args.output_folder)) {
        fs.mkdirSync(args.output_folder, { recursive: true });
      }
    }

    // Snapshot right before Generate — after reference uploads — so only images
    // produced by THIS click count as output.
    // Reference uuids are remembered too: Flow may clear the chips after Generate.
    const referenceUuids = await attachedReferenceUuids(page);
    const existingImages = await collectImageSources(page, referenceUuids);
    if (referenceUuids.length !== referenceCount) {
      // Without every reference id we can't tell uploads from generated output → stop before spending credits
      await takeScreenshot(page, 'reference-ids-missing');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        `Could not read the ids of all reference images (${referenceUuids.length}/${referenceCount}). ` +
        'Generation aborted before clicking Generate — no credits used.');
    }

    // STEP 10: Click generate ⚠️ CRÉDITS SERONT CONSOMMÉS
    logger.info('⚠️⚠️⚠️ Cliquant Generate — des crédits vont être consommés');
    await generateBtnLocator.click();

    // STEP 11: Handle two possible generation flows:
    //   A) Agent-mediated: Agent asks "Accepter?" before generating (when switching modes)
    //   B) Direct: generation starts immediately (most common)
    // Try Agent first (short wait), fall through to direct if not detected

    let flowMode = 'direct';
    logger.info('Checking for Agent confirmation dialog (5s window)...');
    const acceptTimeoutMs = get('agentResponseTimeoutMs', 5000);
    const acceptStart = Date.now();

    while (Date.now() - acceptStart < acceptTimeoutMs) {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes('Accepter') || pageText.includes('Approve')) {
        logger.info('Agent confirmation dialog detected — switching to Agent flow');
        const acceptBtn = page.locator('button').filter({ hasText: /Accepter|Approve/ }).first();
        await acceptBtn.click();
        logger.info('Generation confirmed via Agent');
        flowMode = 'agent';
        break;
      }
      await page.waitForTimeout(500);
    }

    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for NEW images (not present before this job) to appear in the DOM
    logger.info('Waiting for generated images...', { expected: quantity });
    let newImages = {};
    const genTimeoutMs = get('generationTimeoutMs', 120000);
    const genStart = Date.now();
    let lastWaitShot = 0;

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(2000);

      const current = await collectImageSources(page, referenceUuids);
      newImages = Object.fromEntries(
        Object.entries(current).filter(([uuid]) => !(uuid in existingImages))
      );
      if (Object.keys(newImages).length >= quantity) {
        logger.info('Generated images detected in DOM', { count: Object.keys(newImages).length });
        break;
      }

      const elapsed = Date.now() - genStart;
      if (elapsed - lastWaitShot >= 30000) {
        lastWaitShot = elapsed;
        logger.info('Still waiting for images...', { elapsed, found: Object.keys(newImages).length });
        await takeScreenshot(page, `gen-wait-${Math.round(elapsed / 1000)}s`);
      }
    }

    const generatedImageUuids = Object.keys(newImages);

    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }

    // STEP 13: Download generated images via authenticated session
    logger.info('Downloading generated images', { count: generatedImageUuids.length });
    const downloadedFiles = [];

    for (const uuid of generatedImageUuids) {
      try {
        // Fetch through the browser context (shares the signed-in cookies) without
        // navigating the page away from the project.
        const response = await page.context().request.get(newImages[uuid], { timeout: 30000 });

        if (response.ok()) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.startsWith('image/')) {
            const buffer = await response.body();
            const ext = contentType === 'image/png' ? '.png' : '.jpg';
            const destPath = path.join(outputDir, `flow_${uuid.substring(0, 8)}_${job.id}${ext}`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            logger.info('Image downloaded', { uuid, size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Failed to download image', { uuid, error: err.message });
      }
    }

    if (downloadedFiles.length === 0) {
      await takeScreenshot(page, 'download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Failed to download any generated images via the authenticated session');
    }

    saveMetadata(job.id, {
      type: 'image',
      model: uiSettings.model,
      ratio: uiSettings.ratio,
      auto_confirm: true,
      quantity: uiSettings.quantity,
      reference_images: referenceImages,
      prompt: args.prompt,
      files: downloadedFiles,
      jobId: job.id,
      imageUuids: generatedImageUuids,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: uiSettings.model,
      ratio: uiSettings.ratio,
      quantity: uiSettings.quantity,
      reference_images: referenceCount,
      prompt: args.prompt,
      files: downloadedFiles,
      image_count: downloadedFiles.length,
      credits_consumed: true,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    jobQueue.failJob(job.id, err); // first, so a failed screenshot can't leave the job stuck "running"
    try { await takeScreenshot(getPage(), 'generate-image-error'); } catch { /* browser not connected */ }
    throw err;
  }
}
