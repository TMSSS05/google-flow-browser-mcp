import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import fs from 'fs';
import path from 'path';

const PROJECTS_FILE = path.resolve(get('flowHome', '.'), 'config', 'flow.projects.json');

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn('Could not load projects file', { error: e.message });
  }
  return { projects: [] };
}

function saveProjects(data) {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

/**
 * List existing projects visible on the Flow homepage by scanning project cards.
 * Returns array of { name, url, fullText }.
 */
export async function listExistingProjects(page) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/fr/tools/flow');

  // Navigate to the main Flow page if we're not there, or if we're INSIDE a project
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  logger.info('Scanning for existing projects...');

  // Try to find project cards — they have edit/delete action buttons
  const projects = await page.evaluate(() => {
    const result = [];
    // Look for elements that contain Modifier/Supprimer buttons (project cards)
    const allCards = document.querySelectorAll(
      '[class*="card"], [class*="project"], li, article, [class*="grid"] > div'
    );
    allCards.forEach(card => {
      const text = (card.textContent || '').trim();
      const hasEditDelete = text.includes('Modifier') || text.includes('Supprimer');
      if (hasEditDelete && text.length > 5 && text.length < 500) {
        // Extract project name (anything that's not edit/delete button text)
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const nameLines = lines.filter(l =>
          !l.includes('Modifier') && !l.includes('Supprimer') &&
          !l.includes('edit') && !l.includes('delete') &&
          l.length > 1
        );
        result.push({
          name: nameLines.join(' | ') || 'Projet sans nom',
          fullText: text.substring(0, 300),
        });
      }
    });
    return result;
  });

  logger.info('Existing projects found', { count: projects.length });
  return projects;
}

/**
 * Create a new project: click "Nouveau projet", optionally name it,
 * wait for the project page to load, store in local registry.
 * Returns { url, id, name }.
 */
export async function createNewProject(page, name) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/fr/tools/flow');

  // Ensure we're on the main Flow page (not inside a project)
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  logger.info('Creating new project...');

  // Click "Nouveau projet"
  const newBtnSelectors = [
    'button:has-text("Nouveau projet")',
    'a:has-text("Nouveau projet")',
    '[aria-label*="Nouveau projet"]',
    'button:has-text("New project")',
  ];

  let clicked = false;
  for (const sel of newBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    } catch { /* continue */ }
  }

  if (!clicked) {
    // Fallback: try to find any "add" or "new" button
    const fallback = page.locator('[aria-label*="add"], button:has-text("add"), [class*="fab"]').first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
    } else {
      await takeScreenshot(page, 'no-new-project-btn');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find "Nouveau projet" button on the Flow page');
    }
  }

  await page.waitForTimeout(4000);

  const projectUrl = page.url();
  logger.info('New project created', { url: projectUrl });

  // If Flow asked for a project name, fill it
  const nameInputSelectors = [
    'input[placeholder*="Nom"]',
    'input[placeholder*="nom"]',
    'input[placeholder*="name"]',
    'input[placeholder*="Name"]',
    '[contenteditable="true"]',
  ];

  let named = false;
  for (const sel of nameInputSelectors) {
    try {
      const input = page.locator(sel).first();
      if (await input.isVisible().catch(() => false)) {
        const projectName = name ||
          `Projet ${new Date().toLocaleDateString('fr-FR')} ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
        await input.click();
        await input.fill(projectName);
        await page.waitForTimeout(500);

        // Confirm / submit
        const confirmSelectors = [
          'button:has-text("Créer")',
          'button:has-text("Confirmer")',
          'button:has-text("OK")',
          'button:has-text("Create")',
          '[type="submit"]',
        ];
        for (const cs of confirmSelectors) {
          try {
            const confirmBtn = page.locator(cs).first();
            if (await confirmBtn.isVisible().catch(() => false)) {
              await confirmBtn.click();
              await page.waitForTimeout(2500);
              break;
            }
          } catch { /* continue */ }
        }
        named = true;
        break;
      }
    } catch { /* continue */ }
  }

  let finalUrl = page.url();

  // If we're not inside a project (no /project/ in URL), click the project card
  if (!finalUrl.includes('/project/')) {
    logger.info('Not inside project page, clicking project card to enter...');
    await page.waitForTimeout(2000);

    // Find all project links, click the newest (first in DOM order)
    const cardClicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/project/"]');
      if (links.length > 0) {
        const link = links[0]; // newest project = first in order
        const href = link.getAttribute('href');
        if (href) {
          window.location.href = href.startsWith('http') ? href : 'https://labs.google' + href;
          return true;
        }
      }
      return false;
    });

    if (cardClicked) {
      await page.waitForTimeout(3000);
      finalUrl = page.url();
      logger.info('Navigated into project', { url: finalUrl });
    } else {
      // Fallback: try clicking via Playwright
      const projectLink = page.locator('a[href*="/project/"]').first();
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click();
        await page.waitForTimeout(3000);
        finalUrl = page.url();
        logger.info('Navigated into project via click', { url: finalUrl });
      } else {
        await takeScreenshot(page, 'no-project-links');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          'Could not find project card to navigate into. ' +
          'The project was created but no card link was found.');
      }
    }
  }

  // Store in local registry
  const store = loadProjects();
  const entry = {
    id: `proj_${Date.now()}`,
    url: finalUrl,
    name: name || `Projet ${new Date().toLocaleDateString('fr-FR')}`,
    created_at: new Date().toISOString(),
    last_used: new Date().toISOString(),
    tasks: [],
  };
  store.projects.push(entry);
  saveProjects(store);

  await takeScreenshot(page, 'new-project');

  return { url: finalUrl, id: entry.id, name: entry.name };
}

/**
 * Ensure we are inside a project context.
 * Rules:
 * 1. If already in a project → reuse it
 * 2. If context.campaign matches a stored project → reopen that project
 * 3. If context.forceNew → always create new
 * 4. Otherwise → create new project
 *
 * context = { campaign, name, forceNew }
 * Returns { url, reused, id, name }
 */
export async function ensureProjectInContext(page, context = {}) {
  const currentUrl = page.url();

  // Already inside a project? Use it.
  if (currentUrl.includes('/project/')) {
    logger.info('Already in a project — reusing', { url: currentUrl });
    return { url: currentUrl, reused: true };
  }

  // If forceNew, skip matching
  if (!context.forceNew) {
    // Try to find a matching project from history
    const store = loadProjects();
    if (context.campaign) {
      const match = store.projects.find(p =>
        p.campaign && p.campaign.toLowerCase() === context.campaign.toLowerCase()
      );
      if (match) {
        logger.info('Found matching project from history', {
          campaign: context.campaign, name: match.name, url: match.url,
        });
        await page.goto(match.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        match.last_used = new Date().toISOString();
        saveProjects(store);
        return { url: match.url, reused: true, id: match.id, name: match.name };
      }
    }
  }

  // Create new project
  return await createNewProject(page, context.name);
}

/**
 * Navigate to a section in the current project's sidebar.
 * sections: "Personnages", "Scènes", "Outils", "Corbeille"
 * Returns true if navigation succeeded, false otherwise.
 */
export async function navigateToSidebar(page, section) {
  logger.info('Navigating to sidebar section', { section });

  const selectors = [
    `[class*="sidebar"] button:has-text("${section}")`,
    `[class*="sidebar"] a:has-text("${section}")`,
    `nav button:has-text("${section}")`,
    `nav a:has-text("${section}")`,
    `[class*="nav"] button:has-text("${section}")`,
    `[class*="nav"] a:has-text("${section}")`,
    `button:has-text("${section}")`,
    `a:has-text("${section}")`,
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1500);
        logger.info('Sidebar navigation done', { section, selector });
        return true;
      }
    } catch { /* try next */ }
  }

  // Fallback: detect all buttons and log them
  logger.warn('Sidebar section not found via selectors', { section });
  const elements = await detectPageElements(page);
  await takeScreenshot(page, `sidebar-${section}-not-found`);
  logger.info('Available buttons on page', {
    buttons: elements.buttons.map(b => b.text).filter(Boolean),
  });

  return false;
}

/**
 * Get the current page elements and detect the active sidebar section.
 * Returns the section that appears to be active, or null.
 */
export async function getActiveSidebarSection(page) {
  try {
    const section = await page.evaluate(() => {
      const active = document.querySelector(
        '[class*="sidebar"] [class*="active"], [class*="sidebar"] [aria-current="page"], nav [class*="active"]'
      );
      if (active) {
        return (active.textContent || '').trim();
      }
      return null;
    });
    return section;
  } catch {
    return null;
  }
}

/**
 * Store task metadata in the project registry after completing a task.
 */
export function registerTaskInProject(projectId, taskInfo) {
  if (!projectId) return;
  const store = loadProjects();
  const proj = store.projects.find(p => p.id === projectId);
  if (proj) {
    proj.tasks.push({
      ...taskInfo,
      timestamp: new Date().toISOString(),
    });
    proj.last_used = new Date().toISOString();
    saveProjects(store);
  }
}

/**
 * Get a human-readable description of the current project context
 * for use in tool responses.
 */
export async function getProjectContextInfo(page) {
  const url = page.url();
  const inProject = url.includes('/project/');
  let section = null;
  if (inProject) {
    section = await getActiveSidebarSection(page);
  }
  return {
    inProject,
    url,
    activeSection: section,
    projectId: inProject ? url.split('/project/')[1]?.split('/')[0] || url.split('/project/')[1] : null,
  };
}

/**
 * Switch the project's bottom toolbar from Video mode to Image mode.
 * The mode selector shows "Vidéo · 6s" by default; we click it
 * and select "Image" from the dropdown.
 * Returns true if Image mode is confirmed active.
 */
export async function switchToImageMode(page) {
  logger.info('Checking current generation mode...');

  // Check current mode - if it already shows something other than Vidéo, we're good
  const currentMode = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => (b.textContent.includes('Vidéo') || b.textContent.includes('Image')) &&
                 b.offsetParent !== null);
    return btn ? btn.textContent.trim().substring(0, 30) : null;
  }).catch(() => null);

  if (currentMode && currentMode.includes('Image')) {
    logger.info('Already in Image mode');
    return true;
  }

  if (!currentMode || !currentMode.includes('Vidéo')) {
    logger.warn('Could not determine current mode, trying to find mode selector');
  }

  // Strategy 1: Click the mode button (Vidéo/Image) and select Image from dropdown
  // The dropdown is a Radix UI menu with role="tab" items for Image/Video/ratios/durations
  const modeButton = page.locator('button', { hasText: 'Vidéo' }).first();
  if (await modeButton.isVisible().catch(() => false)) {
    logger.info('Clicking mode selector button to change from Video to Image');
    await modeButton.click();
    await page.waitForTimeout(1500);

    // Look for Image option in the dropdown menu — items have role="tab" not role="menuitem"
    // The Image tab has text "imageImage" and id containing "-trigger-IMAGE"
    const imgTab = page.locator('[id*="trigger-IMAGE"], [role="tab"]:has-text("image")').first();
    if (await imgTab.isVisible().catch(() => false)) {
      await imgTab.click();
      await page.waitForTimeout(1500);
      logger.info('Switched to Image mode');

      // Close the Radix dropdown overlay that remains open after selection
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      return true;
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await takeScreenshot(page, 'switch-to-image-mode-failed');
  throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
    'IMPOSSIBLE de passer en mode Image. Le bouton de mode Vidéo est introuvable ou ' +
    'l\'option Image est absente. Génération annulée pour éviter une génération vidéo ' +
    'payante accidentelle. Vérifie manuellement l\'interface Google Flow.');

}
