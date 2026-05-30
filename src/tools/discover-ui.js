import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import fs from 'fs';
import path from 'path';
import { getFlowHome } from '../utils/config.js';

const SELECTORS_PATH = path.join(getFlowHome(), 'config', 'selectors.map.json');

function loadSelectors() {
  try {
    return JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf-8'));
  } catch {
    return {
      _description: 'UI selectors map for Google Flow',
      _lastUpdated: null,
      main: { url: null, selectors: {} },
      imageGeneration: { selectors: {} },
      videoGeneration: { selectors: {} },
      characters: { url: null, selectors: {} },
      scenes: { url: null, selectors: {} },
      toolsGallery: { url: null, selectors: {} },
      gridArchitect: { url: null, selectors: {} },
    };
  }
}

function saveSelectors(map) {
  map._lastUpdated = new Date().toISOString();
  fs.writeFileSync(SELECTORS_PATH, JSON.stringify(map, null, 2));
  logger.info('Selectors map saved');
}

const PAGES = {
  main: 'https://labs.google/fx/tools/flow',
  characters: 'https://labs.google/fx/tools/flow/characters',
  scenes: 'https://labs.google/fx/tools/flow/scenes',
  toolsGallery: 'https://labs.google/fx/tools/flow/tools?tab=GALLERY',
  gridArchitect: 'https://labs.google/fx/tools/flow/tools/grid-architect',
  imageGeneration: 'https://labs.google/fx/tools/flow',
  videoGeneration: 'https://labs.google/fx/tools/flow',
};

const PAGE_SELECTOR_KEYS = {
  main: 'main',
  characters: 'characters',
  scenes: 'scenes',
  'tools-gallery': 'toolsGallery',
  'tools gallery': 'toolsGallery',
  grid: 'gridArchitect',
  'grid-architect': 'gridArchitect',
  image: 'imageGeneration',
  video: 'videoGeneration',
};

function getPageKey(pageName) {
  const lower = (pageName || '').toLowerCase().trim();
  return PAGE_SELECTOR_KEYS[lower] || lower;
}

export async function handleDiscoverUi(args) {
  let page = getPage();
  const pageName = args.page || 'main';
  const pageKey = getPageKey(pageName);
  const url = args.url || PAGES[pageKey] || PAGES.main;

  logger.info('Discovering UI', { page: pageName, pageKey, url: url?.substring(0, 80) });

  try {
    // Navigate to the page
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const title = await page.title();

    // Take full page screenshot
    const screenshotPath = await takeScreenshot(page, `discover-${pageName}`);

    // Extract visible text content
    const visibleText = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const texts = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          texts.push(text);
        }
      }
      return [...new Set(texts)].slice(0, 200);
    });

    // Detect all interactive elements
    const elements = await detectPageElements();

    // Extract specifically model-related text
    const modelNames = visibleText.filter(t =>
      t.includes('Nano') || t.includes('Imagen') || t.includes('Veo') || t.includes('Omni') ||
      t.includes('Model') || t.includes('Modèle')
    );

    // Extract ratio-related text
    const ratioTexts = visibleText.filter(t =>
      t.includes(':') && (t.includes('9') || t.includes('4') || t.includes('3') || t.includes('1'))
    );

    // Update selectors map
    const selectorsMap = loadSelectors();
    selectorsMap[pageKey] = {
      url: currentUrl,
      title,
      discoveredAt: new Date().toISOString(),
      selectors: {
        buttons: elements.buttons,
        inputs: elements.inputs,
        links: elements.links,
        headings: elements.headings,
        modelTexts: modelNames,
        ratioTexts: ratioTexts,
      },
    };
    saveSelectors(selectorsMap);

    return {
      status: 'discovered',
      page: pageName,
      pageKey,
      url: currentUrl,
      title,
      screenshot: screenshotPath,
      elements: {
        buttons: elements.buttons.map(b => b.text).filter(Boolean),
        inputs: elements.inputs.map(i => i.placeholder || i.ariaLabel || i.name).filter(Boolean),
        headings: elements.headings.map(h => `${h.level}: ${h.text}`),
        visible_models: modelNames,
        visible_ratios: ratioTexts,
      },
      totalButtonsFound: elements.buttons.length,
      totalInputsFound: elements.inputs.length,
    };
  } catch (err) {
    await takeScreenshot(page, `discover-error-${pageName}`);
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `UI discovery failed for ${pageName}: ${err.message}`
    );
  }
}
