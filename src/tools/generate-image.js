import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { prepareDownload, findNewFiles, saveMetadata } from '../utils/file-manager.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') {
    // Smart default based on content
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
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // 1. Verify we're on Flow
    const currentUrl = page.url();
    if (!currentUrl.includes('labs.google')) {
      await page.goto(get('flowUrl', 'https://labs.google/fx/tools/flow'), {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
    }

    // 2. Model selection
    const model = selectModel(args.model);
    if (!model) {
      const available = Object.keys(get('imageModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using model', { model });

    // 3. Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${get('ratios', []).join(', ')}`);
    }

    // 4. Select Image mode
    logger.info('Selecting Image mode');
    const imageModeBtn = await page.locator('button:has-text("Image"), [role="tab"]:has-text("Image"), [data-testid*="image"], text=Image').first().isVisible().catch(() => false);
    if (imageModeBtn) {
      await page.locator('button:has-text("Image"), [role="tab"]:has-text("Image"), [data-testid*="image"], text=Image').first().click();
      await page.waitForTimeout(1000);
    } else {
      logger.warn('Image mode button not found, may already be in image mode');
      await takeScreenshot(page, 'image-mode-check');
    }

    // 5. Try to select model dropdown if visible
    try {
      const modelVisible = await page.locator('button:has-text("Nano Banana"), [class*="model"] button, text=/Nano Banana|Imagen/').first().isVisible().catch(() => false);
      if (modelVisible) {
        await page.locator('button:has-text("Nano Banana"), [class*="model"] button, text=/Nano Banana|Imagen/').first().click();
        await page.waitForTimeout(500);
        const modelOption = await page.locator(`text="${model}"`).first().isVisible().catch(() => false);
        if (modelOption) {
          await page.locator(`text="${model}"`).first().click();
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.press('Escape');
        }
      }
    } catch (err) {
      logger.warn('Could not select model, using default', { error: err.message });
    }

    // 6. Select ratio
    try {
      const ratioVisible = await page.locator(`button:has-text("${ratio}"), [class*="aspect"] button, text="${ratio}"`).first().isVisible().catch(() => false);
      if (ratioVisible) {
        await page.locator(`button:has-text("${ratio}"), [class*="aspect"] button, text="${ratio}"`).first().click();
        await page.waitForTimeout(500);
      }
    } catch (err) {
      logger.warn('Could not select ratio, using default', { error: err.message });
    }

    // 7. Select quantity
    const qty = Math.min(Math.max(args.quantity || 1, 1), 4);
    try {
      const qtyVisible = await page.locator(`button:has-text("x${qty}"), [class*="quantity"] button`).first().isVisible().catch(() => false);
      if (qtyVisible) {
        await page.locator(`button:has-text("x${qty}"), [class*="quantity"] button`).first().click();
        await page.waitForTimeout(500);
      }
    } catch (err) {
      logger.warn('Could not select quantity, using default', { error: err.message });
    }

    // 8. Fill the prompt
    const promptInputLocator = page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    const promptInput = await promptInputLocator.isVisible().catch(() => false) ? promptInputLocator : null;
    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input field');
    }

    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(args.prompt, { delay: 20 });
    logger.info('Prompt filled', { promptLength: args.prompt.length });

    await page.waitForTimeout(500);

    // 9. Click Generate
    const generateBtnLocator = page.locator('button:has-text("Generate"), button:has-text("Créer"), [type="submit"]').first();
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

    // Record time before download
    const outputDir = args.output_folder || prepareDownload('image', model, job.id).dir;
    if (args.output_folder) {
      if (!fs.existsSync(args.output_folder)) {
        fs.mkdirSync(args.output_folder, { recursive: true });
      }
    }
    const beforeTime = Date.now();

    // Check for download path setup
    // Playwright downloads can be handled via page.on('download')
    const downloadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'Generation timed out waiting for download'));
      }, get('jobTimeoutMs', 300000));

      page.on('download', async (download) => {
        try {
          const suggestedName = download.suggestedFilename();
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

    // Click generate
    logger.info('Clicking Generate');
    await generateBtnLocator.click();

    // Wait for either download or UI completion
    let files = [];
    try {
      files = await downloadPromise;
    } catch (err) {
      // If download event didn't fire, wait for UI to show completion
      logger.info('Waiting for generation to complete via UI');
      await page.waitForTimeout(5000);

      // Poll for completion
      let attempts = 0;
      const maxAttempts = get('maxPollAttempts', 120);
      while (attempts < maxAttempts) {
        await page.waitForTimeout(get('generationPollIntervalMs', 5000));
        attempts++;

        // Check for completion indicators
        const doneLocator = page.locator('text=Download, text=Télécharger, [aria-label*="download"], button:has-text("Download")').first();
        if (await doneLocator.isVisible().catch(() => false)) {
          logger.info('Generation complete, downloading');
          await doneLocator.click();
          await page.waitForTimeout(3000);
          break;
        }

        // Check for manual action required (captcha, etc.)
        const captchaLocator = page.locator('text=captcha, text=verify, text=vérification, iframe[src*="captcha"]').first();
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

      // Now try to find downloaded files
      const newFiles = findNewFiles(outputDir, beforeTime);
      files = newFiles;
    }

    if (!files || files.length === 0) {
      await takeScreenshot(page, 'no-files-after-gen');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'No files were downloaded after generation');
    }

    // Save metadata
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
