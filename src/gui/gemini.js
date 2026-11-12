// Drive Gemini (gemini.google.com) in the shared Chrome to cut a hat out of a photo and
// re-render it on a plain white background. Runs in its own tab, so the Flow tab is untouched.
//
// Gemini's DOM is not a public API: every step tries several selectors (EN + VI UI) and,
// on failure, saves a screenshot to data/gemini-debug-*.png so selectors can be fixed.
import fs from 'fs';
import path from 'path';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.resolve(get('flowHome', '.'), 'data');

export const DEFAULT_HAT_PROMPT =
  'Tách riêng chiếc mũ trong ảnh này và tạo một ảnh sản phẩm của ĐÚNG chiếc mũ đó trên nền trắng tinh (#FFFFFF). ' +
  'Giữ nguyên chính xác hình dáng, màu sắc, chất liệu, đường may, logo, chữ và mọi chi tiết của mũ. ' +
  'Không có người, không có tay, không có vật nào khác. Ánh sáng studio mềm, bóng đổ nhẹ, mũ nằm giữa khung hình, góc chụp 3/4 nhìn rõ phía trước, tỉ lệ 1:1. ' +
  'Chỉ trả về ảnh, không cần giải thích.';

export const notebookUrl = () => (process.env.GEMINI_NOTEBOOK_URL || get('geminiNotebookUrl') || 'https://gemini.google.com/app').trim();
// New chats (trend questions, outfit drawings) go to a plain chat, not the hats notebook
export const chatUrl = () => (process.env.GEMINI_CHAT_URL || get('geminiChatUrl') || 'https://gemini.google.com/app').trim();
export const hatPrompt = () => (process.env.GEMINI_HAT_PROMPT || get('geminiHatPrompt') || DEFAULT_HAT_PROMPT).trim();
const timeoutMs = () => Number(process.env.GEMINI_TIMEOUT_MS) || get('geminiTimeoutMs', 300000);

const INPUT_SEL = [
  'rich-textarea [contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea',
].join(', ');
const UPLOAD_MENU_RE = /upload|tải (tệp|lên)|thêm tệp|add files|mở trình đơn tải|open upload|tệp và|files/i;
const UPLOAD_ITEM_RE = /^(upload files?|tải tệp lên|tải lên tệp|tải tệp|tệp|files?)$|upload file|tải tệp lên/i;
const SEND_RE = /^(send|gửi)|send message|gửi tin nhắn|gửi lời nhắc/i;
const STOP_RE = /^(stop|dừng)/i;
// VI UI: "Tải hình ảnh kích thước đầy đủ xuống"
const DOWNLOAD_RE = /download|tải.*xuống|tải.*ảnh/i;
const MORE_RE = /^(more|thêm|hiện thêm|tùy chọn khác|các tùy chọn khác|show more options)|more options|tùy chọn/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function debugShot(page, step) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `gemini-debug-${Date.now()}-${step}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

async function fail(page, step, message) {
  const shot = await debugShot(page, step);
  const err = new Error(`${message}${shot ? ` (ảnh chụp: ${path.relative(process.cwd(), shot)})` : ''}`);
  err.step = step;
  throw err;
}

/** Find a visible clickable element by aria-label, mattooltip or text. */
async function findClickable(page, re, scope = page) {
  const handles = await scope.locator('button, [role="button"], [role="menuitem"], a').all();
  for (const h of handles) {
    try {
      if (!(await h.isVisible())) continue;
      const label = [
        await h.getAttribute('aria-label'),
        await h.getAttribute('mattooltip'),
        await h.getAttribute('data-tooltip'),
        (await h.innerText().catch(() => '')).trim(),
      ].filter(Boolean).join(' | ');
      if (re.test(label)) return h;
    } catch { /* element went away */ }
  }
  return null;
}

async function attachImage(page, imagePath) {
  // 1) A file input already in the DOM
  const inputs = page.locator('input[type="file"]');
  if (await inputs.count()) {
    try {
      await inputs.first().setInputFiles(imagePath);
      return 'file-input';
    } catch { /* fall through */ }
  }

  // 2) "+" / upload menu → "Upload files" → native file chooser
  const menuBtn = await findClickable(page, UPLOAD_MENU_RE);
  if (menuBtn) {
    try {
      const chooserP = page.waitForEvent('filechooser', { timeout: 8000 });
      await menuBtn.click();
      await sleep(600);
      const item = await findClickable(page, UPLOAD_ITEM_RE);
      if (item) await item.click();
      const chooser = await chooserP;
      await chooser.setFiles(imagePath);
      return 'file-chooser';
    } catch (e) {
      logger.warn('Gemini: upload menu path failed, trying paste', { error: e.message });
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // 3) Paste the image into the prompt box (Gemini accepts pasted images)
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const ok = await page.evaluate(({ b64, mime, name, sel }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, { b64, mime, name: path.basename(imagePath), sel: INPUT_SEL });
  if (ok) return 'paste';
  return null;
}

/** Wait until the attached image shows as a thumbnail in the composer. */
async function waitForAttachment(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const n = await page.locator(
      'uploader-file-preview, [data-test-id*="file-preview" i], .file-preview, user-query-file-preview, img[src^="blob:"], img[src^="data:image"]',
    ).count();
    if (n) return true;
    await sleep(500);
  }
  return false;
}

/** While Gemini answers, the send button turns into a "Stop" button. */
async function isGenerating(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    return [...document.querySelectorAll('button[aria-label]')]
      .some(b => b.offsetParent !== null && re.test(b.getAttribute('aria-label')));
  }, STOP_RE.source).catch(() => false);
}

/** Images in the newest model response that look like generated results (not icons/avatars). */
async function newResultImages(page, responsesBefore) {
  return page.evaluate((before) => {
    const responses = [...document.querySelectorAll('model-response, [data-test-id="model-response"], .model-response-text')];
    const fresh = responses.slice(before);
    const scope = fresh.length ? fresh : responses.slice(-1);
    const imgs = scope.flatMap(r => [...r.querySelectorAll('img')]);
    return imgs
      .filter(img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256)
      .map(img => ({ src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight }));
  }, responsesBefore);
}

async function lastResponseText(page, max = 400) {
  return page.evaluate((max) => {
    const r = [...document.querySelectorAll('model-response')].pop();
    // Prefer the answer body (skips "Show thinking" and action buttons) when present
    const body = r?.querySelector('message-content, .markdown, .model-response-text') || r;
    return (body?.innerText || '').trim().slice(0, max);
  }, max);
}

/** Same image regardless of its size suffix (…=s1024-rj vs …=s0). */
const imageKey = u => String(u).split('=')[0];

async function saveImage(page, context, src, destFile, captured) {
  const isImageFile = buf => buf && buf.length > 5000;

  // a) The response's own "download full size" button (best quality)
  try {
    const img = page.locator(`img[src="${src.replace(/"/g, '\\"')}"]`).first();
    await img.hover();
    await sleep(400);
    const container = img.locator('xpath=ancestor::*[self::generated-image or self::single-image or contains(@class,"image")][1]');
    let btn = await findClickable(page, DOWNLOAD_RE, (await container.count()) ? container : page.locator('model-response').last());
    if (!btn) {
      // VI UI: response footer "⋯" menu → "Tải hình ảnh xuống"
      const more = await findClickable(page, MORE_RE, page.locator('model-response').last());
      if (more) {
        await more.click();
        await sleep(600);
        btn = await findClickable(page, DOWNLOAD_RE, page.locator('.cdk-overlay-container, [role="menu"]').first())
          || await findClickable(page, DOWNLOAD_RE);
        if (!btn) await page.keyboard.press('Escape').catch(() => {});
      }
    }
    if (btn) {
      const dlP = page.waitForEvent('download', { timeout: 30000 });
      await btn.click();
      const dl = await dlP;
      await dl.saveAs(destFile);
      return 'download-button';
    }
  } catch (e) {
    logger.warn('Gemini: download button failed, fetching image directly', { error: e.message });
  }

  // b) The bytes the browser already downloaded to display it (no CORS at the network level)
  try {
    const hits = captured.get(imageKey(src)) || [];
    for (const resp of hits.reverse()) {
      const buf = await resp.body().catch(() => null);
      if (isImageFile(buf)) { fs.writeFileSync(destFile, buf); return 'network'; }
    }
  } catch (e) {
    logger.warn('Gemini: captured response unusable', { error: e.message });
  }

  // c) Fetch the URL with the browser's cookies: as shown, then full size
  if (/^https?:/.test(src)) {
    for (const u of [src, src.replace(/=s\d+[^/]*$/, '=s0')]) {
      try {
        const res = await context.request.get(u, { headers: { Referer: 'https://gemini.google.com/' } });
        const buf = res.ok() ? await res.body() : null;
        if (isImageFile(buf)) { fs.writeFileSync(destFile, buf); return 'request'; }
        logger.warn('Gemini: image request failed', { status: res.status() });
      } catch (e) {
        logger.warn('Gemini: image request error', { error: e.message });
      }
    }
  }

  // d) blob:/data: URLs can be read inside the page
  if (/^(blob|data):/.test(src)) {
    try {
      const b64 = await page.evaluate(async (u) => {
        const blob = await (await fetch(u)).blob();
        return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      }, src);
      fs.writeFileSync(destFile, Buffer.from(b64, 'base64'));
      return 'page-fetch';
    } catch (e) {
      logger.warn('Gemini: in-page fetch failed', { error: e.message });
    }
  }

  // e) Last resort: screenshot of the image as displayed (lower resolution, but never blocked)
  const img = page.locator('model-response img').filter({ visible: true }).last();
  await img.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.move(0, 0); // hide hover toolbars
  await sleep(300);
  await img.screenshot({ path: destFile });
  return 'screenshot';
}

/**
 * One Gemini turn in a fresh tab: open `url`, optionally attach an image, send `prompt`, wait
 * for the answer. mode 'image' waits for a generated image and saves it to `destFile`;
 * mode 'text' returns the answer text. The tab closes on success, stays open on failure.
 */
async function geminiTurn(context, { url, prompt, imagePath = null, mode = 'image', destFile = null, label = 'gemini' }) {
  const page = await context.newPage();
  const started = Date.now();
  // Remember every image the tab downloads, so the result can be saved from the network
  // response itself (fetching it again from the page is blocked by CORS).
  const captured = new Map();
  page.on('response', (resp) => {
    try {
      if (resp.request().resourceType() !== 'image' || !resp.ok()) return;
      const key = imageKey(resp.url());
      if (!captured.has(key)) captured.set(key, []);
      captured.get(key).push(resp);
    } catch { /* ignore */ }
  });
  try {
    logger.info(`Gemini (${label}): opening`, { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/accounts\.google\.com/.test(page.url())) {
      await fail(page, 'login', `Gemini chưa đăng nhập. Hãy đăng nhập ${get('expectedAccount') || 'tài khoản Google'} trong cửa sổ Chrome rồi thử lại.`);
    }

    const input = page.locator(INPUT_SEL).first();
    try { await input.waitFor({ state: 'visible', timeout: 45000 }); }
    catch { await fail(page, 'input', 'Không thấy ô nhập của Gemini.'); }
    await sleep(1500);

    const before = await page.locator('model-response').count();

    if (imagePath) {
      const how = await attachImage(page, imagePath);
      if (!how) await fail(page, 'attach', 'Không đính kèm được ảnh vào Gemini.');
      if (!(await waitForAttachment(page))) logger.warn('Gemini: no attachment preview seen — continuing', { how });
      logger.info('Gemini: image attached', { how });
    }

    await input.click();
    await page.keyboard.insertText(prompt);
    await sleep(800);

    // Send: wait until the button is enabled (upload finished), else press Enter
    let sent = false;
    for (let i = 0; i < 60 && !sent; i++) {
      const send = await findClickable(page, SEND_RE);
      if (send && (await send.getAttribute('aria-disabled')) !== 'true' && !(await send.isDisabled().catch(() => false))) {
        await send.click();
        sent = true;
      } else {
        await sleep(1000);
      }
    }
    if (!sent) await page.keyboard.press('Enter');
    logger.info('Gemini: prompt sent');

    const deadline = started + timeoutMs();
    if (mode === 'text') {
      // Done when a new answer exists and Gemini stopped generating for a few seconds
      let stableSince = null;
      let lastLen = -1;
      while (Date.now() < deadline) {
        await sleep(2000);
        const count = await page.locator('model-response').count();
        const generating = await isGenerating(page);
        const text = count > before ? await lastResponseText(page, 20000) : '';
        if (count > before && !generating && text.length && text.length === lastLen) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince > 3000) {
            logger.info('Gemini: text answer received', { chars: text.length, seconds: Math.round((Date.now() - started) / 1000) });
            await page.close().catch(() => {});
            return { text };
          }
        } else {
          stableSince = null;
        }
        lastLen = text.length;
      }
      await fail(page, 'text', 'Gemini không trả lời kịp (hết thời gian chờ).');
    }

    // mode 'image': wait for a generated image in the new response
    let images = [];
    let idleSince = null;
    while (Date.now() < deadline) {
      await sleep(2500);
      images = await newResultImages(page, before);
      const generating = await isGenerating(page);
      if (images.length && !generating) break;
      if (!generating && (await page.locator('model-response').count()) > before) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > 25000) break; // finished answering, no image
      } else {
        idleSince = null;
      }
    }
    if (!images.length) {
      const said = await lastResponseText(page).catch(() => '');
      await fail(page, 'result', `Gemini không trả về ảnh${said ? `. Gemini trả lời: "${said}"` : ' (hết thời gian chờ)'}.`);
    }

    await sleep(1500); // let the full-size image settle
    const best = images.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const via = await saveImage(page, context, best.src, destFile, captured);
    logger.info(`Gemini (${label}): image saved`, { destFile, via, seconds: Math.round((Date.now() - started) / 1000) });
    await page.close().catch(() => {});
    return { file: destFile, via };
  } catch (err) {
    logger.error(`Gemini (${label}) failed`, { error: err.message, step: err.step });
    throw err; // the tab stays open so the user can see what happened
  }
}

/** Hat photo → the same hat on a plain white background (saved to `destFile`). */
export async function cutoutOnWhite(context, imagePath, destFile, { prompt = hatPrompt(), extraInfo = '' } = {}) {
  const text = extraInfo ? `${prompt}\n\nThông tin mũ: ${extraInfo}` : prompt;
  return geminiTurn(context, { url: notebookUrl(), prompt: text, imagePath, mode: 'image', destFile, label: 'cutout' });
}

export const REMOVE_PEOPLE_PROMPT =
  'Xoá TẤT CẢ người trong ảnh này (cả người ở xa, bóng người, tay, chân, phản chiếu trong gương/kính) ' +
  'và vẽ lại phần nền phía sau họ thật tự nhiên. Giữ nguyên chính xác khung cảnh: địa điểm, đồ vật, màu sắc, ' +
  'ánh sáng, góc chụp, tiêu cự và tỉ lệ khung hình. Không thêm gì mới, không có chữ. ' +
  'Chỉ trả về ảnh, không cần giải thích.';

/** Scene photo → the same scene with every person removed (a clean background plate). */
export async function removePeople(context, imagePath, destFile) {
  return geminiTurn(context, { url: chatUrl(), prompt: REMOVE_PEOPLE_PROMPT, imagePath, mode: 'image', destFile, label: 'remove-people' });
}

/** Prompt that puts the hat from the photo into a staged product scene (no people, no hands). */
export function stagePrompt(scene, ratio = '9:16') {
  const shape = { '9:16': 'dọc 9:16 (portrait)', '16:9': 'ngang 16:9 (landscape)', '1:1': 'vuông 1:1' }[ratio] || `tỉ lệ ${ratio}`;
  return 'Lấy CHÍNH XÁC chiếc mũ trong ảnh này (giữ nguyên dáng, màu, chất liệu, vân đan, dây/nơ, hoạ tiết, ' +
    'không thay đổi bất kỳ chi tiết nào của mũ) và đặt nó nằm một mình trên mặt bàn trong một bức ảnh sản phẩm chân thực. ' +
    `Bối cảnh và ánh sáng: ${scene}. ` +
    'Mũ nằm tự nhiên trên bàn, có bóng đổ thật xuống mặt bàn, ở giữa khung hình, chiếm khoảng một nửa khung, ' +
    'chừa khoảng trống xung quanh để một bàn tay có thể đưa vào cầm lên. ' +
    'KHÔNG có người, KHÔNG có tay, không chữ, không logo, không watermark. ' +
    `Ảnh khung ${shape}, chất lượng cao, như ảnh chụp thật. Chỉ trả về ảnh, không cần giải thích.`;
}

/** Hat photo → the hat resting on a table in the given scene/lighting (an intro video's start frame). */
export async function stageHat(context, imagePath, destFile, { scene, ratio } = {}) {
  return geminiTurn(context, { url: chatUrl(), prompt: stagePrompt(scene, ratio), imagePath, mode: 'image', destFile, label: 'stage-hat' });
}

/** Ask Gemini a question in a new chat (it can search the web) and return its answer text. */
export async function askGemini(context, prompt) {
  return geminiTurn(context, { url: chatUrl(), prompt, mode: 'text', label: 'ask' });
}

/** Have Gemini draw an image from a prompt plus one attached image (saved to `destFile`). */
export async function drawFromImage(context, imagePath, prompt, destFile) {
  return geminiTurn(context, { url: chatUrl(), prompt, imagePath, mode: 'image', destFile, label: 'draw-ref' });
}

/** Have Gemini draw an image from a text prompt (saved to `destFile`). */
export async function drawWithGemini(context, prompt, destFile) {
  return geminiTurn(context, { url: chatUrl(), prompt, mode: 'image', destFile, label: 'draw' });
}
