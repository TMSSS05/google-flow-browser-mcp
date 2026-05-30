import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, safeClick, safeFill } from '../browser/safe-actions.js';
import { saveMetadata, prepareDownload } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

export async function handleUseGridArchitect(args) {
  const job = jobQueue.createJob('grid_architect', args);

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    const toolUrl = 'https://labs.google/fx/tools/flow/tools/grid-architect';
    await page.goto(toolUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    await takeScreenshot(page, 'grid-architect-loaded');

    // Detect all UI elements first
    const elements = await detectPageElements();

    // Set engine if specified
    if (args.engine) {
      try {
        const engineLocator = page.locator(`button:has-text("${args.engine}")`).first();
        if (await engineLocator.isVisible().catch(() => false)) {
          await engineLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    // Set ratio if specified
    if (args.ratio) {
      try {
        const ratioLocator = page.locator(`button:has-text("${args.ratio}")`).first();
        if (await ratioLocator.isVisible().catch(() => false)) {
          await ratioLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    // Set visual logic
    if (args.visual_logic) {
      try {
        const vlLocator = page.locator(`button:has-text("${args.visual_logic}")`).first();
        if (await vlLocator.isVisible().catch(() => false)) {
          await vlLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    // Fill theme prompt
    if (args.theme_prompt) {
      const themeLocator = page.locator('textarea, [contenteditable="true"]').first();
      if (await themeLocator.isVisible().catch(() => false)) {
        await themeLocator.click();
        await themeLocator.fill('');
        await page.waitForTimeout(200);
        await themeLocator.type(args.theme_prompt, { delay: 15 });
        await page.waitForTimeout(500);
      }
    }

    // Fill shot prompts if provided
    if (args.shot_prompts && Array.isArray(args.shot_prompts)) {
      for (let i = 0; i < args.shot_prompts.length; i++) {
        const shotLabel = `Shot ${i + 1}`;
        const shotLocator = page.locator(`text="${shotLabel}"`).first();
        // Find nearest textarea sibling/ancestor
        const shotInput = await shotLocator.isVisible().catch(() => false) ? shotLocator : null;
        if (shotInput) {
          // Try clicking near the shot label and then find closest textarea
          await shotInput.click();
          await page.waitForTimeout(200);
          const nearestTextarea = page.locator('textarea').first();
          if (await nearestTextarea.isVisible().catch(() => false)) {
            await nearestTextarea.fill('');
            await page.waitForTimeout(200);
            await nearestTextarea.type(args.shot_prompts[i], { delay: 15 });
            await page.waitForTimeout(500);
          }
        }
      }
    }

    // Upload references
    if (args.references && Array.isArray(args.references)) {
      for (const ref of args.references) {
        try {
          const fileLocator = page.locator('input[type="file"]').first();
          if (fs.existsSync(ref)) {
            await fileLocator.setInputFiles(ref).catch(() => {});
            await page.waitForTimeout(2000);
          }
        } catch { /* ok */ }
      }
    }

    await takeScreenshot(page, 'grid-architect-ready');

    saveMetadata(job.id, {
      type: 'grid_architect',
      engine: args.engine,
      ratio: args.ratio,
      themePrompt: args.theme_prompt,
      shotCount: args.shot_prompts?.length || 0,
      status: 'ready_for_confirmation',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'grid_architect',
      engine: args.engine || 'Nano Banana 2',
      ratio: args.ratio || '16:9',
      elements_detected: {
        buttons: elements.buttons.map(b => b.text),
        inputs: elements.inputs,
      },
      message: 'Grid Architect setup complete. Manual confirmation needed to generate (uses credits).',
      screenshot: await takeScreenshot(page, 'grid-architect-ready'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'grid-architect-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
