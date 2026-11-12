// Hat Studio — "Ghép video" tab: a CapCut-like editor (media library · live preview · properties ·
// timeline with trim/reorder/split) on top of the ffmpeg endpoints in server.js (/api/edit*).
//
// Classic script loaded after studio.html's main script: it shares that page's globals
// ($, api, showMsg, state, selectedProduct, readStore, writeStore, uploadImage, refreshVideos).
// studio.html calls initEditor() once and renderEditSources() whenever the hat's videos change.
//
// The in-browser preview is an approximation (two stacked <video>s for crossfades, HTML for
// text/logo); the exported file is rendered by ffmpeg and is the source of truth.
/* global $, api, showMsg, state, selectedProduct, readStore, writeStore, uploadImage, refreshVideos */

// ---------- state ----------
const ED_PREFS_KEY = 'hatStudio.editPrefs';
const ED_PROJECT_KEY = id => `hatStudio.editProject.${id || 'none'}`;
const ED_TEXT_FADE = 0.4; // seconds, same as the ffmpeg side
const ED_MIN_CLIP = 0.5;
const ED_FONT_FAMILY = {
  arial: 'Arial, Helvetica, sans-serif', segoe: '"Segoe UI", Arial, sans-serif', tahoma: 'Tahoma, Arial, sans-serif',
  bahnschrift: 'Bahnschrift, Arial, sans-serif', impact: 'Impact, "Arial Black", sans-serif',
};
const TEXT_POS_LABELS = { bottom: 'Dưới', center: 'Giữa', top: 'Trên' };
const WM_POS_LABELS = { tr: 'Góc trên phải', tl: 'Góc trên trái', br: 'Góc dưới phải', bl: 'Góc dưới trái' };

let edTools = null, edTelegram = false;
let edSources = [];          // videos of the selected hat (set by studio.html's refreshVideos)
let edUploads = [];          // media the user imported from their machine: [{ url, name, kind }]
let project = null;          // see newProject()
let projectProductId;        // which hat the project belongs to (undefined = not loaded yet)
let selectedClipId = null;
let history = [], future = [], lastSnap = '';
let pxPerSec = 60;
let edJob = null, edPollTimer = null;
let uidCounter = 0;
const edInfo = new Map();    // url → probe result from the server
const thumbs = new Map();    // url → { frames: [{ t, src }], dur } | 'pending'
const waves = new Map();     // url → { peaks: Float32Array | null, duration } | 'pending'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = n => Math.round(n * 20) / 20; // 0.05 s steps
const fmtClock = s => { const m = Math.floor(s / 60); const r = s - m * 60; return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`; };
const fmtSec = s => `${Math.round(s * 10) / 10}s`;
const fileNameOf = url => decodeURIComponent(url.split('/').pop());
const isStillUrl = url => /\.(png|jpe?g|webp)(\?|$)/i.test(url);
const ED_STILL_MAX = 60, ED_STILL_DEFAULT = 3; // seconds a still image is shown (max / when added)
const newId = () => `c${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

function newProject() {
  const p = readStore(ED_PREFS_KEY, {});
  return {
    clips: [], name: '',
    transition: p.transition || 'fade', tDur: p.tDur ?? 0.5, fadeIn: p.fadeIn ?? 0.5, fadeOut: p.fadeOut ?? 0.5,
    textStyle: { font: 'arial', size: 60, color: '#ffffff', box: 'dark', ...(p.textStyle || {}) },
    audio: p.audio || 'keep', music: null, watermark: null,
  };
}

// ---------- sequence maths ----------
const tDur = () => (project.transition === 'none' ? 0 : Number(project.tDur) || 0);
const clipLen = c => Math.max(0, c.end - c.start);
/** Where each clip sits on the timeline (clips overlap by the transition length). */
function segments() {
  const T = tDur();
  let cursor = 0;
  return project.clips.map((clip, i) => {
    const len = clipLen(clip);
    const tIn = i ? cursor - T : 0;
    cursor = tIn + len;
    return { clip, i, tIn, tOut: cursor, len };
  });
}
const totalDur = () => { const s = segments(); return s.length ? Math.max(0, s.at(-1).tOut) : 0; };
function projectSize() {
  const info = project.clips[0] && edInfo.get(project.clips[0].url);
  return { W: info?.width || 1080, H: info?.height || 1920 };
}
/** Minimum usable length of clip i given the transition (middle clips lose T on both sides). */
function minLenFor(i) {
  const T = tDur();
  return Math.max(1, (i === 0 || i === project.clips.length - 1 ? 1 : 2) * T + 0.2);
}

// ---------- history / persistence ----------
const snapshot = () => JSON.stringify(project);
function commit() {
  history.push(lastSnap);
  if (history.length > 80) history.shift();
  future = [];
  lastSnap = snapshot();
  saveProject();
  renderAll();
}
function undo() { if (!history.length) return; future.push(snapshot()); project = JSON.parse(history.pop()); lastSnap = snapshot(); afterRestore(); }
function redo() { if (!future.length) return; history.push(snapshot()); project = JSON.parse(future.pop()); lastSnap = snapshot(); afterRestore(); }
function afterRestore() {
  if (!project.clips.some(c => c.id === selectedClipId)) selectedClipId = null;
  saveProject();
  renderAll();
}
function saveProject() {
  writeStore(ED_PROJECT_KEY(projectProductId), project);
  const { transition, tDur: td, fadeIn, fadeOut, textStyle, audio } = project;
  writeStore(ED_PREFS_KEY, { transition, tDur: td, fadeIn, fadeOut, textStyle, audio });
}
/** Switch to the project of the selected hat (one autosaved project per hat). */
async function loadProjectFor(productId) {
  if (projectProductId === productId && project) return;
  projectProductId = productId;
  const saved = readStore(ED_PROJECT_KEY(productId), null);
  project = saved && Array.isArray(saved.clips) ? { ...newProject(), ...saved } : newProject();
  selectedClipId = null;
  history = []; future = [];
  pause();
  pv.t = 0;
  if (project.clips.length) {
    // Files may have been deleted since — drop what no longer exists
    const infos = await probeMedia(project.clips.map(c => c.url)).catch(() => []);
    const missing = project.clips.filter(c => !infos.find(x => x.url === c.url && !x.error));
    if (missing.length) {
      project.clips = project.clips.filter(c => !missing.includes(c));
      showMsg('warn', `Bỏ ${missing.length} đoạn không còn file trên máy.`);
    }
    project.clips.forEach(c => ensureThumbs(c.url));
  }
  if (project.music) ensureWave(project.music.url);
  lastSnap = snapshot();
  fitZoom();
  renderAll();
}

// ---------- media helpers ----------
async function probeMedia(urls) {
  const missing = [...new Set(urls)].filter(u => !edInfo.has(u));
  if (missing.length) for (const x of await api('/api/edit/probe', { files: missing })) edInfo.set(x.url, x);
  return urls.map(u => edInfo.get(u));
}
async function uploadMedia(file) {
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.url;
}

/** Thumbnails of a source video (a dozen frames spread over its length), drawn once per url. */
async function ensureThumbs(url) {
  if (thumbs.has(url)) return;
  thumbs.set(url, 'pending');
  if (isStillUrl(url)) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const h = 60, w = Math.max(20, Math.round(h * ((img.naturalWidth / img.naturalHeight) || 0.5625)));
      thumbs.set(url, { frames: [{ t: 0, src: url }], dur: ED_STILL_MAX, w, h });
    } catch { thumbs.set(url, { frames: [], dur: 0, w: 34, h: 60 }); }
    renderTimeline(); renderLibrary();
    return;
  }
  try {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('không đọc được video')); });
    const dur = v.duration || 1;
    const n = clamp(Math.round(dur / 1.5), 4, 14);
    const h = 60, w = Math.max(20, Math.round(h * ((v.videoWidth / v.videoHeight) || 0.5625)));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.05, (i + 0.5) * dur / n);
      await new Promise(res => { v.onseeked = res; v.currentTime = t; });
      ctx.drawImage(v, 0, 0, w, h);
      frames.push({ t, src: canvas.toDataURL('image/jpeg', 0.6) });
    }
    v.removeAttribute('src'); v.load();
    thumbs.set(url, { frames, dur, w, h });
  } catch {
    thumbs.set(url, { frames: [], dur: 0, w: 34, h: 60 });
  }
  renderTimeline();
  renderLibrary();
}

/** Peak envelope of an audio file for the waveform strip. */
async function ensureWave(url) {
  if (waves.has(url)) return;
  waves.set(url, 'pending');
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ac.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const N = 2000, step = Math.max(1, Math.floor(ch.length / N));
    const peaks = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let j = i * step, end = Math.min(ch.length, (i + 1) * step); j < end; j += 8) { const a = Math.abs(ch[j]); if (a > m) m = a; }
      peaks[i] = m;
    }
    waves.set(url, { peaks, duration: audio.duration });
    ac.close();
  } catch {
    waves.set(url, { peaks: null, duration: 0 });
  }
  renderTimeline();
}

// ---------- DOM ----------
function buildEditorDom() {
  $('editorRoot').innerHTML = `
<div class="ved">
  <div class="ved-top">
    <aside class="ved-lib" aria-label="Thư viện">
      <div class="ved-lib-head"><span>Thư viện</span>
        <label class="btn small">＋ Nhập<input type="file" id="vLibUpload" accept="video/mp4,.mp4,image/png,image/jpeg,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/aac,.mp3,.m4a,.wav,.aac" multiple hidden></label></div>
      <p class="ved-lib-hint" id="vLibHint"></p>
      <div class="ved-lib-list" id="vLibList"></div>
    </aside>
    <section class="ved-player" aria-label="Xem trước">
      <div class="ved-player-head"><span>Xem trước</span><span class="ved-note">gần đúng — bản xuất do ffmpeg dựng</span>
        <button class="btn small primary" type="button" id="vExport">⬆ Xuất video</button></div>
      <div class="ved-stage" id="vStage">
        <div class="ved-frame" id="vFrame">
          <video id="pvA" muted playsinline preload="auto"></video>
          <video id="pvB" muted playsinline preload="auto"></video>
          <div class="pv-fade" id="pvFade"></div>
          <div class="pv-text" id="pvTextA" hidden></div><div class="pv-text" id="pvTextB" hidden></div>
          <img class="pv-wm" id="pvWm" alt="" hidden>
          <div class="pv-empty" id="pvEmpty">Bấm "+" trên một video trong thư viện để đưa vào timeline.</div>
        </div>
        <div class="ved-export" id="vExportBox" hidden></div>
      </div>
      <div class="ved-controls">
        <button class="btn small" type="button" id="vToStart" title="Về đầu (Home)">⏮</button>
        <button class="btn small" type="button" id="vPlay" title="Phát / tạm dừng (Space)">▶</button>
        <span class="ved-time"><b id="vCur">00:00.0</b> / <span id="vTotal">00:00.0</span></span>
        <span class="ved-size" id="vSize"></span>
      </div>
      <audio id="pvMusic" preload="auto" loop></audio>
    </section>
    <aside class="ved-props" aria-label="Thuộc tính">
      <div class="ved-props-tabs" role="tablist">
        <button class="ptab" type="button" role="tab" data-ptab="clip" aria-selected="true">Đoạn</button>
        <button class="ptab" type="button" role="tab" data-ptab="text" aria-selected="false">Chữ</button>
        <button class="ptab" type="button" role="tab" data-ptab="project" aria-selected="false">Dự án</button>
      </div>
      <div class="ved-props-body" id="vPropsClip"></div>
      <div class="ved-props-body" id="vPropsText" hidden></div>
      <div class="ved-props-body" id="vPropsProject" hidden></div>
    </aside>
  </div>
  <div class="ved-tl" aria-label="Timeline">
    <div class="ved-tl-bar">
      <button class="btn small" type="button" id="vUndo" title="Hoàn tác (Ctrl+Z)">↶</button>
      <button class="btn small" type="button" id="vRedo" title="Làm lại (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button class="btn small" type="button" id="vSplit" title="Tách đoạn tại con trỏ (S)">✂ Tách</button>
      <button class="btn small danger" type="button" id="vDelete" title="Xoá đoạn đang chọn (Delete)">🗑 Xoá</button>
      <span class="grow"></span>
      <span class="ved-note" id="vTlInfo"></span>
      <label class="ved-zoom" title="Phóng to / thu nhỏ timeline">🔍<input type="range" id="vZoom" min="15" max="260" step="5" value="60"></label>
    </div>
    <div class="ved-tl-scroll" id="vTlScroll">
      <div class="ved-tl-inner" id="vTlInner">
        <div class="ved-ruler" id="vRuler"></div>
        <div class="ved-track ved-track-text" id="vTrackText" data-label="Chữ"><div class="ved-tl-lane"></div></div>
        <div class="ved-track ved-track-video" id="vTrackVideo" data-label="Video"><div class="ved-tl-lane"></div></div>
        <div class="ved-track ved-track-audio" id="vTrackAudio" data-label="Nhạc"><div class="ved-tl-lane"></div></div>
        <div class="ved-playhead" id="vPlayhead"><i></i></div>
      </div>
    </div>
  </div>
</div>`;
}

function renderAll() {
  renderLibrary();
  renderTimeline();
  renderProps();
  renderPreview(true);
  $('vUndo').disabled = !history.length;
  $('vRedo').disabled = !future.length;
}

// ---------- library ----------
function renderLibrary() {
  const list = $('vLibList');
  if (!list) return;
  list.innerHTML = '';
  const product = selectedProduct();
  $('vLibHint').textContent = product ? `Video của mũ "${product.name}" + file bạn nhập.` : 'Chọn một mũ ở tab Tạo bộ ảnh để thấy video của mũ đó.';
  const videos = [...edUploads.filter(u => u.kind === 'video'), ...edSources.map(s => ({ url: s.url, name: s.name || fileNameOf(s.url), kind: 'video' }))];
  const audios = edUploads.filter(u => u.kind === 'audio');
  if (!videos.length && !audios.length) { list.innerHTML = '<p class="empty">Chưa có gì. Tạo video ở tab Tạo bộ ảnh, hoặc bấm "＋ Nhập" để thêm MP4 / MP3 từ máy.</p>'; return; }
  const group = title => { const h = document.createElement('p'); h.className = 'ved-lib-group'; h.textContent = title; list.appendChild(h); };
  if (videos.length) group(`Video (${videos.length})`);
  for (const it of videos) {
    const th = thumbs.get(it.url);
    const used = project?.clips.filter(c => c.url === it.url).length || 0;
    const row = document.createElement('div');
    row.className = 'ved-media';
    row.title = `${it.name} — bấm đúp để thêm vào timeline`;
    row.innerHTML = `<div class="th"></div><div class="nm"><b></b><small></small></div><button class="btn small primary" type="button">+</button>`;
    const thEl = row.querySelector('.th');
    if (th && th !== 'pending' && th.frames[0]) thEl.style.backgroundImage = `url(${th.frames[0].src})`; else { thEl.textContent = '▶'; ensureThumbs(it.url); }
    row.querySelector('b').textContent = it.name;
    row.querySelector('small').textContent = [th && th !== 'pending' && th.dur ? fmtSec(th.dur) : '', used ? `đã dùng ×${used}` : ''].filter(Boolean).join(' · ');
    row.querySelector('button').onclick = e => { e.stopPropagation(); addClip(it.url, it.name); };
    row.ondblclick = () => addClip(it.url, it.name);
    list.appendChild(row);
  }
  if (audios.length) group(`Nhạc (${audios.length})`);
  for (const it of audios) {
    const row = document.createElement('div');
    row.className = 'ved-media';
    row.innerHTML = `<div class="th audio">♪</div><div class="nm"><b></b><small></small></div><button class="btn small" type="button" title="Dùng làm nhạc nền">Dùng</button>`;
    row.querySelector('b').textContent = it.name;
    row.querySelector('small').textContent = project?.music?.url === it.url ? 'đang là nhạc nền' : 'nhạc nền';
    row.querySelector('button').onclick = e => { e.stopPropagation(); setMusic(it.url, it.name); };
    row.ondblclick = () => setMusic(it.url, it.name);
    list.appendChild(row);
  }
}

async function addClip(url, name, text = '') {
  try {
    const [info] = await probeMedia([url]);
    if (!info || info.error) throw new Error(info?.error || 'Không đọc được file.');
    const still = isStillUrl(url);
    const clip = still
      ? { id: newId(), url, name: name || fileNameOf(url), still: true, duration: ED_STILL_MAX, hasAudio: false, start: 0, end: ED_STILL_DEFAULT, text, textPos: 'bottom' }
      : { id: newId(), url, name: name || fileNameOf(url), duration: info.duration, hasAudio: info.hasAudio, start: 0, end: info.duration, text, textPos: 'bottom' };
    project.clips.push(clip);
    selectedClipId = clip.id;
    ensureThumbs(url);
    commit();
    openPropsTab('clip');
    fitZoom();
    renderTimeline();
    // show the new clip in the player
    const seg = segments().at(-1);
    seekTo(seg.tIn + 0.05);
    scrollPlayheadIntoView(true);
  } catch (e) { showMsg('err', 'Không thêm được video: ' + e.message); }
}

function setMusic(url, name) {
  project.music = { url, name, volume: project.music?.volume ?? 0.3 };
  ensureWave(url);
  commit();
  openPropsTab('project');
}

// ---------- properties panel ----------
function openPropsTab(name) {
  for (const b of document.querySelectorAll('.ptab')) b.setAttribute('aria-selected', String(b.dataset.ptab === name));
  $('vPropsClip').hidden = name !== 'clip';
  $('vPropsText').hidden = name !== 'text';
  $('vPropsProject').hidden = name !== 'project';
}
const selectedClip = () => project.clips.find(c => c.id === selectedClipId) || null;

function field(label, inputHtml) { return `<label class="field">${label}${inputHtml}</label>`; }
function options(map, value) { return Object.entries(map).map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join(''); }

function renderProps() {
  renderClipProps();
  renderTextProps();
  renderProjectProps();
}

function renderClipProps() {
  const root = $('vPropsClip');
  const c = selectedClip();
  if (!c) { root.innerHTML = '<p class="empty">Bấm vào một đoạn trên timeline để chỉnh cắt và chữ của đoạn đó.<br><br>Kéo hai mép đoạn để cắt, kéo cả đoạn để đổi chỗ, ✂ để tách tại con trỏ.</p>'; return; }
  const i = project.clips.indexOf(c);
  const len = clipLen(c), minLen = minLenFor(i);
  root.innerHTML = `
    <div class="ved-sec">
      <p class="ved-ph" title="${c.name}">Đoạn ${i + 1} · ${c.name}</p>
      <div class="ved-grid2">
        ${field('Cắt từ (giây)', `<input type="number" data-k="start" min="0" max="${c.duration}" step="0.1" value="${c.start}">`)}
        ${field('Đến (giây)', `<input type="number" data-k="end" min="0" max="${c.duration}" step="0.1" value="${c.end}">`)}
      </div>
      <p class="hint">${c.still ? `Ảnh tĩnh, hiện <b>${fmtSec(len)}</b> (tối đa ${ED_STILL_MAX}s — sửa ô "Đến" hoặc kéo mép phải)` : `Dùng <b>${fmtSec(len)}</b> / gốc ${fmtSec(c.duration)}${c.hasAudio ? '' : ' · video không có tiếng'}`}${len < minLen ? ` · <span style="color:var(--warn)">⚠ cần ≥ ${fmtSec(minLen)} với chuyển cảnh hiện tại</span>` : ''}</p>
    </div>
    <div class="ved-sec">
      ${field('Chữ trên đoạn này', `<textarea data-k="text" rows="3" maxlength="200" placeholder="Để trống nếu không cần. Xuống dòng được.">${escapeHtml(c.text)}</textarea>`)}
      ${field('Vị trí chữ', `<select data-k="textPos">${options(TEXT_POS_LABELS, c.textPos)}</select>`)}
      <p class="hint">Font, cỡ, màu chữ chỉnh ở tab <b>Chữ</b> (dùng chung cho mọi đoạn).</p>
    </div>
    <div class="ved-sec ved-row">
      <button class="btn small" type="button" data-act="dup">⧉ Nhân đôi</button>
      <button class="btn small" type="button" data-act="split">✂ Tách tại con trỏ</button>
      <button class="btn small danger" type="button" data-act="del">Xoá đoạn</button>
    </div>`;
  root.querySelector('[data-k="start"]').onchange = e => { c.start = round1(clamp(Number(e.target.value) || 0, 0, c.end - ED_MIN_CLIP)); commit(); seekToClip(c); };
  root.querySelector('[data-k="end"]').onchange = e => { c.end = round1(clamp(Number(e.target.value) || 0, c.start + ED_MIN_CLIP, c.duration)); commit(); seekToClip(c, true); };
  const ta = root.querySelector('[data-k="text"]');
  ta.oninput = () => { c.text = ta.value; renderTimelineText(); renderPreview(); };
  ta.onchange = () => commit();
  root.querySelector('[data-k="textPos"]').onchange = e => { c.textPos = e.target.value; commit(); };
  root.querySelector('[data-act="dup"]').onclick = () => { const copy = { ...c, id: newId() }; project.clips.splice(i + 1, 0, copy); selectedClipId = copy.id; commit(); };
  root.querySelector('[data-act="split"]').onclick = splitAtPlayhead;
  root.querySelector('[data-act="del"]').onclick = deleteSelected;
}

function renderTextProps() {
  const s = project.textStyle;
  const root = $('vPropsText');
  root.innerHTML = `
    <div class="ved-sec">
      <p class="section-title">Kiểu chữ chung</p>
      ${field('Font', `<select data-k="font">${options(edTools?.fonts || { arial: 'Arial đậm' }, s.font)}</select>`)}
      <div class="ved-grid2">
        ${field('Cỡ chữ (px)', `<input type="number" data-k="size" min="20" max="200" step="2" value="${s.size}">`)}
        ${field('Màu chữ', `<input type="color" data-k="color" value="${s.color}">`)}
      </div>
      ${field('Nền sau chữ', `<select data-k="box">${options({ dark: 'Nền tối mờ', light: 'Nền sáng mờ', none: 'Không nền, chỉ viền' }, s.box)}</select>`)}
      <p class="hint">Cỡ chữ tính theo kích thước video gốc (${projectSize().W}×${projectSize().H}). Chữ hiện dần / tắt dần ${ED_TEXT_FADE}s ở đầu và cuối đoạn. Không hiển thị được emoji.</p>
    </div>`;
  root.querySelector('[data-k="font"]').onchange = e => { s.font = e.target.value; commit(); };
  root.querySelector('[data-k="size"]').onchange = e => { s.size = clamp(Number(e.target.value) || 60, 20, 200); commit(); };
  root.querySelector('[data-k="color"]').oninput = e => { s.color = e.target.value; renderPreview(); };
  root.querySelector('[data-k="color"]').onchange = () => commit();
  root.querySelector('[data-k="box"]').onchange = e => { s.box = e.target.value; commit(); };
}

function renderProjectProps() {
  const p = project;
  const root = $('vPropsProject');
  const trs = edTools?.transitions || { fade: 'Mờ dần', none: 'Không' };
  root.innerHTML = `
    <div class="ved-sec">
      <p class="section-title">Chuyển cảnh & fade</p>
      ${field('Chuyển cảnh giữa các đoạn', `<select data-k="transition">${options(trs, p.transition)}</select>`)}
      <div class="ved-grid2">
        ${field('Thời gian chuyển (s)', `<input type="number" data-k="tDur" min="0.2" max="2" step="0.1" value="${p.tDur}" ${p.transition === 'none' ? 'disabled' : ''}>`)}
        <span></span>
        ${field('Hiện dần từ đen (s)', `<input type="number" data-k="fadeIn" min="0" max="3" step="0.1" value="${p.fadeIn}">`)}
        ${field('Mờ về đen cuối (s)', `<input type="number" data-k="fadeOut" min="0" max="3" step="0.1" value="${p.fadeOut}">`)}
      </div>
      <p class="hint">Xem trước mô phỏng đúng kiểu mờ dần / qua đen / qua trắng; các kiểu trượt, lau, vòng tròn chỉ thấy đúng ở bản xuất.</p>
    </div>
    <div class="ved-sec">
      <p class="section-title">Âm thanh</p>
      ${field('Tiếng gốc của video', `<select data-k="audio">${options({ keep: 'Giữ', mute: 'Tắt' }, p.audio)}</select>`)}
      <div class="field"><span>Nhạc nền</span>
        <span class="ved-file">
          <label class="btn small">🎵 Chọn file<input type="file" data-k="musicFile" accept="audio/mpeg,audio/mp4,audio/wav,audio/aac,.mp3,.m4a,.wav,.aac" hidden></label>
          <span class="nm">${p.music ? escapeHtml(p.music.name) : 'chưa có'}</span>
          ${p.music ? '<button class="link" type="button" data-act="musicClear">bỏ</button>' : ''}
        </span></div>
      ${field(`Âm lượng nhạc <output>${Math.round((p.music?.volume ?? 0.3) * 100)}%</output>`, `<input type="range" data-k="musicVol" min="0" max="1" step="0.05" value="${p.music?.volume ?? 0.3}" ${p.music ? '' : 'disabled'}>`)}
    </div>
    <div class="ved-sec">
      <p class="section-title">Logo / watermark</p>
      <div class="field"><span>Ảnh logo (PNG trong suốt là đẹp nhất)</span>
        <span class="ved-file">
          <label class="btn small">🖼 Chọn ảnh<input type="file" data-k="wmFile" accept="image/png,image/webp,image/jpeg" hidden></label>
          ${p.watermark ? `<img src="${p.watermark.url}" alt="Logo"><button class="link" type="button" data-act="wmClear">bỏ</button>` : '<span class="nm">chưa có</span>'}
        </span></div>
      <div class="ved-grid2">
        ${field('Vị trí', `<select data-k="wmPos" ${p.watermark ? '' : 'disabled'}>${options(WM_POS_LABELS, p.watermark?.pos || 'tr')}</select>`)}
        ${field('Cỡ (% chiều rộng)', `<input type="number" data-k="wmSize" min="5" max="60" step="1" value="${Math.round((p.watermark?.size ?? 0.18) * 100)}" ${p.watermark ? '' : 'disabled'}>`)}
      </div>
      ${field(`Độ đậm <output>${Math.round((p.watermark?.opacity ?? 0.85) * 100)}%</output>`, `<input type="range" data-k="wmOpacity" min="0.1" max="1" step="0.05" value="${p.watermark?.opacity ?? 0.85}" ${p.watermark ? '' : 'disabled'}>`)}
    </div>
    <div class="ved-sec">
      <p class="section-title">Xuất</p>
      ${field('Tên file', `<input type="text" data-k="name" maxlength="40" value="${escapeHtml(p.name)}" placeholder="VD: review-mu-rom">`)}
      <p class="hint">Video ra: ${projectSize().W}×${projectSize().H}, 30 fps, lưu vào outputs/videos/&lt;mũ&gt;/. ${edTools?.available ? `ffmpeg ${edTools.version}.` : '⚠ Chưa có ffmpeg.'}</p>
    </div>`;
  const on = (k, ev, fn) => { const el = root.querySelector(`[data-k="${k}"]`); if (el) el[ev] = fn; };
  on('transition', 'onchange', e => { p.transition = e.target.value; commit(); });
  on('tDur', 'onchange', e => { p.tDur = clamp(Number(e.target.value) || 0.5, 0.2, 2); commit(); });
  on('fadeIn', 'onchange', e => { p.fadeIn = clamp(Number(e.target.value) || 0, 0, 3); commit(); });
  on('fadeOut', 'onchange', e => { p.fadeOut = clamp(Number(e.target.value) || 0, 0, 3); commit(); });
  on('audio', 'onchange', e => { p.audio = e.target.value; commit(); });
  on('musicFile', 'onchange', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { const url = await uploadMedia(file); edUploads.unshift({ url, name: file.name, kind: 'audio' }); setMusic(url, file.name); }
    catch (err) { showMsg('err', 'Không tải được nhạc: ' + err.message); }
  });
  on('musicVol', 'oninput', e => { if (p.music) { p.music.volume = Number(e.target.value); e.target.closest('.field').querySelector('output').textContent = `${Math.round(p.music.volume * 100)}%`; renderPreview(); } });
  on('musicVol', 'onchange', () => commit());
  on('wmFile', 'onchange', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { const url = await uploadImage(file); p.watermark = { url, name: file.name, pos: p.watermark?.pos || 'tr', size: p.watermark?.size ?? 0.18, opacity: p.watermark?.opacity ?? 0.85 }; commit(); }
    catch (err) { showMsg('err', 'Không tải được logo: ' + err.message); }
  });
  on('wmPos', 'onchange', e => { p.watermark.pos = e.target.value; commit(); });
  on('wmSize', 'onchange', e => { p.watermark.size = clamp(Number(e.target.value) || 18, 5, 60) / 100; commit(); });
  on('wmOpacity', 'oninput', e => { p.watermark.opacity = Number(e.target.value); e.target.closest('.field').querySelector('output').textContent = `${Math.round(p.watermark.opacity * 100)}%`; renderPreview(); });
  on('wmOpacity', 'onchange', () => commit());
  on('name', 'onchange', e => { p.name = e.target.value; saveProject(); });
  const clearBtn = act => root.querySelector(`[data-act="${act}"]`);
  if (clearBtn('musicClear')) clearBtn('musicClear').onclick = () => { p.music = null; commit(); };
  if (clearBtn('wmClear')) clearBtn('wmClear').onclick = () => { p.watermark = null; commit(); };
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }

// ---------- editing commands ----------
function deleteSelected() {
  const c = selectedClip();
  if (!c) return;
  project.clips = project.clips.filter(x => x !== c);
  selectedClipId = null;
  commit();
}
function splitAtPlayhead() {
  const t = pv.t;
  const seg = segments().find(s => t > s.tIn + ED_MIN_CLIP && t < s.tOut - ED_MIN_CLIP);
  if (!seg) { showMsg('warn', 'Đặt con trỏ vào giữa một đoạn (cách mỗi đầu ít nhất 0,5 giây) rồi bấm Tách.'); return; }
  const cut = round1(seg.clip.start + (t - seg.tIn));
  const right = { ...seg.clip, id: newId(), start: cut, text: '' };
  seg.clip.end = cut;
  project.clips.splice(seg.i + 1, 0, right);
  selectedClipId = right.id;
  commit();
}
function seekToClip(c, atEnd = false) {
  const seg = segments().find(s => s.clip === c);
  if (seg) seekTo(atEnd ? Math.max(seg.tIn, seg.tOut - 0.05) : seg.tIn + 0.02);
}

// ---------- timeline ----------
function fitZoom() {
  const total = totalDur();
  const avail = ($('vTlScroll')?.clientWidth || 800) - 90;
  if (total > 0 && avail > 100) { pxPerSec = clamp(Math.floor(avail / total), 15, 260); $('vZoom').value = pxPerSec; }
}
const tlX = t => t * pxPerSec;

function renderTimeline() {
  if (!project || !$('vRuler')) return;
  const total = totalDur();
  const T = tDur();
  const segs = segments();
  const width = Math.max(($('vTlScroll').clientWidth || 600) - 56, tlX(total) + 160);
  $('vTlInner').style.width = `${width + 56}px`;

  // ruler
  const ruler = $('vRuler');
  ruler.innerHTML = '';
  ruler.style.width = `${width}px`;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  const major = steps.find(s => s * pxPerSec >= 70) || 60;
  const minor = major / (major >= 1 ? 5 : 2);
  for (let t = 0; t <= width / pxPerSec; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const tick = document.createElement('span');
    tick.className = 'tick' + (isMajor ? '' : ' minor');
    tick.style.left = `${tlX(t)}px`;
    if (isMajor) tick.textContent = fmtClock(t).replace(/\.0$/, '');
    ruler.appendChild(tick);
  }

  // video track
  const track = $('vTrackVideo');
  track.querySelectorAll('.ved-clip, .ved-tr').forEach(el => el.remove());
  for (const seg of segs) {
    const el = document.createElement('div');
    el.className = 'ved-clip' + (seg.clip.id === selectedClipId ? ' selected' : '');
    el.style.left = `${tlX(seg.tIn)}px`;
    el.style.width = `${Math.max(14, tlX(seg.len))}px`;
    el.dataset.id = seg.clip.id;
    el.title = `${seg.clip.name} · ${fmtSec(seg.len)}`;
    const strip = document.createElement('div');
    strip.className = 'thumbs';
    const th = thumbs.get(seg.clip.url);
    if (th && th !== 'pending' && th.frames.length) {
      const slotW = th.w, slots = Math.ceil(tlX(seg.len) / slotW) + 1;
      for (let k = 0; k < slots; k++) {
        const t = seg.clip.start + (k + 0.5) * (seg.len / slots);
        const f = th.frames.reduce((best, fr) => (Math.abs(fr.t - t) < Math.abs(best.t - t) ? fr : best), th.frames[0]);
        const img = document.createElement('img');
        img.src = f.src; img.alt = ''; img.draggable = false;
        strip.appendChild(img);
      }
    }
    el.appendChild(strip);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `${seg.i + 1}. ${seg.clip.name} · ${fmtSec(seg.len)}`;
    el.appendChild(label);
    for (const side of ['l', 'r']) {
      const h = document.createElement('div');
      h.className = `handle ${side}`;
      h.onpointerdown = e => startTrim(e, seg.clip, side);
      el.appendChild(h);
    }
    el.onpointerdown = e => startClipDrag(e, seg);
    track.appendChild(el);
    if (seg.i > 0 && T > 0) {
      const badge = document.createElement('div');
      badge.className = 'ved-tr';
      badge.textContent = '⇄';
      badge.title = `Chuyển cảnh ${T}s`;
      badge.style.left = `${tlX(seg.tIn + T / 2)}px`;
      track.appendChild(badge);
    }
  }

  renderTimelineText();

  // audio track
  const audio = $('vTrackAudio');
  audio.querySelectorAll('.ved-audio').forEach(el => el.remove());
  if (project.music && total > 0) {
    const el = document.createElement('div');
    el.className = 'ved-audio';
    el.style.width = `${tlX(total)}px`;
    el.title = `${project.music.name} · ${Math.round(project.music.volume * 100)}%`;
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `♪ ${project.music.name} · ${Math.round(project.music.volume * 100)}%`;
    el.appendChild(label);
    el.onclick = () => openPropsTab('project');
    audio.appendChild(el);
    drawWave(canvas, project.music.url, total);
  }
  $('vTlInfo').textContent = segs.length ? `${segs.length} đoạn · ${fmtClock(total)}${segs.length > 1 && T ? ` · chuyển cảnh ${T}s` : ''}` : '';
  $('vTotal').textContent = fmtClock(total);
  renderPlayhead();
}

function renderTimelineText() {
  const track = $('vTrackText');
  track.querySelectorAll('.ved-textblock').forEach(el => el.remove());
  for (const seg of segments()) {
    if (!seg.clip.text.trim()) continue;
    const el = document.createElement('div');
    el.className = 'ved-textblock' + (seg.clip.id === selectedClipId ? ' selected' : '');
    el.style.left = `${tlX(seg.tIn)}px`;
    el.style.width = `${Math.max(14, tlX(seg.len))}px`;
    el.textContent = 'T ' + seg.clip.text.replace(/\s+/g, ' ');
    el.title = seg.clip.text;
    el.onclick = () => { selectedClipId = seg.clip.id; openPropsTab('clip'); renderTimeline(); renderProps(); };
    track.appendChild(el);
  }
}

function drawWave(canvas, url, total) {
  const w = waves.get(url);
  if (!w || w === 'pending') { ensureWave(url); return; }
  const cw = Math.max(1, Math.floor(tlX(total))), ch = 40;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--accent') || '#2f6fde';
  if (!w.peaks || !w.duration) { ctx.globalAlpha = .3; ctx.fillRect(0, ch / 2 - 1, cw, 2); return; }
  ctx.globalAlpha = .75;
  const secPerPx = 1 / pxPerSec;
  for (let x = 0; x < cw; x++) {
    const t = (x * secPerPx) % w.duration;
    const idx = Math.min(w.peaks.length - 1, Math.floor((t / w.duration) * w.peaks.length));
    const h = Math.max(1, w.peaks[idx] * (ch - 6));
    ctx.fillRect(x, (ch - h) / 2, 1, h);
  }
}

function renderPlayhead() {
  const ph = $('vPlayhead');
  if (ph) ph.style.left = `${56 + tlX(pv.t)}px`;
  $('vCur').textContent = fmtClock(pv.t);
}
function scrollPlayheadIntoView(center = false) {
  const sc = $('vTlScroll');
  const x = 56 + tlX(pv.t);
  if (center) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
  else if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 80;
  else if (x < sc.scrollLeft + 56) sc.scrollLeft = Math.max(0, x - 80);
}

// drag: trim handles
function startTrim(e, clip, side) {
  e.stopPropagation(); e.preventDefault();
  const x0 = e.clientX, s0 = clip.start, e0 = clip.end;
  selectedClipId = clip.id;
  openPropsTab('clip');
  const move = ev => {
    const d = (ev.clientX - x0) / pxPerSec;
    if (side === 'l') clip.start = round1(clamp(s0 + d, 0, clip.end - ED_MIN_CLIP));
    else clip.end = round1(clamp(e0 + d, clip.start + ED_MIN_CLIP, clip.duration));
    renderTimeline(); renderClipProps();
    seekToClip(clip, side === 'r');
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// drag: move a clip to another position (click = select)
function startClipDrag(e, seg) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  const x0 = e.clientX;
  let dragging = false, marker = null, target = seg.i;
  const track = $('vTrackVideo');
  const move = ev => {
    if (!dragging && Math.abs(ev.clientX - x0) < 6) return;
    if (!dragging) { dragging = true; el.classList.add('dragging'); marker = document.createElement('div'); marker.className = 'ved-insert'; track.appendChild(marker); }
    const rect = track.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const segs = segments();
    target = segs.length;
    for (const s of segs) { if (x < tlX(s.tIn + s.len / 2)) { target = s.i; break; } }
    const edge = target >= segs.length ? segs.at(-1).tOut : segs[target].tIn + (target ? tDur() / 2 : 0);
    marker.style.left = `${tlX(edge)}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    el.classList.remove('dragging'); marker?.remove();
    selectedClipId = seg.clip.id;
    openPropsTab('clip');
    if (dragging && target !== seg.i && target !== seg.i + 1) {
      const [clip] = project.clips.splice(seg.i, 1);
      project.clips.splice(target > seg.i ? target - 1 : target, 0, clip);
      commit();
    } else { renderTimeline(); renderProps(); if (!dragging) seekToClip(seg.clip); }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// click / drag on the ruler or empty track area = seek
function setupScrub() {
  const inner = $('vTlInner');
  inner.onpointerdown = e => {
    if (e.target.closest('.ved-clip, .ved-textblock, .ved-audio')) return;
    const toT = ev => { const rect = inner.getBoundingClientRect(); return clamp((ev.clientX - rect.left - 56) / pxPerSec, 0, totalDur()); };
    const wasPlaying = pv.playing;
    if (wasPlaying) pause();
    seekTo(toT(e));
    const move = ev => seekTo(toT(ev));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (wasPlaying) play(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}

// ---------- preview ----------
const pv = { t: 0, playing: false, raf: 0, last: 0 };

function fitStage() {
  const stage = $('vStage'), frame = $('vFrame');
  if (!stage || !frame) return;
  const { W, H } = projectSize();
  const aw = stage.clientWidth - 20, ah = stage.clientHeight - 20;
  if (aw <= 0 || ah <= 0) return;
  const scale = Math.min(aw / W, ah / H);
  frame.style.width = `${Math.floor(W * scale)}px`;
  frame.style.height = `${Math.floor(H * scale)}px`;
  $('vSize').textContent = `${W}×${H}`;
  renderPreview();
}
const frameScale = () => ($('vFrame').clientWidth || 1) / projectSize().W;

function assignClip(el, clip) {
  if (el.dataset.id === clip.id) return;
  el.dataset.id = clip.id;
  if (el.dataset.url === clip.url) return;
  el.dataset.url = clip.url;
  if (isStillUrl(clip.url)) {
    // a still image: shown as the poster of an empty <video>
    el.dataset.still = '1';
    el.pause(); el.removeAttribute('src'); el.load();
    el.poster = clip.url;
  } else {
    delete el.dataset.still;
    el.removeAttribute('poster');
    el.src = clip.url;
  }
}
function syncTime(el, want, force) {
  if (!Number.isFinite(want) || !el.dataset.url || el.dataset.still) return;
  if (force || Math.abs(el.currentTime - want) > 0.2) { try { el.currentTime = Math.max(0, want); } catch { /* not ready yet */ } }
}
const playEl = el => { if (el.paused && el.dataset.url && !el.dataset.still) el.play().catch(() => {}); };
const pauseEl = el => { if (!el.paused) el.pause(); };

function renderPreview(force = false) {
  const A = $('pvA'), B = $('pvB');
  if (!A || !project) return;
  const segs = segments();
  const total = totalDur();
  $('pvEmpty').hidden = segs.length > 0;
  if (!segs.length) {
    for (const el of [A, B]) { pauseEl(el); el.style.opacity = 0; delete el.dataset.id; }
    $('pvTextA').hidden = $('pvTextB').hidden = true;
    $('pvFade').style.opacity = 0;
    $('pvWm').hidden = true;
    pauseEl($('pvMusic'));
    return;
  }
  const t = clamp(pv.t, 0, total);
  let ci = 0;
  for (let i = 0; i < segs.length; i++) if (segs[i].tIn <= t) ci = i;
  const cur = segs[ci], nxt = segs[ci + 1];
  const T = tDur();
  const inTr = Boolean(nxt) && T > 0 && t >= nxt.tIn;
  const p = inTr ? clamp((t - nxt.tIn) / T, 0, 1) : 0;

  // keep whichever element already holds the current clip; the other preloads the next one
  let elCur = A.dataset.id === cur.clip.id ? A : B.dataset.id === cur.clip.id ? B : null;
  if (!elCur) { elCur = (nxt && A.dataset.id === nxt.clip.id) ? B : A; assignClip(elCur, cur.clip); }
  const elNext = elCur === A ? B : A;
  if (nxt) assignClip(elNext, nxt.clip); else { delete elNext.dataset.id; pauseEl(elNext); }
  syncTime(elCur, cur.clip.start + (t - cur.tIn), force);
  if (nxt) syncTime(elNext, nxt.clip.start + Math.max(0, t - nxt.tIn), force || !inTr);

  elCur.style.zIndex = 1; elNext.style.zIndex = 2;
  elCur.style.opacity = 1;
  const fadeEl = $('pvFade');
  let overlay = 0, overlayColor = '#000';
  if (inTr && (project.transition === 'fadeblack' || project.transition === 'fadewhite')) {
    overlayColor = project.transition === 'fadeblack' ? '#000' : '#fff';
    overlay = p < 0.5 ? p * 2 : (1 - p) * 2;
    elNext.style.opacity = p >= 0.5 ? 1 : 0;
  } else {
    elNext.style.opacity = inTr ? p : 0;
  }
  let fade = 0;
  if (project.fadeIn > 0) fade = Math.max(fade, 1 - t / project.fadeIn);
  if (project.fadeOut > 0) fade = Math.max(fade, (t - (total - project.fadeOut)) / project.fadeOut);
  if (fade > 0) { fadeEl.style.background = '#000'; fadeEl.style.opacity = clamp(fade, 0, 1); }
  else { fadeEl.style.background = overlayColor; fadeEl.style.opacity = overlay; }

  renderTextOverlay($('pvTextA'), cur, t);
  renderTextOverlay($('pvTextB'), inTr ? nxt : null, t);
  renderWatermark();

  const keep = project.audio !== 'mute';
  elCur.muted = !keep; elNext.muted = !keep;
  elCur.volume = clamp(inTr ? 1 - p : 1, 0, 1); elNext.volume = clamp(inTr ? p : 0, 0, 1);
  if (pv.playing) { playEl(elCur); if (inTr) playEl(elNext); else pauseEl(elNext); }
  else { pauseEl(elCur); pauseEl(elNext); }

  const m = $('pvMusic');
  if (project.music) {
    if (m.dataset.url !== project.music.url) { m.dataset.url = project.music.url; m.src = project.music.url; }
    m.volume = clamp(project.music.volume, 0, 1);
    if (m.duration) { const want = t % m.duration; if (force || Math.abs(m.currentTime - want) > 0.35) m.currentTime = want; }
    if (pv.playing) playEl(m); else pauseEl(m);
  } else { pauseEl(m); delete m.dataset.url; m.removeAttribute('src'); }
}

function renderTextOverlay(el, seg, t) {
  if (!seg || !seg.clip.text.trim()) { el.hidden = true; return; }
  const s = project.textStyle;
  const scale = frameScale();
  const local = t - seg.tIn;
  const alpha = clamp(Math.min(local / ED_TEXT_FADE, (seg.len - local) / ED_TEXT_FADE, 1), 0, 1);
  el.hidden = false;
  el.textContent = seg.clip.text;
  el.dataset.pos = seg.clip.textPos || 'bottom';
  Object.assign(el.style, {
    opacity: alpha, fontFamily: ED_FONT_FAMILY[s.font] || ED_FONT_FAMILY.arial, fontSize: `${s.size * scale}px`, color: s.color,
    lineHeight: 1.2, padding: `${s.size * 0.35 * scale}px`,
    background: s.box === 'dark' ? 'rgba(0,0,0,.45)' : s.box === 'light' ? 'rgba(255,255,255,.65)' : 'transparent',
    textShadow: s.box === 'none' ? '0 0 2px #000, 0 0 2px #000, 1px 1px 0 #000' : 'none',
  });
}
function renderWatermark() {
  const img = $('pvWm');
  const wm = project.watermark;
  if (!wm) { img.hidden = true; return; }
  const { W, H } = projectSize();
  const scale = frameScale();
  const margin = Math.round(Math.min(W, H) * 0.03) * scale;
  img.hidden = false;
  if (img.getAttribute('src') !== wm.url) img.src = wm.url;
  Object.assign(img.style, { width: `${W * wm.size * scale}px`, opacity: wm.opacity, top: '', bottom: '', left: '', right: '' });
  img.style[wm.pos.startsWith('t') ? 'top' : 'bottom'] = `${margin}px`;
  img.style[wm.pos.endsWith('l') ? 'left' : 'right'] = `${margin}px`;
}

function play() {
  if (!totalDur()) return;
  if (pv.t >= totalDur() - 0.02) pv.t = 0;
  pv.playing = true;
  pv.last = performance.now();
  $('vPlay').textContent = '⏸';
  renderPreview(true);
  loop();
}
function loop() {
  pv.raf = requestAnimationFrame(now => {
    if (!pv.playing) return;
    pv.t = Math.min(totalDur(), pv.t + (now - pv.last) / 1000);
    pv.last = now;
    if (pv.t >= totalDur()) { pause(); return; }
    renderPreview();
    renderPlayhead();
    scrollPlayheadIntoView();
    loop();
  });
}
function pause() {
  pv.playing = false;
  cancelAnimationFrame(pv.raf);
  if ($('vPlay')) $('vPlay').textContent = '▶';
  renderPreview();
  renderPlayhead();
}
function seekTo(t) {
  pv.t = clamp(t, 0, totalDur());
  renderPreview(true);
  renderPlayhead();
}

// ---------- export ----------
function exportRequest() {
  const s = project.textStyle;
  return {
    productId: state.productId, name: project.name,
    clips: project.clips.map(c => ({ file: c.url, start: c.start, end: c.end, text: { content: c.text, position: c.textPos } })),
    transition: { type: project.transition, duration: Number(project.tDur) },
    fadeIn: Number(project.fadeIn), fadeOut: Number(project.fadeOut),
    textStyle: { font: s.font, size: Number(s.size), color: s.color, box: s.box !== 'none', boxColor: s.box === 'light' ? '#ffffff' : '#000000', boxAlpha: s.box === 'light' ? 0.65 : 0.45 },
    audio: project.audio,
    music: project.music ? { file: project.music.url, volume: Number(project.music.volume) } : null,
    watermark: project.watermark ? { file: project.watermark.url, position: project.watermark.pos, size: project.watermark.size, opacity: project.watermark.opacity } : null,
  };
}

async function startExport() {
  if (!project.clips.length) { showMsg('warn', 'Chưa có đoạn nào trên timeline.'); return; }
  const bad = segments().find(s => s.len < minLenFor(s.i));
  if (bad) { selectedClipId = bad.clip.id; renderTimeline(); renderProps(); openPropsTab('clip'); showMsg('err', `Đoạn ${bad.i + 1} quá ngắn cho chuyển cảnh hiện tại — kéo dài đoạn hoặc giảm thời gian chuyển.`); return; }
  pause();
  try {
    edJob = await api('/api/edit', exportRequest());
    renderExport();
    pollExport();
  } catch (e) { showMsg('err', 'Không xuất được: ' + e.message); }
}
async function pollExport() {
  clearTimeout(edPollTimer);
  if (!edJob) return;
  try { edJob = await api(`/api/edit?id=${encodeURIComponent(edJob.id)}`); }
  catch (e) { showMsg('err', e.message); edJob = null; }
  renderExport();
  if (edJob?.running) edPollTimer = setTimeout(pollExport, 1200);
  else if (edJob?.status === 'done') { showMsg('info', `🎞 Xuất xong: ${fileNameOf(edJob.output)} (${fmtSec(edJob.total)}).`); refreshVideos(); }
}
function renderExport() {
  const box = $('vExportBox');
  const j = edJob;
  box.hidden = !j;
  if (!j) return;
  if (!box.dataset.id || box.dataset.id !== j.id) {
    box.dataset.id = j.id;
    box.innerHTML = `<div class="ved-export-card"><h3></h3><div class="bar"><i></i></div><p class="pct"></p><div class="body"></div><div class="acts"></div></div>`;
  }
  const card = box.querySelector('.ved-export-card');
  card.querySelector('h3').textContent = j.running ? 'Đang xuất video…' : j.status === 'done' ? 'Xuất xong' : j.status === 'cancelled' ? 'Đã dừng' : 'Xuất lỗi';
  card.querySelector('.bar i').style.width = `${j.progress || 0}%`;
  card.querySelector('.pct').textContent = j.running ? `${j.progress || 0}% · ${j.clips} đoạn · ${fmtSec(j.total)}` : '';
  const body = card.querySelector('.body'), acts = card.querySelector('.acts');
  if (j.running) {
    body.innerHTML = '';
    acts.innerHTML = '<button class="btn small" type="button" data-act="cancel">Dừng</button>';
    acts.querySelector('[data-act="cancel"]').onclick = async () => { try { edJob = await api('/api/edit/cancel', { id: j.id }); renderExport(); } catch (e) { showMsg('err', e.message); } };
    return;
  }
  if (j.status === 'done' && body.dataset.url !== j.output) {
    body.dataset.url = j.output;
    body.innerHTML = '<video controls playsinline></video><p class="hint"></p>';
    body.querySelector('video').src = j.output;
    body.querySelector('p').textContent = fileNameOf(j.output);
    acts.innerHTML = '';
    const dl = document.createElement('a');
    dl.className = 'btn small primary'; dl.href = `${j.output}?download=1`; dl.download = fileNameOf(j.output); dl.textContent = '⬇ Tải về';
    acts.appendChild(dl);
    if (edTelegram) {
      const tg = document.createElement('button');
      tg.type = 'button'; tg.className = 'btn small'; tg.textContent = '✈ Gửi Telegram';
      tg.onclick = async () => {
        const caption = prompt('Chú thích khi gửi (có thể để trống):', '');
        if (caption === null) return;
        tg.disabled = true;
        try {
          const r = await api('/api/telegram/send', { files: [j.output], caption });
          const failed = r.results.find(x => !x.ok);
          showMsg(failed ? 'err' : 'info', failed ? `Gửi lỗi: ${failed.error}` : '✈ Đã gửi video lên Telegram.');
        } catch (e) { showMsg('err', 'Gửi Telegram thất bại: ' + e.message); }
        finally { tg.disabled = false; }
      };
      acts.appendChild(tg);
    }
  } else if (j.status !== 'done') {
    body.innerHTML = `<p class="err">${escapeHtml(j.error || '')}</p>`;
    acts.innerHTML = '';
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'btn small'; close.textContent = 'Đóng';
  close.onclick = () => { edJob = null; box.hidden = true; delete box.dataset.id; };
  acts.appendChild(close);
}

/**
 * Called by studio.html / story-ui.js: put media on the timeline, in order.
 * items: URLs or { url, text } (text = the clip's caption). opts.replace: offer to clear the timeline first.
 */
async function addToEditor(items, opts = {}) {
  await loadProjectFor(state.productId);
  if (opts.replace && project.clips.length && confirm(`Timeline đang có ${project.clips.length} đoạn. Xoá chúng và thay bằng phim mới?
(Bấm Huỷ để nối thêm vào cuối.)`)) {
    project.clips = [];
    commit();
  }
  if (opts.name) project.name = opts.name;
  let added = 0;
  for (const it of items) {
    const { url, text = '' } = typeof it === 'string' ? { url: it } : it;
    const before = project.clips.length;
    await addClip(url, fileNameOf(url), text);
    if (project.clips.length > before) added++;
  }
  if (added) showMsg('info', `🎞 Đã thêm ${added} đoạn vào timeline Ghép video.`);
  return added;
}

// ---------- wiring ----------
/** Called by studio.html whenever the selected hat's videos are (re)loaded. */
function renderEditSources() {
  if (!$('vLibList')) return;
  loadProjectFor(state.productId).then(renderLibrary);
}
/** Called by openTab when the tab becomes visible (sizes are 0 while hidden). */
function onEditorShown() {
  requestAnimationFrame(() => { fitStage(); if (totalDur()) fitZoom(); renderTimeline(); });
}

function setupKeys() {
  document.addEventListener('keydown', e => {
    const root = $('editorRoot');
    if (!root || root.offsetParent === null) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); pv.playing ? pause() : play(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if ((ctrl && e.key.toLowerCase() === 'y') || (ctrl && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); redo(); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(totalDur()); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(pv.t - (e.shiftKey ? 1 : 1 / 30)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(pv.t + (e.shiftKey ? 1 : 1 / 30)); }
    else if (e.key.toLowerCase() === 's' && !ctrl) { e.preventDefault(); splitAtPlayhead(); }
  });
}

async function initEditor() {
  buildEditorDom();
  try { edTools = await api('/api/edit/tools'); }
  catch (e) { edTools = { available: false, error: e.message, transitions: { fade: 'Mờ dần', none: 'Không' }, fonts: { arial: 'Arial đậm' } }; }
  api('/api/telegram').then(t => { edTelegram = Boolean(t.enabled); }).catch(() => {});
  if (!edTools.available) showMsg('warn', `Ghép video: ${edTools.error || 'chưa có ffmpeg'}. Cài bằng "winget install Gyan.FFmpeg" rồi khởi động lại GUI.`);

  for (const b of document.querySelectorAll('.ptab')) b.onclick = () => openPropsTab(b.dataset.ptab);
  $('vLibUpload').onchange = async () => {
    for (const file of $('vLibUpload').files) {
      try {
        const url = await uploadMedia(file);
        edUploads.unshift({ url, name: file.name, kind: /^audio\//.test(file.type) || /\.(mp3|m4a|wav|aac)$/i.test(file.name) ? 'audio' : 'video' });
      } catch (e) { showMsg('err', `Không tải được ${file.name}: ${e.message}`); }
    }
    $('vLibUpload').value = '';
    renderLibrary();
  };
  $('vPlay').onclick = () => (pv.playing ? pause() : play());
  $('vToStart').onclick = () => seekTo(0);
  $('vExport').onclick = startExport;
  $('vUndo').onclick = undo;
  $('vRedo').onclick = redo;
  $('vSplit').onclick = splitAtPlayhead;
  $('vDelete').onclick = deleteSelected;
  $('vZoom').oninput = () => { pxPerSec = Number($('vZoom').value); renderTimeline(); };
  setupScrub();
  setupKeys();
  for (const id of ['pvA', 'pvB']) { const el = $(id); el.onloadedmetadata = () => renderPreview(true); el.onended = () => renderPreview(); }
  $('pvMusic').onloadedmetadata = () => renderPreview(true);
  new ResizeObserver(() => fitStage()).observe($('vStage'));

  await loadProjectFor(state.productId);
  // A render still running on the server (page reload) — show it again
  api('/api/edit').then(j => { if (j?.running) { edJob = j; renderExport(); pollExport(); } }).catch(() => {});
}
