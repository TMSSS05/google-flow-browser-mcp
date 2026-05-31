import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

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
    return requested || '16:9';
  }
  return null;
}

export async function handleGenerateImage(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
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

    // STEP 4: Verify the model selector confirms IMAGE mode (NOT video)
    // Flow's bottom toolbar is always present in a project with a model selector.
    // No "Image/Video" mode tabs exist — the generation mode is determined by
    // which model is selected (e.g. "Nano Banana 2" = image, "Omni Flash" = video).
    const modelFromUI = await page.evaluate(() => {
      const modelBtn = Array.from(document.querySelectorAll('button'))
        .find(b => {
          const text = b.textContent || '';
          return (text.includes('Nano') || text.includes('Banana') ||
                  text.includes('Omni') || text.includes('Veo') ||
                  text.includes('Imagen')) && b.offsetParent !== null;
        });
      return modelBtn ? modelBtn.textContent.trim().replace(/\s+/g, ' ').substring(0, 80) : null;
    }).catch(() => null);

    if (modelFromUI) {
      logger.info('Model selector shows:', { modelFromUI });
      const videoModelNames = ['Omni Flash', 'Veo', 'Omni'];
      const isVideoModel = videoModelNames.some(v => modelFromUI.includes(v));
      if (isVideoModel) {
        await takeScreenshot(page, 'video-model-detected');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `🚨 BLOCAGE SÉCURITÉ: Le modèle "${modelFromUI}" est un modèle VIDÉO. ` +
          `Refus de générer pour éviter des crédits vidéo payants. ` +
          `Utilise flow_generate_video pour les vidéos.`);
      }
      logger.info('✅ Model selector confirms image mode');
    } else {
      logger.warn('Could not read model selector — assuming image mode from config');
    }

    // Also verify the generate button exists (confirms the toolbar is active)
    const hasGenerateBtn = await page.locator(
      'button:has-text("arrow_forward"), button:has-text("Créer")'
    ).first().isVisible().catch(() => false);
    if (!hasGenerateBtn) {
      logger.warn('Generate button not visible on project page');
    }

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
    await promptInput.type(args.prompt, { delay: 15 });
    logger.info('Prompt filled', { promptLength: args.prompt.length });
    await page.waitForTimeout(500);

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: '✅ Prompt, modèle et ratio sont prêts. Aucun crédit consommé. ' +
          'Pour générer et consommer des crédits, rappelle avec auto_confirm=true.',
        model_used: model,
        ratio,
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
    const generateBtnLocator = page.locator(
      'button:has-text("arrow_forward"), ' +
      'button:has-text("Generate")'
    ).first();
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

    // STEP 12: Wait for images to appear in the DOM
    logger.info('Waiting for generated images...');
    let generatedImageUuids = [];
    const genTimeoutMs = get('generationTimeoutMs', 120000);
    const genStart = Date.now();

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(2000);

      const imageUuids = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const uuids = [];
        imgs.forEach(img => {
          const src = img.src || '';
          const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
          if (match && img.width > 100) {
            uuids.push(match[1]);
          }
        });
        return [...new Set(uuids)];
      });

      if (imageUuids.length > 0) {
        generatedImageUuids = imageUuids;
        logger.info('Generated images detected in DOM', { count: imageUuids.length });
        break;
      }

      const hasDownload = await page.locator(
        'text=Télécharger, text=download, [aria-label*="download"]'
      ).first().isVisible().catch(() => false);
      if (hasDownload) {
        logger.info('Download button appeared after generation');
        break;
      }

      if ((Date.now() - genStart) % 30000 === 0) {
        logger.info('Still waiting for images...', { elapsed: Date.now() - genStart });
        await takeScreenshot(page, `gen-wait-${Math.round((Date.now() - genStart) / 1000)}s`);
      }
    }

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
        const response = await page.goto(
          `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`,
          { waitUntil: 'load', timeout: 15000 }
        );

        if (response && response.ok()) {
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
      model,
      ratio,
      auto_confirm: true,
      quantity: args.quantity || 1,
      prompt: args.prompt,
      files: downloadedFiles,
      jobId: job.id,
      imageUuids: generatedImageUuids,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      prompt: args.prompt,
      files: downloadedFiles,
      image_count: downloadedFiles.length,
      credits_consumed: true,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
