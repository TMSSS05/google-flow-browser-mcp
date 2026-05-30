import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';

const ACTION_DELAY = get('actionDelayMs', 800);

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe click with pre- and post-delay
 */
export async function safeClick(selector, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  await element.click();
  await delay(postDelay);
  logger.debug('Clicked element', { selector });
}

/**
 * Safe fill input
 */
export async function safeFill(selector, text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  if (!element) {
    throw new Error(`Input not found: ${selector}`);
  }
  await element.click();
  await element.fill('');
  await delay(200);
  await element.type(text, { delay: 30 });
  await delay(postDelay);
  logger.debug('Filled input', { selector, textLength: text.length });
}

/**
 * Safe press keyboard key
 */
export async function safePress(key, options = {}) {
  const page = getPage();
  const preDelay = options.preDelay || ACTION_DELAY;
  await delay(preDelay);
  await page.keyboard.press(key);
  await delay(ACTION_DELAY);
}

/**
 * Wait for text to appear on page
 */
export async function waitForText(text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 15000;
  try {
    await page.waitForSelector(`text=${text}`, { timeout });
    logger.debug('Text found on page', { text });
    return true;
  } catch {
    logger.warn('Text not found on page', { text });
    return false;
  }
}

/**
 * Navigate and wait for load
 */
export async function safeGoto(url, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 30000;
  const preDelay = options.preDelay || 500;

  await delay(preDelay);
  logger.info('Navigating', { url: url.substring(0, 80) });
  await page.goto(url, { waitUntil: 'networkidle', timeout });
  await delay(ACTION_DELAY);
}

/**
 * Get visible text of all elements matching selector
 */
export async function getVisibleTexts(selector) {
  const page = getPage();
  const elements = await page.$$(selector);
  const texts = [];
  for (const el of elements) {
    if (await el.isVisible()) {
      const text = await el.textContent();
      if (text && text.trim()) texts.push(text.trim());
    }
  }
  return texts;
}

/**
 * Detect all buttons, inputs, and interactive elements on the page
 */
export async function detectPageElements() {
  const page = getPage();
  const elements = await page.evaluate(() => {
    const result = {
      buttons: [],
      inputs: [],
      links: [],
      dropdowns: [],
      headings: [],
      labels: [],
    };

    document.querySelectorAll('button, [role="button"], [type="button"]').forEach(el => {
      const text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
      if (text && text.length < 100) {
        result.buttons.push({
          text: text.substring(0, 80),
          visible: !!el.offsetParent,
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || null,
          dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || null,
        });
      }
    });

    document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]').forEach(el => {
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      result.inputs.push({
        placeholder: placeholder.substring(0, 60),
        ariaLabel: ariaLabel.substring(0, 60),
        name: name.substring(0, 60),
        type: el.getAttribute('type') || el.tagName,
        visible: !!el.offsetParent,
      });
    });

    document.querySelectorAll('a[href]').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text && text.length < 80) {
        result.links.push({
          text: text.substring(0, 60),
          href: (el.getAttribute('href') || '').substring(0, 100),
          visible: !!el.offsetParent,
        });
      }
    });

    document.querySelectorAll('select, [role="listbox"]').forEach(el => {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
      result.dropdowns.push({
        label: label.substring(0, 60),
        visible: !!el.offsetParent,
      });
    });

    document.querySelectorAll('h1, h2, h3, h4').forEach(el => {
      result.headings.push({
        level: el.tagName,
        text: (el.textContent?.trim() || '').substring(0, 80),
      });
    });

    return result;
  });

  return elements;
}
