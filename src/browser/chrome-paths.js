import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { get } from '../utils/config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Cross-platform resolution of Chrome executable, user-data dir and profile.
 * Every value can be overridden in config/flow.config.json:
 *   chromePath, chromeUserDataDir, chromeProfile, automationUserDataDir
 */

const DEFAULT_PROFILE = 'Profile 18'; // "Bau" (baunhu543@gmail.com)

function firstExisting(candidates) {
  return candidates.find(p => p && fs.existsSync(p));
}

export function getChromePath() {
  const configured = get('browserPath') || get('chromePath');
  if (configured) return configured;

  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
    return firstExisting(roots.filter(Boolean).map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')))
      || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return firstExisting(['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'])
    || '/opt/google/chrome/chrome';
}

export function getChromeUserDataDir() {
  const configured = get('chromeUserDataDir');
  if (configured && !configured.startsWith('/path/to')) return configured;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(os.homedir(), '.config', 'google-chrome');
}

export function getProfileName() {
  return get('chromeProfile', DEFAULT_PROFILE);
}

export function getProfileSourceDir() {
  return path.join(getChromeUserDataDir(), getProfileName());
}

/**
 * Chrome (136+) refuses --remote-debugging-port on the default user-data dir,
 * so automation runs on a dedicated, persistent user-data dir seeded from the
 * real profile. Login done there once is kept between runs.
 */
export function getAutomationUserDataDir() {
  const configured = get('automationUserDataDir');
  if (configured) return path.resolve(PROJECT_ROOT, configured);
  const slug = getProfileName().replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return path.resolve(PROJECT_ROOT, `chrome-profile-${slug}`);
}
