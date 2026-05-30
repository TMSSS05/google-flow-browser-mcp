import path from 'path';
import fs from 'fs';
import { getFlowHome } from './config.js';
import { logger } from './logger.js';

const SCREENSHOT_DIR = path.join(getFlowHome(), 'screenshots-debug');

function ensureDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

export async function takeScreenshot(page, name) {
  try {
    ensureDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${name}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    logger.info('Screenshot saved', { name, path: filepath });
    return filepath;
  } catch (err) {
    logger.warn('Failed to take screenshot', { name, error: err.message });
    return null;
  }
}

export function getLatestScreenshot(namePattern) {
  if (!fs.existsSync(SCREENSHOT_DIR)) return null;
  const files = fs.readdirSync(SCREENSHOT_DIR)
    .filter(f => f.includes(namePattern))
    .map(f => path.join(SCREENSHOT_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}
