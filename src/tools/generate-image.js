import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { prepareDownload, findNewFiles, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar, registerTaskInProject } from '../navigation/project-navigator.js';
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
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
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

    // STEP 3: Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${get('ratios', []).join(', ')}`);
    }

    // STEP 4: Try to find the image generation UI
    // First take a snapshot to understand what we're looking at
    const elements = await detectPageElements(page);
    logger.info('Page elements detected in project', {
      buttons: elements.buttons.length,
      inputs: elements.inputs.length,
    });

    // Check if we can find a prompt textarea/input directly
    let promptInput = null;

    // Strategy A: Look for a visible textarea or contenteditable div
    const promptCandidates = [
      page.locator('textarea:visible, [contenteditable="true"]:visible').first(),
      page.locator('textarea').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('input[type="text"]:visible').first(),
    ];

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        logger.info('Found prompt input on page');
        break;
      }
    }

    // Strategy B: If no prompt found, try navigating sidebar to find the right section
    if (!promptInput) {
      logger.info('No prompt input found on current view, trying sidebar navigation');
      await navigateToSidebar(page, 'Outils');
      await page.waitForTimeout(2000);

      // Check again for prompt input
      for (const candidate of [
        page.locator('textarea:visible, [contenteditable="true"]:visible').first(),
        page.locator('textarea').first(),
        page.locator('[contenteditable="true"]').first(),
        page.locator('input[type="text"]:visible').first(),
      ]) {
        if (await candidate.isVisible().catch(() => false)) {
          promptInput = candidate;
          logger.info('Found prompt input after sidebar navigation');
          break;
        }
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      // Report available elements to help debugging
      const inputDetails = elements.inputs.map(i =>
        i.placeholder || i.ariaLabel || i.name || 'unnamed'
      ).filter(Boolean);
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Available inputs: ' +
        (inputDetails.length ? inputDetails.join(', ') : 'none detected'),
      );
    }

    // STEP 5: Select model in UI if a model dropdown is visible
    try {
      const modelDropdown = page.locator(
        'button:has-text("Nano Banana"), [class*="model"] button, text=/Nano Banana|Imagen/'
      ).first();
      if (await modelDropdown.isVisible().catch(() => false)) {
        await modelDropdown.click();
        await page.waitForTimeout(500);
        const modelOption = page.locator(`text="${model}"`).first();
        if (await modelOption.isVisible().catch(() => false)) {
          await modelOption.click();
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.press('Escape');
        }
      }
    } catch (err) {
      logger.warn('Could not select model in UI, using default', { error: err.message });
    }

    // STEP 6: Select ratio in UI
    try {
      const ratioBtn = page.locator(
        `button:has-text("${ratio}"), [class*="aspect"] button, text="${ratio}"`
      ).first();
      if (await ratioBtn.isVisible().catch(() => false)) {
        await ratioBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (err) {
      logger.warn('Could not select ratio, using default', { error: err.message });
    }

    // STEP 7: Select quantity
    const qty = Math.min(Math.max(args.quantity || 1, 1), 4);
    try {
      const qtyBtn = page.locator(
        `button:has-text("x${qty}"), [class*="quantity"] button`
      ).first();
      if (await qtyBtn.isVisible().catch(() => false)) {
        await qtyBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (err) {
      logger.warn('Could not select quantity, using default', { error: err.message });
    }

    // STEP 8: Fill the prompt
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(args.prompt, { delay: 20 });
    logger.info('Prompt filled', { promptLength: args.prompt.length });
    await page.waitForTimeout(500);

    // STEP 9: Click Generate
    const generateBtnLocator = page.locator(
      'button:has-text("Generate"), button:has-text("Créer"), [type="submit"]'
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

    // STEP 10: Prepare output directory
    const outputDir = args.output_folder || prepareDownload('image', model, job.id).dir;
    if (args.output_folder) {
      if (!fs.existsSync(args.output_folder)) {
        fs.mkdirSync(args.output_folder, { recursive: true });
      }
    }
    const beforeTime = Date.now();

    // STEP 11: Set up download listener
    const downloadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new FlowError(ErrorCodes.GENERATION_TIMEOUT,
          'Generation timed out waiting for download'));
      }, get('jobTimeoutMs', 300000));

      page.on('download', async (download) => {
        try {
          const destPath = path.join(outputDir, `flow_${Date.now()}_${model}_image_${job.id}.png`);
          await download.saveAs(destPath);
          clearTimeout(timeout);
          resolve([destPath]);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    // STEP 12: Click generate
    logger.info('Clicking Generate');
    await generateBtnLocator.click();

    // STEP 13: Wait for completion
    let files = [];
    try {
      files = await downloadPromise;
    } catch (err) {
      logger.info('Waiting for generation to complete via UI');
      await page.waitForTimeout(5000);

      let attempts = 0;
      const maxAttempts = get('maxPollAttempts', 120);
      while (attempts < maxAttempts) {
        await page.waitForTimeout(get('generationPollIntervalMs', 5000));
        attempts++;

        const doneLocator = page.locator(
          'text=Download, text=Télécharger, [aria-label*="download"], button:has-text("Download")'
        ).first();
        if (await doneLocator.isVisible().catch(() => false)) {
          logger.info('Generation complete, downloading');
          await doneLocator.click();
          await page.waitForTimeout(3000);
          break;
        }

        const captchaLocator = page.locator(
          'text=captcha, text=verify, text=vérification, iframe[src*="captcha"]'
        ).first();
        if (await captchaLocator.isVisible().catch(() => false)) {
          jobQueue.setManualAction(job.id);
          await takeScreenshot(page, 'captcha-detected');
          throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
            'Captcha or verification required. Manual intervention needed.');
        }

        if (attempts % 20 === 0) {
          logger.info('Still generating...', { attempts, jobId: job.id });
          await takeScreenshot(page, `generating-progress-${attempts}`);
        }
      }

      if (attempts >= maxAttempts) {
        throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
          `Generation did not complete within ${maxAttempts * 5} seconds`);
      }

      const newFiles = findNewFiles(outputDir, beforeTime);
      files = newFiles;
    }

    if (!files || files.length === 0) {
      await takeScreenshot(page, 'no-files-after-gen');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'No files were downloaded after generation');
    }

    // STEP 14: Save metadata
    saveMetadata(job.id, {
      type: 'image',
      model,
      ratio,
      quantity: qty,
      prompt: args.prompt,
      files,
      jobId: job.id,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      quantity: qty,
      prompt: args.prompt,
      files,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
