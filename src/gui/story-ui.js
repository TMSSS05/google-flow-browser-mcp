// Hat Studio — "📖 Truyện" tab: cartoon fruit stories.
// 1) cast of fruit characters (Gemini draws a reference sheet), 2) Gemini writes the script as scenes,
// 3) Flow draws each scene with the characters' sheets as references, 4) Flow animates each scene
// (image → video, optional Vietnamese dialogue), 5) the clips go to the "Ghép video" timeline.
// Uses studio.html globals: $, api, showMsg, readStore, writeStore, uploadImage, onPasteImage,
// activeBatch, renderBatch, openTab; and editor.js's addToEditor.

const STORIES_KEY = 'hatStudio.stories';
const STORY_CUR_KEY = 'hatStudio.storyCurrent';

const STORY_STYLES = {
  fruithead: { anim: 'Hyper-realistic cinematic live-action', head: true, label: '🎬 Điện ảnh siêu thực (đầu quả, thân người)', text: 'hyper-realistic cinematic film still, photorealistic 3D render, characters are humans whose heads are giant realistic fruits with real fruit skin texture, pores, seeds and leaves, and expressive human facial features (eyes, brows, nose, lips) sculpted naturally into the fruit, realistic human bodies in elegant clothes, dramatic moody movie lighting, shallow depth of field, rich film color grading, telenovela drama mood' },
  cartoon2d: { anim: '2D cartoon', label: '2D hoạt hình (nét đậm)', text: '2D cartoon illustration, bold clean outlines, vibrant flat colors with soft shading, cute anthropomorphic fruit characters with big expressive eyes and rosy cheeks, warm cozy colors' },
  anim3d: { anim: '3D animated film', label: '3D phim hoạt hình', text: '3D animated feature film style, soft global illumination, smooth glossy materials, cute anthropomorphic fruit characters with big expressive eyes, cinematic lighting' },
  clay: { anim: 'Claymation stop-motion', label: 'Đất nặn (claymation)', text: 'claymation stop-motion style, handmade clay textures with fingerprints, miniature set, soft studio lighting, cute anthropomorphic fruit characters' },
  storybook: { anim: 'Watercolor storybook', label: 'Tranh truyện màu nước', text: "children's storybook illustration, soft watercolor and colored pencil textures, gentle pastel colors, cute anthropomorphic fruit characters" },
  anime: { anim: 'Anime', label: 'Anime', text: 'Japanese anime style, clean cel shading, bright colors, expressive chibi anthropomorphic fruit characters' },
};
const STORY_TONES = ['hài hước', 'dễ thương, ấm áp', 'drama gia đình, có twist', 'lãng mạn', 'bài học cho trẻ em', 'kinh dị nhẹ, hài'];
const FRUITS = [
  ['🥑', 'Bơ', 'avocado'], ['🍌', 'Chuối', 'banana'], ['🍉', 'Dưa hấu', 'watermelon'], ['🍊', 'Cam', 'orange'],
  ['🥭', 'Xoài', 'mango'], ['🍓', 'Dâu tây', 'strawberry'], ['🍎', 'Táo', 'apple'], ['🍇', 'Nho', 'grape'],
  ['🍍', 'Dứa', 'pineapple'], ['🍋', 'Chanh', 'lemon'], ['🍅', 'Cà chua', 'tomato'], ['🥕', 'Cà rốt', 'carrot'],
  ['🥥', 'Dừa', 'coconut'], ['🍈', 'Sầu riêng', 'durian'], ['🍑', 'Đào', 'peach'], ['🐉', 'Thanh long', 'dragon fruit'],
];
// Outfit quick picks: [label, Vietnamese description shown in the box, English for the prompt]
const ST_OUTFITS = [
  ['Áo dài đỏ', 'áo dài đỏ thêu hoa, khăn vấn cùng màu', 'a red Vietnamese ao dai with floral embroidery and a matching khan dong headband'],
  ['Sơ mi + quần tây', 'sơ mi trắng sơ vin, quần tây tối màu, thắt lưng, giày đen bóng', 'a white button-up shirt tucked into dark trousers with a belt, shiny black shoes'],
  ['Áo bà ba + nón lá', 'áo bà ba truyền thống, quần ống rộng, đội nón lá', 'a traditional Vietnamese ao ba ba blouse with loose trousers and a conical non la hat'],
  ['Váy hoa', 'váy hoa xinh xắn có nơ, đi sandal', 'a cute floral sundress with a ribbon and sandals'],
  ['Đồ công sở', 'áo vest công sở gọn gàng, chân váy bút chì hoặc quần âu, đeo thẻ nhân viên', 'a neat office blazer with a pencil skirt or slacks and a lanyard ID badge'],
  ['Áo thun + jean', 'áo thun, quần jean xanh, giày thể thao', 'a casual t-shirt, blue jeans and sneakers'],
  ['Vest + cà vạt', 'bộ vest may đo, cà vạt, giày da bóng', 'a tailored suit with a tie and polished shoes'],
  ['Đồng phục học sinh', 'đồng phục học sinh: áo sơ mi trắng, khăn quàng đỏ, quần/váy xanh than, cặp sách', 'a Vietnamese school uniform: white shirt, red scarf, navy trousers or skirt, backpack'],
  ['Đồ thể thao', 'bộ đồ thể thao, băng đô, giày chạy bộ', 'a sporty tracksuit with a headband and running shoes'],
  ['Đồ ngủ', 'bộ đồ ngủ kẻ sọc, dép bông', 'cozy striped pajamas and fluffy slippers'],
  ['Tạp dề bán hàng', 'áo cánh đơn giản, đeo tạp dề như cô bán hàng rong', 'a simple blouse with an apron, like a street food vendor'],
  ['Áo khoác + mũ len', 'áo khoác phao, khăn quàng cổ, mũ len', 'a puffy winter jacket, a scarf and a knitted beanie'],
];
const DIALOG_LANGS = { vi: 'Tiếng Việt', en: 'English' };
const VOICE_MODES = {
  speak: '🗣 Nhân vật nói thoại (AI lồng tiếng)',
  subs: '💬 Không tiếng, thoại thành phụ đề khi ghép',
  none: '🔇 Không thoại',
};

let stories = [];
let story = null;
let stOpts = { models: [], ratios: ['9:16', '16:9'], video: { models: [], credits: {}, ratios: ['9:16', '16:9'] } };
let stPollTimer = null;
let stBusy = '';      // what is running right now (shown on the buttons)
let stImportOpen = false;
let stJsonMode = 'import'; // 'import' (paste from elsewhere) | 'edit' (edit this story's own JSON)
const stPasteStops = [];

/** Outfits saved on the hat page ("Trang phục" with a sample photo) — shared library. */
const stLibraryOutfits = () => ((typeof studio === 'object' && studio?.presets?.outfits) || []).filter(o => o && o.id);
const stId = p => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fruitEn = vi => FRUITS.find(f => f[1].toLowerCase() === String(vi || '').trim().toLowerCase())?.[2] || String(vi || '').trim();
const styleText = () => (story.style === 'custom' ? story.customStyle.trim() : STORY_STYLES[story.style]?.text) || STORY_STYLES.cartoon2d.text;

function newStory() {
  return {
    id: stId('s'), title: 'Truyện mới', style: 'cartoon2d', customStyle: '', ratio: '9:16', voice: 'speak',
    idea: '', tone: STORY_TONES[0], sceneCount: 5, imageModel: '', videoModel: '', duration: 8,
    cast: [], scenes: [], job: null, logline: '', outline: [], notes: [], fixNote: '', lang: 'vi', filmParts: 2, film: '', filmSeconds: 0, rules: '', negative: '',
  };
}
function saveStories() {
  if (story) stories = stories.map(s => (s.id === story.id ? story : s));
  writeStore(STORIES_KEY, stories);
  writeStore(STORY_CUR_KEY, story?.id || '');
}
function loadStories() {
  stories = (readStore(STORIES_KEY, []) || []).filter(s => s && s.id);
  const cur = readStore(STORY_CUR_KEY, '');
  story = stories.find(s => s.id === cur) || stories[0] || null;
  if (!story) { story = newStory(); stories.push(story); }
  story = { ...newStory(), ...story };
}

// ---------- Vietnamese → English (for Flow) ----------
// Boxes are written in Vietnamese; prompts use the English translation, cached per text.
const TR_KEY = 'hatStudio.storyTr';
let trCache = null;
const trStore = () => (trCache ||= readStore(TR_KEY, {}) || {});
const needsEn = t => /[^ -~\s]/.test(String(t || ''));
/** English for a box's text (the cached translation; the text itself when it's already English). */
const toEn = t => { const k = String(t || '').trim(); return needsEn(k) ? (trStore()[k] || k) : k; };
function seedEn(vi, en) { if (vi && en) { trStore()[vi.trim()] = en.trim(); writeStore(TR_KEY, trStore()); } }
/** Translate every Vietnamese text the prompts of these scenes use (once per text). */
async function prepareEnglish(scenes) {
  const texts = new Set();
  for (const sc of scenes) {
    for (const k of ['setting', 'action', 'camera']) texts.add(sc[k]);
    for (const c of sceneCast(sc)) { for (const k of ['look', 'outfit', 'voice']) texts.add(c[k]); for (const r of listOf(c.rules)) texts.add(r); }
  }
  for (const r of [...storyRules(), ...storyAvoid()]) texts.add(r);
  const todo = [...texts].map(t => String(t || '').trim()).filter(t => t && needsEn(t) && !trStore()[t]);
  for (const t of todo) {
    const { text } = await api(`/api/translate?text=${encodeURIComponent(t)}`);
    if (text) trStore()[t] = text;
  }
  if (todo.length) writeStore(TR_KEY, trStore());
}
/** prepareEnglish with a visible message; on failure the Vietnamese goes through as is. */
async function ensureEnglish(scenes) {
  try { await prepareEnglish(scenes); return true; }
  catch (e) { showMsg('warn', `Không dịch được sang tiếng Anh (${e.message}) — gửi Flow bằng tiếng Việt.`); return false; }
}

// ---------- rules (from a settings JSON or typed in) ----------
/** "a\nb" or ["a","b"] → ["a","b"] (trimmed, no empties). */
const listOf = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x ?? '').trim()).filter(Boolean);
const storyRules = () => listOf(story.rules);
const storyAvoid = () => listOf(story.negative);
/** Per-character consistency rules, as one English phrase per character present. */
const castRules = cast => cast.filter(c => listOf(c.rules).length)
  .map(c => `${c.name}: ${listOf(c.rules).map(r => trim(toEn(r))).join('; ')}`);

// ---------- prompts ----------
const castByName = name => story.cast.find(c => c.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
const sceneCast = sc => sc.cast.map(castByName).filter(Boolean);
const trim = t => String(t || '').replace(/[.\s]+$/, '');
const outfitOf = c => toEn(c.outfit) || 'casual everyday clothes';
const headStyle = () => Boolean(STORY_STYLES[story.style]?.head);
const genderEn = c => ({ nam: 'male', male: 'male', nu: 'female', 'nữ': 'female', female: 'female' })[String(c.gender || '').toLowerCase()] || '';
const charDesc = c => (headStyle()
  ? `${c.name}, a ${genderEn(c) ? genderEn(c) + ' ' : ''}person whose head is a giant realistic ${fruitEn(c.fruit) || 'fruit'} with an expressive human face sculpted into the fruit skin, on a realistic human body`
  : `${c.name}, ${genderEn(c) ? `a ${genderEn(c)}` : 'an'} anthropomorphic ${fruitEn(c.fruit) || 'fruit'} character`) + `${c.look ? ` (${trim(toEn(c.look))})` : ''} wearing ${trim(outfitOf(c))}`;

/** Flow image prompt for a scene: the first frame of its video. */
function sceneImagePrompt(sc) {
  const present = sceneCast(sc);
  const withRef = present.filter(c => c.image);
  return [
    `${styleText()}.`,
    sc.setting && `Scene: ${trim(toEn(sc.setting))}.`,
    present.length && `Characters: ${present.map(charDesc).join('; ')}.`,
    sc.action && `Moment: ${trim(toEn(sc.action))}.`,
    sc.camera && `Framing: ${trim(toEn(sc.camera))}.`,
    withRef.length && `The attached reference images show the exact character designs (${withRef.map((c, i) => `image ${i + 1} is ${c.name}`).join(', ')}): keep their faces, body shapes, colors and outfits identical.`,
    present.length && 'Every character is fully dressed in their outfit.',
    castRules(present).length && `Character consistency — ${castRules(present).join(' | ')}.`,
    storyRules().length && `Rules: ${storyRules().map(r => trim(toEn(r))).join('; ')}.`,
    'Expressive faces, clear composition, full scene. No text, no speech bubbles, no captions, no watermark.',
    storyAvoid().length && `Avoid: ${storyAvoid().map(r => trim(toEn(r))).join(', ')}.`,
  ].filter(Boolean).join(' ');
}
/** Flow video prompt for a scene (animates its image). */
/** Video prompt for a scene: `lines` (default all) are spoken; `lead` replaces the opening style line. */
function videoPromptFor(sc, { lines = sc.lines, lead = null, actionNote = '', chainNote = isChained(sc) } = {}) {
  lines = lines.filter(l => l.text.trim());
  const en = story.lang === 'en';
  const language = en ? 'English' : 'Vietnamese';
  let talk = '', audio = '';
  if (story.voice === 'speak' && lines.length) {
    talk = `Dialogue, spoken ONLY in ${language}${en ? '' : ' with natural native Vietnamese pronunciation and tones'}: ` + lines.map(l => {
      const c = castByName(l.who);
      return `${l.who || 'A character'}${c?.voice ? ` (${trim(toEn(c.voice))})` : ''} says "${l.text.trim()}"`;
    }).join(', then ') + '.';
    audio = `Audio: the characters speak exactly these ${language} lines word for word and nothing else. ` +
      `${en ? 'No other languages' : 'No English words at all'}, no narrator, no voice-over, no extra speech, no singing; besides the lines only soft ambient sound.`;
  } else if (story.voice === 'subs' && lines.length) {
    talk = 'The characters talk to each other with expressive mouth movements and gestures.';
  }
  if (!audio) audio = 'Audio: no speech at all, no narrator, no voice-over — only soft ambient sound.';
  return [
    lead || `${STORY_STYLES[story.style]?.anim || (story.style === 'custom' && trim(story.customStyle)) || 'Cartoon'} animation in the same art style as the image, smooth and lively.`,
    sc.action && `${trim(toEn(sc.action))}${actionNote}.`,
    sc.camera && `${trim(toEn(sc.camera))}.`,
    talk,
    chainNote && 'This shot continues seamlessly from the provided frame, which is the last moment of the previous shot: same characters, outfits, lighting and place, no cut, no scene change at the start.',
    'Keep the characters, their outfits and the art style exactly as in the image. No subtitles, no text on screen.',
    castRules(sceneCast(sc)).length && `Character consistency — ${castRules(sceneCast(sc)).join(' | ')}.`,
    storyAvoid().length && `Avoid: ${storyAvoid().map(r => trim(toEn(r))).join(', ')}.`,
    audio,
  ].filter(Boolean).join(' ');
}
function sceneVideoPrompt(sc) { return videoPromptFor(sc); }

/**
 * Film mode ("Kéo dài" in Flow): scene 1 is a normal clip; every later scene becomes `parts`
 * 4-second extensions of that same video. Its lines are split over the parts.
 */
function filmPlan() {
  const parts = Number(story.filmParts) === 1 ? 1 : 2;
  const [first, ...rest] = story.scenes;
  const steps = [];
  rest.forEach((sc, k) => {
    const prev = story.scenes[k];
    const lines = sc.lines.filter(l => l.text.trim());
    const half = Math.ceil(lines.length / 2);
    const moved = toEn(sc.setting).trim() && toEn(sc.setting).trim() !== toEn(prev.setting).trim();
    for (let p = 0; p < parts; p++) {
      const myLines = parts === 1 ? lines : p === 0 ? lines.slice(0, half) : lines.slice(half);
      const lead = p === 0
        ? (moved ? `Cut to a new shot in the same story and art style: ${trim(toEn(sc.setting))}.` : 'Continue the same shot smoothly, same art style.')
        : 'Continue the same shot smoothly, same art style.';
      steps.push({
        sceneId: sc.id, label: `Cảnh ${k + 2}${parts > 1 ? ` · ${p + 1}/${parts}` : ''}`,
        prompt: videoPromptFor(sc, { lines: myLines, lead, chainNote: false, actionNote: p > 0 ? ' — continuing, bring this moment to its end' : '' }),
      });
    }
  });
  return { first, steps, parts };
}

/** Scene i continues from the last frame of scene i-1's clip (never the first scene). */
const isChained = (sc, i = story.scenes.indexOf(sc)) => i > 0 && Boolean(sc.chain);
/** Scenes that need their own picture (a Flow image or an uploaded one). */
const needsImage = sc => !isChained(sc);
const subtitleOf = sc => sc.lines.filter(l => l.text.trim()).map(l => (l.who ? `${l.who}: ${l.text.trim()}` : l.text.trim())).join('\n');

// ---------- rendering ----------
function renderStory() {
  const root = $('storyRoot');
  if (!root) return;
  for (const stop of stPasteStops.splice(0)) stop();
  const imgModels = stOpts.models.length ? stOpts.models : [''];
  const vidModels = stOpts.video.models.length ? stOpts.video.models : [''];
  if (!imgModels.includes(story.imageModel)) story.imageModel = imgModels[0];
  if (!vidModels.includes(story.videoModel)) story.videoModel = vidModels[0];
  const durs = Object.keys(stOpts.video.credits[story.videoModel] || { 8: 0 }).map(Number).sort((a, b) => a - b);
  if (!durs.includes(Number(story.duration))) story.duration = durs.at(-1);
  const withImg = story.scenes.filter(s => s.image).length;
  const withVid = story.scenes.filter(s => s.video).length;
  const imgScenes = story.scenes.filter(needsImage);
  const imgMissing = imgScenes.filter(s => !s.image).length;
  const chainedCount = story.scenes.filter(sc => isChained(sc)).length;
  const vidTodo = story.scenes.filter(s => !s.video).length;
  const canVideo = story.scenes.some(s => !s.video) ? videoPlan().ok : story.scenes.some(s => s.image);
  const running = Boolean(story.job) || Boolean(stBusy);

  root.innerHTML = `
<div class="story">
  <div class="st-head">
    <select id="stPick" aria-label="Chọn truyện">${stories.map(s => `<option value="${s.id}" ${s.id === story.id ? 'selected' : ''}>${esc(s.title || 'Truyện')}</option>`).join('')}</select>
    <button class="btn small" type="button" id="stNew">＋ Truyện mới</button>
    <button class="btn small danger" type="button" id="stDel">🗑 Xoá truyện</button>
    <input type="text" id="stTitle" value="${esc(story.title)}" placeholder="Tên truyện" aria-label="Tên truyện">
  </div>

  <section class="st-sec">
    <h3>1 · Phong cách</h3>
    <div class="chips" role="group" aria-label="Phong cách vẽ">
      ${Object.entries(STORY_STYLES).map(([k, s]) => `<button type="button" class="chip" data-style="${k}" aria-pressed="${story.style === k}" title="${esc(s.text)}">${s.label}</button>`).join('')}
      <button type="button" class="chip" data-style="custom" aria-pressed="${story.style === 'custom'}">✏️ Tự mô tả</button>
    </div>
    <textarea id="stCustomStyle" rows="2" ${story.style === 'custom' ? '' : 'hidden'} placeholder="Mô tả phong cách bằng tiếng Anh, vd: 2D cartoon, thick outlines, pastel colors">${esc(story.customStyle)}</textarea>
    <div class="st-row">
      <label class="field">Tỉ lệ <select id="stRatio">${stOpts.video.ratios.map(r => `<option ${r === story.ratio ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="field">Ngôn ngữ thoại <select id="stLang">${Object.entries(DIALOG_LANGS).map(([k, l]) => `<option value="${k}" ${k === (story.lang || 'vi') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Thoại <select id="stVoice">${Object.entries(VOICE_MODES).map(([k, l]) => `<option value="${k}" ${k === story.voice ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <details class="st-rules" ${storyRules().length || storyAvoid().length ? 'open' : ''}>
      <summary>📐 Quy tắc chung & điều cần tránh <small>${storyRules().length} quy tắc · ${storyAvoid().length} điều tránh — gửi kèm mọi ảnh/video và khi Gemini viết kịch bản</small></summary>
      <label class="field">Quy tắc chung (mỗi dòng một quy tắc)
        <textarea id="stRules" rows="4" placeholder="vd: Mỗi ảnh chỉ một cảnh, một khung liền&#10;Không chia khung, không truyện tranh&#10;Ánh sáng điện ảnh">${esc(story.rules)}</textarea></label>
      <label class="field">🚫 Tránh (mỗi dòng một ý)
        <textarea id="stAvoid" rows="3" placeholder="vd: Thừa tay chân&#10;Chữ, watermark&#10;Đổi trang phục">${esc(story.negative)}</textarea></label>
    </details>
  </section>

  <section class="st-sec">
    <h3>2 · Nhân vật <small>ảnh mẫu giúp nhân vật giống nhau ở mọi cảnh</small></h3>
    <div class="st-cast" id="stCast"></div>
    <div class="chips st-fruits" aria-label="Thêm nhanh nhân vật">
      <span class="hint">Thêm nhanh:</span>
      ${FRUITS.map(([e, vi]) => `<button type="button" class="chip" data-fruit="${esc(vi)}">${e} ${esc(vi)}</button>`).join('')}
      <button type="button" class="chip" data-fruit="">＋ Khác</button>
    </div>
  </section>

  <section class="st-sec">
    <h3>3 · Kịch bản</h3>
    <label class="field">Ý tưởng câu chuyện (tiếng Việt)
      <textarea id="stIdea" rows="3" placeholder="vd: Cô Bơ và anh Bơ hẹn hò ở quán trà đá, anh Bơ khoe hút tẩu cho ngầu nhưng bị sặc, cô Bơ mắng yêu…">${esc(story.idea)}</textarea></label>
    <div class="st-row">
      <label class="field">Giọng điệu <select id="stTone">${STORY_TONES.map(t => `<option ${t === story.tone ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field">Số cảnh <input type="number" id="stCount" min="2" max="12" value="${story.sceneCount}"></label>
      <button class="btn primary" type="button" id="stWrite" ${running ? 'disabled' : ''}>${stBusy === 'write' ? '⏳ Gemini đang viết…' : '✨ Gemini viết kịch bản'}</button>
    </div>
    <p class="hint">Gemini lập dàn ý trước (ai muốn gì, vướng gì, cao trào, cú chốt) rồi mới chia cảnh ${story.duration || 8} giây. Ý tưởng càng cụ thể (ai, muốn gì, kết thế nào) truyện càng chặt. Chưa có nhân vật thì Gemini tự nghĩ và thêm vào mục 2. Viết lại sẽ thay các cảnh hiện có.</p>
    ${story.scenes.length ? `<div class="st-plot">
      <label class="field">Truyện trong 1 câu <small>(ai muốn gì, vướng gì)</small>
        <textarea id="stLogline" rows="2" placeholder="vd: Anh Bơ muốn ra vẻ sành điệu trước cô Bơ nên mượn tẩu của ông chủ quán, nhưng…">${esc(story.logline)}</textarea></label>
      ${story.outline.length ? `<ol class="st-outline">${story.outline.map(b => `<li>${esc(b)}</li>`).join('')}</ol>` : ''}
      <div class="st-row">
        <input type="text" id="stFixNote" value="${esc(story.fixNote)}" placeholder="(tuỳ chọn) muốn sửa gì? vd: cho kết bất ngờ hơn, cô Bơ là người thắng" aria-label="Yêu cầu sửa">
        <button class="btn" type="button" id="stReview" ${running ? 'disabled' : ''} title="Gemini đọc lại kịch bản hiện tại (kể cả phần bạn đã sửa), tìm chỗ vô lý và sửa">${stBusy === 'review' ? '⏳ Đang kiểm tra…' : '🔍 Kiểm tra & sửa logic'}</button>
      </div>
      ${story.notes.length ? `<div class="st-notes"><b>Gemini đã sửa:</b><ul>${story.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    </div>` : ''}
  </section>

  <section class="st-sec">
    <h3>4 · Các cảnh <small>${story.scenes.length} cảnh · ${withImg} có ảnh · ${withVid} có video</small></h3>
    <div class="st-row tight">
      <button class="btn small" type="button" id="stEditJsonBtn" aria-expanded="${stImportOpen && stJsonMode === 'edit'}" title="Sửa trực tiếp JSON của truyện này (cảnh, thoại, nhân vật)">✏️ Sửa JSON</button>
      <button class="btn small" type="button" id="stImportBtn" aria-expanded="${stImportOpen && stJsonMode === 'import'}" title="Dán kịch bản dạng văn bản thường hoặc JSON">📥 Nhập (văn bản / JSON)</button>
      <button class="btn small" type="button" id="stExport" ${story.scenes.length ? '' : 'disabled'}>📤 Xuất JSON</button>
      <button class="btn small" type="button" id="stCopyJson" ${story.scenes.length ? '' : 'disabled'}>📋 Chép JSON</button>
    </div>
    <div class="st-import" id="stImport" ${stImportOpen ? '' : 'hidden'}>
      <p class="st-json-title">${stJsonMode === 'edit' ? '✏️ Sửa JSON của truyện — sửa xong bấm "Áp dụng". Cảnh không đổi bối cảnh/diễn biến giữ nguyên ảnh &amp; video.' : '📥 Nhập kịch bản — gõ / dán văn bản thường hoặc JSON, app tự nhận ra'}</p>
      <textarea id="stImportText" rows="${stJsonMode === 'edit' ? 18 : 8}" spellcheck="false" placeholder='Gõ hoặc dán kịch bản. Dạng văn bản:

Tên truyện: Dạ tiệc
Nhân vật: Táo (táo) - vest đen; Dâu (dâu tây) - váy đỏ

Cảnh 1: phòng dạ tiệc, buổi tối
Táo nhìn Dâu đầy ghen tức khi cô khoác tay Chuối.
Máy quay: cận cảnh
Táo: Em đi với ai thế?
Dâu: Không phải việc của anh.

Cảnh 2: ban công
…

(Hoặc dán JSON có "scenes": [ … ])'></textarea>
      <div class="st-row tight">
        ${stJsonMode === 'edit' ? '<button class="btn small" type="button" id="stJsonFormat" title="Sắp xếp lại thụt lề cho dễ đọc">⇥ Định dạng</button><button class="btn small" type="button" id="stJsonReload" title="Bỏ các thay đổi, lấy lại JSON hiện tại">↺ Lấy lại</button>'
          : `<label class="btn small">📂 Chọn file .json<input type="file" id="stImportFile" accept=".json,application/json,.txt" hidden></label>
        <label><input type="radio" name="stImportMode" value="replace" checked> Thay các cảnh hiện có</label>
        <label><input type="radio" name="stImportMode" value="append"> Nối thêm vào cuối</label>`}
        <span class="st-json-check" id="stJsonCheck" aria-live="polite"></span>
        <span class="grow"></span>
        <button class="btn small" type="button" id="stImportCancel">Huỷ</button>
        <button class="btn small primary" type="button" id="stImportGo">${stJsonMode === 'edit' ? 'Áp dụng' : 'Nhập'}</button>
      </div>
      <p class="hint"><b>Văn bản:</b> mỗi cảnh bắt đầu bằng <code>Cảnh 1:</code> (sau dấu hai chấm là bối cảnh) — hoặc cách nhau bằng một dòng trống. Trong cảnh: <code>Bối cảnh:</code>, <code>Máy quay:</code>, <code>Tóm tắt:</code>, <code>Diễn biến:</code>; dòng <code>Tên: câu nói</code> là thoại; dòng khác là diễn biến. Đầu bài có thể có <code>Tên truyện:</code> và <code>Nhân vật: Tên (quả) - trang phục; …</code>.<br><b>JSON:</b> JSON truyện của tab này (có <code>scenes</code>), hoặc một mảng cảnh <code>[ … ]</code>. Tên trường linh hoạt: <code>action</code>/<code>description</code>, <code>setting</code>/<code>location</code>, <code>lines</code>/<code>dialogue</code> (dạng <code>{"who","text"}</code>, <code>{"character","line"}</code> hoặc chuỗi <code>"Táo: câu thoại"</code>). Nhân vật chưa có sẽ được thêm vào mục 2.</p>
    </div>
    <div class="st-scenes" id="stScenes"></div>
    <button class="btn small" type="button" id="stAddScene">＋ Thêm cảnh</button>
  </section>

  <section class="st-sec st-make">
    <h3>5 · Tạo phim</h3>
    <div class="st-row">
      <label class="field">Model ảnh <select id="stImgModel">${imgModels.map(m => `<option ${m === story.imageModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <button class="btn primary" type="button" id="stMakeImages" ${running || !imgScenes.length ? 'disabled' : ''}>🖼 Tạo ảnh ${imgMissing || imgScenes.length} cảnh ${imgMissing && imgMissing < imgScenes.length ? 'còn thiếu' : ''}</button>
    </div>
    <div class="st-row tight st-chain">
      <span>🔗 Nối tiếp ${chainedCount}/${Math.max(0, story.scenes.length - 1)} cảnh</span>
      <button class="btn small" type="button" id="stChainAll" ${story.scenes.length > 1 ? '' : 'disabled'}>Nối tất cả</button>
      <button class="btn small" type="button" id="stChainNone" ${chainedCount ? '' : 'disabled'}>Bỏ nối</button>
      <span class="hint">Cảnh nối tiếp bắt đầu từ <b>khung cuối video cảnh trước</b> → nhân vật, trang phục, ánh sáng liền mạch; không cần ảnh riêng, nhưng phải tạo video lần lượt.</span>
    </div>
    <div class="st-row">
      <label class="field">Model video <select id="stVidModel">${vidModels.map(m => `<option ${m === story.videoModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="field">Thời lượng <select id="stDur">${durs.map(d => `<option value="${d}" ${d === Number(story.duration) ? 'selected' : ''}>${d} giây</option>`).join('')}</select></label>
      <button class="btn primary" type="button" id="stMakeVideos" ${running || !canVideo ? 'disabled' : ''}>🎬 Tạo video ${vidTodo || story.scenes.filter(s => s.image).length} cảnh</button>
    </div>
    <div class="st-row">
      <button class="btn" type="button" id="stJoin" ${withVid ? '' : 'disabled'}>🎞️ Ghép ${withVid} video thành phim</button>
      ${story.job ? `<button class="btn small" type="button" id="stStop">⏹ Dừng sau cảnh đang tạo</button>` : ''}
    </div>
    <div class="st-film">
      <div class="st-row tight">
        <b>🎞 Phim liền mạch</b><span class="hint">(dùng "Kéo dài" của Flow — nhân vật & bối cảnh giữ nhất quán nhất)</span>
      </div>
      <div class="st-row tight">
        <label class="field">Mỗi cảnh sau cảnh 1 <select id="stFilmParts"><option value="2" ${Number(story.filmParts) !== 1 ? 'selected' : ''}>8 giây (2 lần kéo dài)</option><option value="1" ${Number(story.filmParts) === 1 ? 'selected' : ''}>4 giây (1 lần kéo dài)</option></select></label>
        <button class="btn primary" type="button" id="stFilm" ${running || !story.scenes[0]?.image ? 'disabled' : ''}>🎞 Tạo phim ${story.scenes.length} cảnh</button>
      </div>
      <p class="hint">Cảnh 1 = video ${story.duration || 8}s từ ảnh cảnh 1 · ${Math.max(0, story.scenes.length - 1)} cảnh sau = ${Math.max(0, story.scenes.length - 1) * (Number(story.filmParts) === 1 ? 1 : 2)} lần kéo dài × 4s (~12 credit/lần). Chỉ cần ảnh cảnh 1. Ra một file phim ghép sẵn, ~${(story.duration || 8) + Math.max(0, story.scenes.length - 1) * (Number(story.filmParts) === 1 ? 4 : 8)} giây.</p>
      ${story.film ? `<div class="st-filmout"><video src="${esc(story.film)}" controls playsinline preload="metadata"></video>
        <div class="st-row tight"><a class="btn small primary" href="${esc(story.film)}?download=1" download>⬇ Tải phim</a>
        <button class="btn small" type="button" id="stFilmEdit">🎞️ Mở trong Ghép video (thêm nhạc, chữ)</button>
        <span class="hint">${story.filmSeconds ? `${Math.round(story.filmSeconds)} giây` : ''}</span></div></div>` : ''}
    </div>
    <p class="hint" id="stStatus">${story.job ? `⏳ Đang tạo ${story.job.kind === 'video' ? 'video' : 'ảnh'}… tiến độ hiện ở cột Kết quả bên phải.` : 'Tạo ảnh cảnh trước (kiểm tra nhân vật đúng chưa), rồi mới tạo video — mỗi bước đều hỏi số credit trước khi tạo.'}</p>
  </section>
</div>`;

  renderCast();
  renderScenes();
  wireStory();
}

function renderCast() {
  const box = $('stCast');
  box.innerHTML = '';
  if (!story.cast.length) box.innerHTML = '<p class="hint">Chưa có nhân vật — bấm một loại quả bên dưới, hoặc để Gemini tự nghĩ khi viết kịch bản.</p>';
  story.cast.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'st-char';
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="st-img" title="Bấm để chọn ảnh, hoặc Ctrl+V để dán">${c.image ? `<img src="${esc(c.image)}" alt="">` : '<span>＋ Ảnh mẫu<br><small>bấm / dán Ctrl+V</small></span>'}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden></div>
      <div class="st-char-body">
        <div class="st-row tight">
          <input type="text" data-k="name" value="${esc(c.name)}" placeholder="Tên (vd: Cô Bơ)" aria-label="Tên nhân vật">
          <input type="text" data-k="fruit" value="${esc(c.fruit)}" placeholder="Loại quả" aria-label="Loại quả">
        </div>
        <textarea data-k="look" rows="2" placeholder="Ngoại hình: mặt, mắt, tóc, màu sắc…">${esc(c.look)}</textarea>
        <textarea data-k="outfit" rows="2" placeholder="👕 Trang phục (bấm chọn nhanh bên dưới, hoặc tự gõ)">${esc(c.outfit || '')}</textarea>
        <div class="st-outfit-row">
          <div class="st-oimg" tabindex="0" title="Ảnh trang phục: bấm để chọn, hoặc bấm vào ô này rồi Ctrl+V">${c.outfitImage ? `<img src="${esc(c.outfitImage)}" alt=""><button type="button" class="x" data-act="nooutfit" title="Bỏ ảnh trang phục">✕</button>` : '<span>👕＋<br><small>ảnh đồ</small></span>'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden></div>
          <div class="chips st-outfits" aria-label="Chọn trang phục">
            ${stLibraryOutfits().map(o => `<button type="button" class="chip lib" data-lib="${esc(o.id)}" aria-pressed="${!!c.outfitImage && c.outfitImage === o.image}" title="${esc(o.text || o.label)}">${o.image ? `<img src="${esc(o.image)}" alt="">` : ''}${esc(o.label)}</button>`).join('')}
            ${ST_OUTFITS.map(([l, vi]) => `<button type="button" class="chip" data-outfit="${esc(vi)}" aria-pressed="${!c.outfitImage && (c.outfit || '') === vi}">${esc(l)}</button>`).join('')}
          </div>
        </div>
        ${c.outfitImage && !stLibraryOutfits().some(o => o.image === c.outfitImage) ? '<button class="link st-savelib" type="button" data-act="savelib">💾 Lưu bộ đồ này vào thư viện trang phục</button>' : ''}
        <div class="st-row tight">
          <select data-k="gender" aria-label="Giới tính"><option value="" ${!genderEn(c) ? 'selected' : ''}>Giới tính —</option><option value="male" ${genderEn(c) === 'male' ? 'selected' : ''}>Nam</option><option value="female" ${genderEn(c) === 'female' ? 'selected' : ''}>Nữ</option></select>
          <input type="text" data-k="personality" value="${esc(c.personality || '')}" placeholder="Tính cách, vd: sĩ diện, hay khoe, tốt bụng" aria-label="Tính cách">
        </div>
        <details class="st-crules" ${listOf(c.rules).length ? '' : ''}><summary>Quy tắc nhất quán (${listOf(c.rules).length})</summary>
          <textarea data-k="rules" rows="3" placeholder="Mỗi dòng một quy tắc, vd: Luôn mặc vest đen&#10;Giữ nguyên khuôn mặt ở mọi cảnh">${esc(listOf(c.rules).join('\n'))}</textarea></details>
        <input type="text" data-k="voice" value="${esc(c.voice)}" placeholder="Giọng nói, vd: giọng nữ miền Bắc, nhí nhảnh" aria-label="Giọng nói">
        <div class="st-row tight">
          <button class="btn small" type="button" data-act="draw" ${stBusy ? 'disabled' : ''} title="Gemini vẽ nhân vật trên nền trắng theo phong cách đã chọn (không tốn credit Flow)">${stBusy === 'draw' + i ? '⏳ Đang vẽ…' : '🎨 Vẽ bằng Gemini'}</button>
          ${c.image ? '<button class="btn small" type="button" data-act="noimg">Bỏ ảnh</button>' : ''}
          <button class="btn small danger" type="button" data-act="del">Xoá</button>
        </div>
      </div>`;
    const file = el.querySelector('input[type=file]');
    const put = async f => {
      try { c.image = await uploadImage(f); saveStories(); renderCast(); } catch (e) { showMsg('err', e.message); }
    };
    el.querySelector('.st-img').onclick = () => file.click();
    file.onchange = () => file.files[0] && put(file.files[0]);
    stPasteStops.push(onPasteImage(el, put));
    // outfit photo: its own upload / paste target (registered after the card → wins while focused)
    const oslot = el.querySelector('.st-oimg');
    const ofile = oslot.querySelector('input[type=file]');
    const putOutfit = async f => {
      try { c.outfitImage = await uploadImage(f); saveStories(); renderCast(); } catch (e) { showMsg('err', e.message); }
    };
    oslot.onclick = e => { if (!e.target.closest('[data-act]')) ofile.click(); };
    oslot.onkeydown = e => { if (e.key === 'Enter') ofile.click(); };
    ofile.onchange = () => ofile.files[0] && putOutfit(ofile.files[0]);
    stPasteStops.push(onPasteImage(oslot, putOutfit));
    el.querySelector('[data-act="nooutfit"]')?.addEventListener('click', e => { e.stopPropagation(); c.outfitImage = ''; saveStories(); renderCast(); });
    el.querySelector('[data-act="savelib"]')?.addEventListener('click', async () => {
      const label = prompt('Tên bộ trang phục (vd: Áo dài đỏ):', '');
      if (!label) return;
      try {
        const preset = await api('/api/studio/presets', { group: 'outfits', label, text: c.outfit ? `wearing ${c.outfit}` : '', image: c.outfitImage });
        (studio.presets.outfits ||= []).push(preset);
        showMsg('info', `💾 Đã lưu "${label}" vào thư viện trang phục (dùng được cả bên Tạo bộ ảnh).`);
        renderCast();
      } catch (e) { showMsg('err', 'Không lưu được: ' + e.message); }
    });
    for (const inp of el.querySelectorAll('[data-k]')) {
      inp.oninput = () => {
        const old = c.name;
        c[inp.dataset.k] = inp.value;
        if (inp.dataset.k === 'name') for (const sc of story.scenes) {
          sc.cast = sc.cast.map(n => (n === old ? inp.value : n));
          for (const l of sc.lines) if (l.who === old) l.who = inp.value;
        }
        saveStories();
      };
      if (inp.dataset.k === 'name') inp.onchange = () => renderScenes();
    }
    for (const b of el.querySelectorAll('[data-outfit]')) b.onclick = () => {
      const o = ST_OUTFITS.find(x => x[1] === b.dataset.outfit);
      c.outfit = b.dataset.outfit; c.outfitImage = '';
      if (o) seedEn(o[1], o[2]); // known translation — no request needed
      saveStories(); renderCast();
    };
    for (const b of el.querySelectorAll('[data-lib]')) b.onclick = () => {
      const o = stLibraryOutfits().find(x => x.id === b.dataset.lib);
      if (!o) return;
      c.outfitImage = o.image || '';
      // show the Vietnamese name; the saved English text is what Flow gets
      c.outfit = o.label || '';
      seedEn(o.label, String(o.text || '').replace(/^wearing\s+/i, ''));
      saveStories(); renderCast();
    };
    el.querySelector('[data-act="draw"]').onclick = () => drawCharacter(c, i);
    el.querySelector('[data-act="noimg"]')?.addEventListener('click', () => { c.image = ''; saveStories(); renderCast(); });
    el.querySelector('[data-act="del"]').onclick = () => {
      story.cast.splice(i, 1);
      for (const sc of story.scenes) sc.cast = sc.cast.filter(n => n !== c.name);
      saveStories(); renderStory();
    };
    box.appendChild(el);
  });
}

function renderScenes() {
  const box = $('stScenes');
  if (!box) return;
  box.innerHTML = '';
  if (!story.scenes.length) { box.innerHTML = '<p class="hint">Chưa có cảnh — bấm "✨ Gemini viết kịch bản" hoặc "＋ Thêm cảnh".</p>'; return; }
  story.scenes.forEach((sc, i) => {
    const el = document.createElement('div');
    el.className = 'st-scene';
    el.tabIndex = -1;
    const media = sc.video
      ? `<video src="${esc(sc.video)}" controls playsinline preload="metadata"></video>`
      : sc.image ? `<img src="${esc(sc.image)}" alt="">` : `<span>${sc.status === 'running' ? '⏳ đang tạo…' : sc.status === 'error' ? '⚠ lỗi' : '＋ Ảnh cảnh<br><small>tạo bằng Flow, hoặc bấm / dán ảnh</small>'}</span>`;
    el.innerHTML = `
      <div class="st-media">${media}<input type="file" accept="image/png,image/jpeg,image/webp" hidden></div>
      <div class="st-scene-body">
        <div class="st-scene-head"><b>Cảnh ${i + 1}</b>
          <span class="grow"></span>
          <button class="btn small" type="button" data-act="up" ${i ? '' : 'disabled'} title="Lên">↑</button>
          <button class="btn small" type="button" data-act="down" ${i < story.scenes.length - 1 ? '' : 'disabled'} title="Xuống">↓</button>
          <button class="btn small danger" type="button" data-act="del" title="Xoá cảnh">✕</button>
        </div>
        ${sc.purpose ? `<p class="st-purpose">🎯 ${esc(sc.purpose)}</p>` : ''}
        <label class="field">Tóm tắt (tiếng Việt) <textarea data-k="summary" rows="2" placeholder="Chuyện gì xảy ra, vì sao (nối với cảnh trước)">${esc(sc.summary)}</textarea></label>
        <label class="field">Bối cảnh <input type="text" data-k="setting" value="${esc(sc.setting)}" placeholder="vd: quán trà đá vỉa hè Hà Nội, buổi sáng"></label>
        <label class="field">Diễn biến <textarea data-k="action" rows="2" placeholder="vd: Anh Bơ phì phèo tẩu đầy tự hào, Cô Bơ che miệng cười">${esc(sc.action)}</textarea></label>
        <label class="field">Máy quay <input type="text" data-k="camera" value="${esc(sc.camera)}" placeholder="vd: trung cảnh, máy tiến chậm vào"></label>
        <div class="chips st-in" aria-label="Nhân vật trong cảnh">${story.cast.map(c => `<button type="button" class="chip" data-in="${esc(c.name)}" aria-pressed="${sc.cast.includes(c.name)}">${esc(c.name || '?')}</button>`).join('')}</div>
        <div class="st-lines"></div>
        <div class="st-row tight">
          <button class="btn small" type="button" data-act="line">＋ Thoại</button>
          ${i > 0 ? `<label class="st-chainbox" title="Video cảnh này bắt đầu từ khung hình cuối của video cảnh ${i}"><input type="checkbox" data-act="chain" ${sc.chain ? 'checked' : ''}> 🔗 Nối từ cảnh ${i}</label>` : ''}
          <span class="grow"></span>
          ${sc.image ? `<button class="btn small" type="button" data-act="reimg" ${story.job || stBusy ? 'disabled' : ''}>↻ Tạo lại ảnh</button>` : ''}
          ${sc.video ? '<button class="btn small" type="button" data-act="novid" title="Bỏ video để tạo lại">Bỏ video</button>' : ''}
          ${sc.image ? '<button class="btn small" type="button" data-act="noimg">Bỏ ảnh</button>' : ''}
          <button class="btn small" type="button" data-act="prompt" title="Xem câu lệnh gửi Flow">📋</button>
        </div>
        <pre class="st-prompt" hidden></pre>
      </div>`;
    const lines = el.querySelector('.st-lines');
    sc.lines.forEach((l, k) => {
      const row = document.createElement('div');
      row.className = 'st-line';
      row.innerHTML = `<select aria-label="Ai nói"><option value="">—</option>${story.cast.map(c => `<option ${c.name === l.who ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${l.who && !castByName(l.who) ? `<option selected>${esc(l.who)}</option>` : ''}</select>
        <input type="text" value="${esc(l.text)}" placeholder="Câu thoại tiếng Việt (ngắn)" maxlength="200" aria-label="Câu thoại">
        <button class="btn small" type="button" title="Xoá câu thoại">✕</button>`;
      row.querySelector('select').onchange = e => { l.who = e.target.value; saveStories(); };
      row.querySelector('input').oninput = e => { l.text = e.target.value; saveStories(); };
      row.querySelector('button').onclick = () => { sc.lines.splice(k, 1); saveStories(); renderScenes(); };
      lines.appendChild(row);
    });
    for (const inp of el.querySelectorAll('[data-k]')) inp.oninput = () => { sc[inp.dataset.k] = inp.value; saveStories(); };
    for (const b of el.querySelectorAll('[data-in]')) b.onclick = () => {
      const n = b.dataset.in;
      sc.cast = sc.cast.includes(n) ? sc.cast.filter(x => x !== n) : [...sc.cast, n];
      saveStories(); renderScenes();
    };
    const file = el.querySelector('input[type=file]');
    const put = async f => {
      try { sc.image = await uploadImage(f); sc.video = ''; sc.status = ''; saveStories(); renderStory(); } catch (e) { showMsg('err', e.message); }
    };
    el.querySelector('.st-media').onclick = e => { if (!sc.image && !sc.video && e.target.tagName !== 'VIDEO') file.click(); };
    file.onchange = () => file.files[0] && put(file.files[0]);
    stPasteStops.push(onPasteImage(el, put));
    const act = (name, fn) => el.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
    act('up', () => { story.scenes.splice(i - 1, 0, story.scenes.splice(i, 1)[0]); saveStories(); renderScenes(); });
    act('down', () => { story.scenes.splice(i + 1, 0, story.scenes.splice(i, 1)[0]); saveStories(); renderScenes(); });
    act('del', () => { story.scenes.splice(i, 1); saveStories(); renderStory(); });
    el.querySelector('[data-act="chain"]')?.addEventListener('change', e => { sc.chain = e.target.checked; saveStories(); renderStory(); });
    act('line', () => { sc.lines.push({ who: sc.cast[0] || '', text: '' }); saveStories(); renderScenes(); });
    act('reimg', () => makeImages([sc]));
    act('novid', () => { sc.video = ''; saveStories(); renderStory(); });
    act('noimg', () => { sc.image = ''; sc.video = ''; saveStories(); renderStory(); });
    act('prompt', async () => {
      const pre = el.querySelector('.st-prompt');
      pre.hidden = !pre.hidden;
      if (pre.hidden) return;
      pre.textContent = 'Đang dịch sang tiếng Anh…';
      await ensureEnglish([sc]);
      pre.textContent = `🖼 Ảnh:\n${sceneImagePrompt(sc)}\n\n🎬 Video:\n${sceneVideoPrompt(sc)}`;
    });
    box.appendChild(el);
  });
}

function wireStory() {
  $('stPick').onchange = e => { story = { ...newStory(), ...stories.find(s => s.id === e.target.value) }; saveStories(); renderStory(); resumeJob(); };
  $('stNew').onclick = () => { story = newStory(); stories.unshift(story); saveStories(); renderStory(); };
  $('stDel').onclick = () => {
    if (!confirm(`Xoá truyện "${story.title}"? (ảnh/video đã tạo vẫn còn trong thư mục outputs)`)) return;
    stories = stories.filter(s => s.id !== story.id);
    story = stories[0] ? { ...newStory(), ...stories[0] } : newStory();
    if (!stories.length) stories.push(story);
    saveStories(); renderStory();
  };
  $('stTitle').oninput = e => { story.title = e.target.value; saveStories(); };
  $('stTitle').onchange = () => renderStory();
  for (const b of document.querySelectorAll('[data-style]')) b.onclick = () => { story.style = b.dataset.style; saveStories(); renderStory(); };
  $('stCustomStyle').oninput = e => { story.customStyle = e.target.value; saveStories(); };
  $('stRatio').onchange = e => { story.ratio = e.target.value; saveStories(); };
  $('stVoice').onchange = e => { story.voice = e.target.value; saveStories(); };
  $('stRules').oninput = e => { story.rules = e.target.value; saveStories(); };
  $('stAvoid').oninput = e => { story.negative = e.target.value; saveStories(); };
  $('stLang').onchange = e => changeLang(e.target.value);
  for (const b of document.querySelectorAll('[data-fruit]')) b.onclick = () => addCharacter(b.dataset.fruit);
  $('stIdea').oninput = e => { story.idea = e.target.value; saveStories(); };
  $('stTone').onchange = e => { story.tone = e.target.value; saveStories(); };
  $('stCount').onchange = e => { story.sceneCount = Math.min(12, Math.max(2, Number(e.target.value) || 5)); saveStories(); };
  $('stWrite').onclick = writeScript;
  $('stLogline')?.addEventListener('input', e => { story.logline = e.target.value; saveStories(); });
  $('stFixNote')?.addEventListener('input', e => { story.fixNote = e.target.value; saveStories(); });
  $('stReview')?.addEventListener('click', reviewScript);
  const openJson = mode => {
    const same = stImportOpen && stJsonMode === mode;
    stImportOpen = !same; stJsonMode = mode;
    renderStory();
    if (!stImportOpen) return;
    const ta = $('stImportText');
    if (mode === 'edit') ta.value = JSON.stringify(storyJson(), null, 2);
    checkJson();
    ta.focus();
    ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  $('stEditJsonBtn').onclick = () => openJson('edit');
  $('stImportBtn').onclick = () => openJson('import');
  $('stImportCancel').onclick = () => { stImportOpen = false; renderStory(); };
  $('stImportFile')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) { $('stImportText').value = await f.text(); checkJson(); }
    e.target.value = '';
  });
  $('stJsonFormat')?.addEventListener('click', () => {
    try { $('stImportText').value = JSON.stringify(parseLooseJson($('stImportText').value), null, 2); checkJson(); }
    catch (err) { showMsg('err', 'Chưa định dạng được: ' + err.message); }
  });
  $('stJsonReload')?.addEventListener('click', () => { $('stImportText').value = JSON.stringify(storyJson(), null, 2); checkJson(); });
  let checkTimer = null;
  $('stImportText').addEventListener('input', () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkJson, 300); });
  // Tab inserts two spaces instead of leaving the box
  $('stImportText').addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const ta = e.target, a = ta.selectionStart;
    ta.setRangeText('  ', a, ta.selectionEnd, 'end');
  });
  $('stImportGo').onclick = () => {
    const mode = stJsonMode === 'edit' ? 'edit' : document.querySelector('input[name="stImportMode"]:checked')?.value || 'replace';
    try {
      const r = importStoryJson($('stImportText').value, mode);
      stImportOpen = false;
      renderStory();
      const m = r.meta || {};
      const extra = [m.cast?.length && `${m.cast.length} nhân vật`, m.rules?.length && `${m.rules.length} quy tắc`, m.avoid?.length && `${m.avoid.length} điều tránh`, m.style && 'phong cách', m.ratio && `tỉ lệ ${m.ratio}`].filter(Boolean).join(', ');
      showMsg('info', !r.count
        ? `📥 Đã nhập cài đặt truyện: ${extra}. JSON chưa có cảnh — bấm "✨ Gemini viết kịch bản" (${story.sceneCount} cảnh) để Gemini viết theo đúng các quy tắc này.`
        : mode === 'edit'
          ? `✏️ Đã áp dụng JSON — ${r.count} cảnh${r.kept ? `, ${r.kept} cảnh giữ nguyên ảnh/video` : ''}${extra ? ` · ${extra}` : ''}.`
          : `📥 Đã nhập ${r.count} cảnh${mode === 'append' ? ' (nối vào cuối)' : ''}${extra ? ` · ${extra}` : ''}.`);
    } catch (err) { showMsg('err', `Không ${mode === 'edit' ? 'áp dụng' : 'nhập'} được JSON: ` + err.message); }
  };
  $('stExport').onclick = () => {
    const blob = new Blob([JSON.stringify(storyJson(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(story.title || 'truyen').replace(/[\\/:*?"<>|]+/g, '').trim() || 'truyen'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('stCopyJson').onclick = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(storyJson(), null, 2)); showMsg('info', '📋 Đã chép JSON của truyện.'); }
    catch { showMsg('err', 'Không chép được — dùng 📤 Xuất JSON.'); }
  };
  $('stAddScene').onclick = () => {
    story.scenes.push({ id: stId('c'), summary: '', setting: story.scenes.at(-1)?.setting || '', cast: story.cast.map(c => c.name), action: '', camera: '', lines: [], image: '', video: '' });
    saveStories(); renderStory();
  };
  $('stImgModel').onchange = e => { story.imageModel = e.target.value; saveStories(); };
  $('stVidModel').onchange = e => { story.videoModel = e.target.value; saveStories(); renderStory(); };
  $('stDur').onchange = e => { story.duration = Number(e.target.value); saveStories(); };
  $('stMakeImages').onclick = () => {
    const own = story.scenes.filter(needsImage);
    const missing = own.filter(s => !s.image);
    makeImages(missing.length ? missing : own);
  };
  $('stChainAll').onclick = () => { story.scenes.forEach((sc, i) => { if (i > 0) sc.chain = true; }); saveStories(); renderStory(); };
  $('stChainNone').onclick = () => { for (const sc of story.scenes) sc.chain = false; saveStories(); renderStory(); };
  $('stMakeVideos').onclick = makeVideos;
  $('stJoin').onclick = joinMovie;
  $('stFilmParts').onchange = e => { story.filmParts = Number(e.target.value); saveStories(); renderStory(); };
  $('stFilm').onclick = makeFilm;
  $('stFilmEdit')?.addEventListener('click', async () => { openTab('edit'); await addToEditor([{ url: story.film }], { replace: true, name: story.title }); });
  $('stStop')?.addEventListener('click', async () => {
    try { await api('/api/batch/cancel', { id: story.job.batchId }); showMsg('info', 'Sẽ dừng sau cảnh đang tạo.'); } catch (e) { showMsg('err', e.message); }
  });
}

// ---------- JSON import / export ----------
/** The story as plain JSON (no generated media, no ids) — same shape Gemini returns. */
function storyJson() {
  return {
    title: story.title, style_id: story.style, style: styleText(), aspect_ratio: story.ratio, logline: story.logline, outline: story.outline,
    rules: storyRules(), negative_prompt: storyAvoid(),
    cast: story.cast.map(c => ({ name: c.name, fruit: c.fruit, gender: genderEn(c), personality: c.personality || '', look: c.look, outfit: c.outfit || '', voice: c.voice, consistency_rules: listOf(c.rules) })),
    scenes: story.scenes.map(({ purpose, summary, setting, cast, action, camera, lines, chain }) => ({ purpose: purpose || '', summary, setting, cast, action, camera, lines, chain: Boolean(chain) })),
  };
}

const str = v => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const pick = (o, ...keys) => { for (const k of keys) { const v = str(o?.[k]); if (v) return v; } return ''; };
/** One dialogue entry in any common shape → { who, text }. */
function toLine(l) {
  if (typeof l === 'string') {
    const m = /^\s*([^:：]{1,40})\s*[:：]\s*(.+)$/.exec(l);
    return m ? { who: m[1].trim(), text: m[2].trim() } : { who: '', text: l.trim() };
  }
  return { who: pick(l, 'who', 'character', 'speaker', 'name', 'nhan_vat'), text: pick(l, 'text', 'line', 'say', 'says', 'dialogue', 'content', 'thoai') };
}
/** One scene in any common shape → this tab's scene object. */
function toScene(o) {
  if (typeof o === 'string') return { id: stId('c'), purpose: '', summary: o, setting: '', cast: [], action: o, camera: '', lines: [], image: '', video: '' };
  const rawLines = o.lines ?? o.dialogue ?? o.dialogues ?? o.thoai ?? [];
  const lines = (Array.isArray(rawLines) ? rawLines : [rawLines]).map(toLine).filter(l => l.text);
  const rawCast = o.cast ?? o.characters ?? o.nhan_vat ?? [];
  const cast = (Array.isArray(rawCast) ? rawCast : String(rawCast).split(','))
    .map(c => (typeof c === 'string' ? c : pick(c, 'name', 'who'))).map(c => c.trim()).filter(Boolean);
  for (const l of lines) if (l.who && !cast.includes(l.who)) cast.push(l.who);
  return {
    id: stId('c'),
    purpose: pick(o, 'purpose', 'beat', 'vai_tro'),
    summary: pick(o, 'summary', 'tom_tat', 'title'),
    setting: pick(o, 'setting', 'location', 'background', 'scene', 'boi_canh'),
    cast,
    action: pick(o, 'action', 'description', 'visual', 'prompt', 'dien_bien'),
    camera: pick(o, 'camera', 'shot', 'may_quay'),
    lines, image: '', video: '', chain: o.chain === true,
  };
}
/** Parse pasted / loaded JSON into scenes (+ cast, title…); returns how many scenes were added. */
/** Does this look like JSON (rather than a plain-text script)? */
const looksJson = t => /^\s*(```\s*json|[{[])/i.test(String(t || ''));

/**
 * Plain-text script → the same object shape as the story JSON.
 *   Tên truyện: …            Nhân vật: Táo (táo) - vest đen; Dâu (dâu tây) - váy đỏ
 *   Cảnh 1: <setting>        (or scenes separated by a blank line)
 *   Bối cảnh: … / Máy quay: … / Tóm tắt: … / Diễn biến: …
 *   Táo: câu thoại           (speaker = a known name, or a short name before the colon)
 *   any other line           → part of the action
 */
function parseStoryText(text) {
  const out = { title: '', cast: [], scenes: [] };
  const known = new Set(story.cast.map(c => c.name.toLowerCase()));
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const headed = lines.some(l => /^\s*(#+\s*)?(cảnh|canh|scene|phân cảnh)\s*\d+/i.test(l));
  let cur = null;
  const flush = () => {
    if (cur && (cur.action.length || cur.lines.length || cur.setting || cur.summary)) {
      out.scenes.push({ ...cur, action: cur.action.join(' ').trim() });
    }
    cur = null;
  };
  const start = setting => { flush(); cur = { setting: setting || '', summary: '', camera: '', action: [], lines: [], cast: [] }; };
  const field = (line, ...names) => {
    const m = new RegExp(`^\\s*[-*•]?\\s*(?:${names.join('|')})\\s*[:：]\\s*(.*)$`, 'i').exec(line);
    return m ? m[1].trim() : null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { if (!headed && cur) flush(); continue; }
    let v;
    if ((v = field(line, 'tên truyện', 'ten truyen', 'tiêu đề', 'title')) != null) { out.title = v; continue; }
    if ((v = field(line, 'nhân vật', 'nhan vat', 'characters?', 'cast')) != null && !cur) {
      for (const part of v.split(/[;\n]|,(?![^()]*\))/)) {
        const m = /^\s*([^(\-–:]+?)\s*(?:\(([^)]*)\))?\s*(?:[-–:]\s*(.+))?\s*$/.exec(part);
        if (m && m[1].trim()) { out.cast.push({ name: m[1].trim(), fruit: (m[2] || '').trim(), outfit: (m[3] || '').trim() }); known.add(m[1].trim().toLowerCase()); }
      }
      continue;
    }
    const head = /^(?:#+\s*)?(?:cảnh|canh|scene|phân cảnh)\s*\d+\s*[:.\-–)]?\s*(.*)$/i.exec(line);
    if (head) { start(head[1].trim()); continue; }
    if (!cur) start('');
    if ((v = field(line, 'bối cảnh', 'boi canh', 'địa điểm', 'setting', 'location')) != null) { cur.setting = v; continue; }
    if ((v = field(line, 'máy quay', 'may quay', 'góc máy', 'camera', 'shot')) != null) { cur.camera = v; continue; }
    if ((v = field(line, 'tóm tắt', 'tom tat', 'summary')) != null) { cur.summary = v; continue; }
    if ((v = field(line, 'diễn biến', 'dien bien', 'hành động', 'hanh dong', 'action')) != null) { cur.action.push(v); continue; }
    if ((v = field(line, 'thoại', 'thoai', 'dialogue')) != null) { cur.lines.push(v); continue; }
    // "Táo: câu nói" — a known name, or a short name (≤ 4 words) before the colon
    const say = /^[-*•]?\s*([^:：]{1,30}?)\s*[:：]\s*["“]?(.+?)["”]?$/.exec(line);
    if (say && (known.has(say[1].toLowerCase()) || (say[1].split(/\s+/).length <= 4 && !/[.!?]/.test(say[1])))) {
      cur.lines.push({ who: say[1].trim(), text: say[2].trim() });
      continue;
    }
    cur.action.push(line);
  }
  flush();
  if (!out.scenes.length) throw new Error('không tìm thấy cảnh nào — bắt đầu mỗi cảnh bằng "Cảnh 1:", hoặc cách các cảnh bằng một dòng trống.');
  return out;
}
/** Parsed input of the import box: JSON or plain text. */
function parseScript(text) {
  return looksJson(text) ? parseLooseJson(text) : parseStoryText(text);
}

/** JSON.parse that tolerates a code fence / prose around it and trailing commas. */
function parseLooseJson(text) {
  const src = String(text || '').trim();
  if (!src) throw new Error('chưa có nội dung.');
  try { return JSON.parse(src); }
  catch (first) {
    const a = Math.min(...['{', '['].map(ch => src.indexOf(ch)).filter(i => i >= 0));
    const b = Math.max(src.lastIndexOf('}'), src.lastIndexOf(']'));
    if (!(a >= 0 && b > a)) throw new Error('không phải JSON hợp lệ.');
    try { return JSON.parse(src.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); }
    catch (e) { throw new Error(jsonErrorText(src, e) || first.message); }
  }
}
/** "dòng 12, cột 5: …" from a JSON.parse error (V8 reports "position N"). */
function jsonErrorText(src, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return 'JSON lỗi cú pháp — ' + err.message;
  const pos = Number(m[1]);
  const before = src.slice(0, pos);
  const line = before.split('\n').length, col = pos - before.lastIndexOf('\n');
  const near = src.slice(Math.max(0, pos - 15), pos + 15).replace(/\s+/g, ' ');
  return `lỗi ở dòng ${line}, cột ${col} (gần: "${near}") — thiếu dấu phẩy, ngoặc hoặc dấu nháy?`;
}
/** Live status under the JSON box. */
function checkJson() {
  const el = $('stJsonCheck');
  if (!el) return;
  try {
    const text = $('stImportText').value;
    if (!text.trim()) { el.textContent = ''; return; }
    const data = parseScript(text);
    const meta = readStoryMeta(data);
    const scenes = Array.isArray(data) ? data : (data.scenes ?? data.canh ?? data.shots ?? data.story?.scenes ?? []);
    const nScenes = Array.isArray(scenes) ? scenes.length : 0;
    if (!nScenes && !meta.cast.length && !meta.rules.length && !meta.avoid.length) throw new Error('chưa có cảnh ("scenes") hay nhân vật / quy tắc.');
    const nLines = (Array.isArray(scenes) ? scenes : []).reduce((n, sc) => n + (Array.isArray(sc?.lines) ? sc.lines.length : Array.isArray(sc?.dialogue) ? sc.dialogue.length : 0), 0);
    const parts = [`${nScenes} cảnh`, nLines && `${nLines} câu thoại`, meta.cast.length && `${meta.cast.length} nhân vật`,
      meta.rules.length && `${meta.rules.length} quy tắc`, meta.avoid.length && `${meta.avoid.length} điều tránh`, meta.style && `phong cách "${meta.style.slice(0, 40)}"`].filter(Boolean);
    el.className = 'st-json-check ok';
    el.textContent = `✓ ${looksJson(text) ? 'JSON hợp lệ' : 'Văn bản'} · ${parts.join(' · ')}${nScenes ? '' : ' — chưa có cảnh, nhập xong để Gemini viết'}`;
  } catch (err) {
    el.className = 'st-json-check bad';
    el.textContent = '⚠ ' + err.message;
  }
}

/** Plain text of any JSON value: strings as is, arrays → items, objects → "key: value". */
function flatText(v) {
  if (v == null || v === false) return [];
  if (typeof v === 'string' || typeof v === 'number') return [String(v).trim()].filter(Boolean);
  if (v === true) return [];
  if (Array.isArray(v)) return v.flatMap(flatText);
  return Object.entries(v).flatMap(([k, x]) => {
    if (/^(enabled|priority|reuse_same_reference)$/i.test(k)) return [];
    const inner = flatText(x);
    return typeof x === 'string' && !/^(rules|composition|instruction|items)$/i.test(k) ? inner.map(t => `${k.replace(/_/g, ' ')}: ${t}`) : inner;
  });
}
const FRUIT_EN = Object.fromEntries(FRUITS.map(f => [f[2], f[1]]));
/**
 * Everything except the scenes: title / style / ratio / scene count, characters (an array, or an
 * object keyed by id like {"banana": {…}}), story-wide rules, things to avoid. aliases maps keys → names.
 */
function readStoryMeta(data) {
  const meta = { title: '', style: '', ratio: '', count: 0, cast: [], rules: [], avoid: [], aliases: {} };
  if (!data || Array.isArray(data)) return meta;
  const proj = data.project || data.meta || data.settings || {};
  const g = data.global_image_rules || data.image_rules || data.global_rules || {};
  meta.title = pick(proj, 'title', 'name') || pick(data, 'title', 'ten_truyen');
  meta.styleId = STORY_STYLES[data.style_id] ? data.style_id : '';
  meta.style = [pick(proj, 'style', 'art_style', 'visual_style') || pick(data, 'style'), pick(g, 'visual_style'), pick(g, 'lighting')]
    .filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
  meta.ratio = pick(proj, 'aspect_ratio', 'ratio') || pick(g, 'aspect_ratio') || pick(data, 'aspect_ratio', 'ratio');
  meta.count = Number(proj.image_count ?? proj.scene_count ?? proj.scenes ?? data.scene_count) || 0;
  // rules: the image rules (minus what became style / ratio), continuity, any plain "rules"
  const gRest = Object.fromEntries(Object.entries(g).filter(([k]) => !/^(visual_style|lighting|aspect_ratio)$/i.test(k)));
  meta.rules = [...flatText(gRest), ...flatText(data.scene_continuity?.rules ?? data.continuity_rules ?? data.continuity), ...flatText(data.rules ?? data.style_rules)]
    .filter((x, i, a) => a.indexOf(x) === i);
  const neg = data.negative_prompt ?? data.negative ?? data.avoid ?? data.negative_prompts;
  meta.avoid = typeof neg === 'string' ? neg.split(/[,\n]/).map(x => x.trim()).filter(Boolean) : flatText(neg);
  // characters
  const rawCast = data.cast ?? data.characters ?? data.nhan_vat ?? [];
  const entries = Array.isArray(rawCast) ? rawCast.map(c => [null, c]) : Object.entries(rawCast);
  for (const [key, c] of entries) {
    if (typeof c === 'string') { meta.cast.push({ name: c.trim() }); continue; }
    if (!c || typeof c !== 'object') continue;
    const name = pick(c, 'name', 'ten') || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');
    if (!name) continue;
    const fruitRaw = pick(c, 'fruit', 'qua', 'loai_qua', 'species', 'type');
    const guess = [fruitRaw, key, name].map(x => String(x || '').toLowerCase()).find(x => FRUIT_EN[x]);
    meta.cast.push({
      name, fruit: fruitRaw || (guess ? FRUIT_EN[guess] : ''),
      gender: pick(c, 'gender', 'gioi_tinh', 'sex'),
      personality: pick(c, 'personality', 'tinh_cach', 'traits'),
      look: pick(c, 'look', 'appearance', 'description', 'ngoai_hinh'),
      outfit: pick(c, 'outfit', 'default_outfit', 'clothes', 'costume', 'trang_phuc'),
      voice: pick(c, 'voice', 'giong'),
      rules: flatText(c.consistency_rules ?? c.rules ?? c.quy_tac),
    });
    if (key) meta.aliases[key.toLowerCase()] = name;
  }
  return meta;
}

function importStoryJson(text, mode = 'replace') {
  const data = mode === 'edit' ? parseLooseJson(text) : parseScript(text);
  const meta = readStoryMeta(data);
  const rawScenes = Array.isArray(data) ? data : (data.scenes ?? data.canh ?? data.shots ?? data.story?.scenes ?? []);
  const scenes = (Array.isArray(rawScenes) ? rawScenes : []).slice(0, 30).map(toScene)
    .filter(sc => sc.action || sc.setting || sc.summary || sc.lines.length);
  const hasMeta = meta.cast.length || meta.rules.length || meta.avoid.length || meta.style || meta.title;
  if (!scenes.length && !hasMeta) throw new Error('không tìm thấy cảnh ("scenes": [ … ]) hay nhân vật / quy tắc nào.');
  // scene casts may use the characters' keys ("banana") instead of names
  for (const sc of scenes) {
    sc.cast = sc.cast.map(n => meta.aliases[n.toLowerCase()] || n);
    for (const l of sc.lines) l.who = meta.aliases[String(l.who).toLowerCase()] || l.who;
  }
  applyStoryMeta(meta, mode);
  if (!scenes.length) { saveStories(); return { count: 0, kept: 0, meta }; }
  // A scene whose place + action didn't change keeps its id, picture and video
  let kept = 0;
  if (mode !== 'append') {
    const key = sc => `${String(sc.setting || '').trim()}\u0000${String(sc.action || '').trim()}`;
    const pool = [...story.scenes];
    for (const sc of scenes) {
      const k = pool.findIndex(o => key(o) === key(sc));
      if (k < 0) continue;
      const old = pool.splice(k, 1)[0];
      Object.assign(sc, { id: old.id, image: old.image, video: old.video });
      if (old.image || old.video) kept++;
    }
    const lost = pool.filter(o => o.image || o.video).length;
    if (lost && !confirm(`${lost} cảnh có ảnh/video sẽ bị thay (bối cảnh hoặc diễn biến đã đổi, hoặc bị xoá). Tiếp tục?`)) throw new Error('đã huỷ.');
  }

  // characters only named in the scenes join the cast too
  mergeCast(scenes.flatMap(sc => sc.cast).map(name => ({ name })), mode);
  // match the scenes' names to the cast's spelling
  for (const sc of scenes) {
    sc.cast = [...new Set(sc.cast.map(n => castByName(n)?.name || n))];
    for (const l of sc.lines) l.who = castByName(l.who)?.name || l.who;
  }

  story.scenes = mode === 'append' ? [...story.scenes, ...scenes] : scenes;
  if (!Array.isArray(data)) {
    if (mode !== 'append') {
      story.logline = pick(data, 'logline');
      if (Array.isArray(data.outline)) story.outline = data.outline.map(str).filter(Boolean);
    }
  }
  if (mode === 'replace') story.notes = [];
  saveStories();
  return { count: scenes.length, kept, meta };
}

/** Add / update characters. edit mode: the JSON wins; import: only fill what's empty. */
function mergeCast(list, mode) {
  for (const c of list) {
    if (!c.name) continue;
    const have = castByName(c.name);
    if (have) {
      for (const k of ['fruit', 'gender', 'personality', 'look', 'outfit', 'voice']) if (c[k] && (mode === 'edit' || !have[k])) have[k] = c[k];
      if (listOf(c.rules).length && (mode === 'edit' || !listOf(have.rules).length)) have.rules = listOf(c.rules).join('\n');
    } else {
      story.cast.push({ id: stId('p'), name: c.name, fruit: c.fruit || '', gender: c.gender || '', personality: c.personality || '',
        look: c.look || '', outfit: c.outfit || '', voice: c.voice || '', rules: listOf(c.rules).join('\n'), image: '' });
    }
  }
}
/** Title / style / ratio / scene count / rules / avoid / characters from a settings JSON. */
function applyStoryMeta(meta, mode) {
  const overwrite = mode !== 'append';
  if (meta.title && (overwrite || story.title === 'Truyện mới')) story.title = meta.title;
  if (meta.styleId) story.style = meta.styleId;
  else if (meta.style && overwrite) { story.style = 'custom'; story.customStyle = meta.style; }
  if (meta.ratio && stOpts.video.ratios.includes(meta.ratio)) story.ratio = meta.ratio;
  if (meta.count >= 2) story.sceneCount = Math.min(12, meta.count);
  if (meta.rules.length) story.rules = (overwrite ? meta.rules : [...storyRules(), ...meta.rules.filter(r => !storyRules().includes(r))]).join('\n');
  if (meta.avoid.length) story.negative = (overwrite ? meta.avoid : [...storyAvoid(), ...meta.avoid.filter(r => !storyAvoid().includes(r))]).join('\n');
  mergeCast(meta.cast, mode === 'edit' || mode === 'replace' ? 'edit' : mode);
}

function addCharacter(fruitVi) {
  const f = FRUITS.find(x => x[1] === fruitVi);
  const taken = new Set(story.cast.map(c => c.name));
  let name = fruitVi ? `${fruitVi}` : 'Nhân vật';
  for (let k = 2; taken.has(name); k++) name = `${fruitVi || 'Nhân vật'} ${k}`;
  story.cast.push({ id: stId('p'), name, fruit: fruitVi, look: f ? (headStyle() ? `đầu là quả ${f[1].toLowerCase()} thật, khuôn mặt người biểu cảm, lông mày sắc nét` : `quả ${f[1].toLowerCase()} dễ thương, mắt to long lanh, mặt tươi cười, có tay chân`) : '', outfit: '', voice: '', image: '' });
  saveStories();
  renderStory();
}

// ---------- Gemini ----------
async function withBusy(kind, fn) {
  stBusy = kind;
  renderStory();
  try { return await fn(); } finally { stBusy = ''; renderStory(); }
}

async function writeScript() {
  if (story.scenes.some(s => s.image || s.video) && !confirm('Viết lại sẽ thay toàn bộ các cảnh hiện tại (kể cả ảnh/video đã gắn). Tiếp tục?')) return;
  showMsg('info', '✨ Gemini đang viết kịch bản… (khoảng 30–90 giây)');
  await withBusy('write', async () => {
    try {
      const r = await api('/api/story/write', {
        idea: story.idea, tone: story.tone, scenes: story.sceneCount, seconds: story.duration || 8, style: styleText(), lang: story.lang || 'vi', head: headStyle(),
        cast: story.cast.map(c => ({ name: c.name, fruit: c.fruit, outfit: c.outfit, voice: c.voice,
          look: [genderEn(c), c.personality && `personality: ${c.personality}`, c.look, ...listOf(c.rules)].filter(Boolean).join('; ') })),
        rules: [...storyRules(), ...storyAvoid().map(a => `Tránh: ${a}`)],
      });
      story.logline = r.logline; story.outline = r.outline; story.notes = [];
      if (r.title && (!story.title || story.title === 'Truyện mới')) story.title = r.title;
      // Characters Gemini invented (or the user hadn't described) join the cast
      for (const c of r.cast) {
        const have = castByName(c.name);
        if (have) { for (const k of ['look', 'outfit', 'voice', 'fruit', 'personality']) if (!have[k]) have[k] = c[k]; }
        else story.cast.push({ id: stId('p'), ...c, image: '' });
      }
      story.scenes = r.scenes.map(sc => ({ id: stId('c'), ...sc, image: '', video: '' }));
      saveStories();
      showMsg('info', `✨ Xong kịch bản "${story.title}" — ${story.scenes.length} cảnh. Xem lại, sửa nếu cần, rồi vẽ ảnh mẫu nhân vật (🎨) trước khi tạo ảnh cảnh.`);
    } catch (e) { showMsg('err', 'Viết kịch bản lỗi: ' + e.message); }
  });
}

/** Gemini re-reads the current script (with the user's edits), fixes logic holes, says what changed. */
async function reviewScript() {
  showMsg('info', '🔍 Gemini đang đọc lại và sửa logic kịch bản… (khoảng 30–90 giây)');
  await withBusy('review', async () => {
    try {
      const r = await api('/api/story/review', {
        story: { title: story.title, logline: story.logline, cast: story.cast, scenes: story.scenes },
        tone: story.tone, seconds: story.duration || 8, style: styleText(), note: story.fixNote, lang: story.lang || 'vi',
        rules: [...storyRules(), ...storyAvoid().map(a => `Tránh: ${a}`), ...story.cast.flatMap(c => listOf(c.rules).map(r => `${c.name}: ${r}`))],
      });
      const old = story.scenes;
      // A scene keeps its image/video only when what it shows didn't change
      const same = (a, b) => a && b && a.setting.trim() === b.setting.trim() && a.action.trim() === b.action.trim();
      story.scenes = r.scenes.map((sc, i) => {
        const prev = old.find(o => same(o, sc)) || null;
        return { id: prev?.id || stId('c'), ...sc, image: prev?.image || '', video: prev?.video || '' };
      });
      if (r.logline) story.logline = r.logline;
      if (r.outline.length) story.outline = r.outline;
      if (r.title && story.title === 'Truyện mới') story.title = r.title;
      for (const c of r.cast) { const have = castByName(c.name); if (have && !have.personality) have.personality = c.personality; }
      story.notes = r.notes.length ? r.notes : ['Không thấy lỗi logic đáng kể — giữ nguyên.'];
      const lost = old.filter(o => (o.image || o.video) && !story.scenes.some(n => n.id === o.id)).length;
      saveStories();
      showMsg('info', `🔍 Đã sửa kịch bản (${r.notes.length} thay đổi — xem mục 3).` + (lost ? ` ${lost} cảnh đổi nội dung nên bỏ ảnh/video cũ, cần tạo lại.` : ''));
    } catch (e) { showMsg('err', 'Kiểm tra logic lỗi: ' + e.message); }
  });
}

/** Dialogue language. Going to English offers to translate the lines already written. */
async function changeLang(lang) {
  story.lang = lang;
  saveStories();
  const lines = story.scenes.flatMap(sc => sc.lines).filter(l => l.text.trim());
  if (lang === 'en' && lines.some(l => needsEn(l.text)) && confirm('Dịch các câu thoại hiện có sang tiếng Anh?')) {
    try {
      for (const l of lines) if (needsEn(l.text)) l.text = (await api(`/api/translate?text=${encodeURIComponent(l.text)}`)).text || l.text;
      saveStories();
      renderScenes();
      showMsg('info', 'Đã dịch thoại sang tiếng Anh.');
    } catch (e) { showMsg('err', 'Dịch thoại lỗi: ' + e.message); }
  } else if (lang === 'vi' && lines.some(l => !needsEn(l.text))) {
    showMsg('info', 'Thoại hiện có vẫn là tiếng Anh — sửa tay, hoặc bấm "✨ Gemini viết kịch bản" / "🔍 Kiểm tra & sửa logic" để viết lại bằng tiếng Việt.');
  }
}

async function drawCharacter(c, i) {
  if (!c.name.trim()) { showMsg('warn', 'Đặt tên nhân vật trước.'); return; }
  showMsg('info', `🎨 Gemini đang vẽ ${c.name}… (khoảng 30–90 giây, không tốn credit Flow)`);
  await withBusy('draw' + i, async () => {
    try {
      const { url } = await api('/api/story/character', { name: c.name, fruit: c.fruit, look: c.look, outfit: c.outfit || '', outfitImage: c.outfitImage || '', style: styleText(), head: headStyle() });
      c.image = url;
      saveStories();
      showMsg('info', `🎨 Đã vẽ ${c.name}. Chưa ưng thì bấm vẽ lại.`);
    } catch (e) { showMsg('err', 'Vẽ nhân vật lỗi: ' + e.message); }
  });
}

// ---------- Flow: scene images / videos ----------
async function makeImages(scenes) {
  showMsg('info', 'Đang dịch mô tả cảnh sang tiếng Anh cho Flow…');
  await ensureEnglish(scenes);
  const shots = scenes.map(sc => ({
    label: `${story.title.slice(0, 30)} · Cảnh ${story.scenes.indexOf(sc) + 1}`,
    prompt: sceneImagePrompt(sc),
    refs: sceneCast(sc).filter(c => c.image).map(c => c.image),
  }));
  const noRef = scenes.filter(sc => !sceneCast(sc).some(c => c.image));
  if (noRef.length && !confirm(`${noRef.length} cảnh chưa có ảnh mẫu nhân vật — nhân vật có thể trông khác nhau giữa các cảnh. Vẫn tạo?`)) return;
  if (!confirm(`Tạo ${shots.length} ảnh cảnh bằng Flow (${story.imageModel})?\nTốn credit cho ${shots.length} ảnh.`)) return;
  try {
    const b = await api('/api/story/images', { storyId: story.id, model: story.imageModel, ratio: story.ratio, confirm: true, shots });
    for (const sc of scenes) { sc.status = 'pending'; }
    story.job = { kind: 'image', batchId: b.id, sceneIds: scenes.map(s => s.id) };
    saveStories();
    trackBatch(b);
  } catch (e) { showMsg('err', 'Không tạo được ảnh: ' + e.message); }
}

/**
 * Which scenes get a video now and where each one starts:
 * { image } its own picture · { fromVideo } last frame of the previous scene's existing clip ·
 * { fromPrev } last frame of the clip made just before it in this same run.
 */
function videoPlan() {
  let todo = story.scenes.filter(s => !s.video);
  if (!todo.length) todo = story.scenes.filter(s => s.image); // all done → redo the ones with a picture
  const sources = [];
  for (const sc of todo) {
    const i = story.scenes.indexOf(sc);
    const label = `Cảnh ${i + 1}`;
    if (isChained(sc, i)) {
      const prev = story.scenes[i - 1];
      if (todo.includes(prev)) sources.push({ label, fromPrev: true });
      else if (prev.video) sources.push({ label, fromVideo: prev.video });
      else return { ok: false, error: `${label} nối từ cảnh ${i} nhưng cảnh ${i} chưa có video.` };
    } else if (sc.image) sources.push({ label, image: sc.image });
    else return { ok: false, error: `${label} chưa có ảnh (tạo ảnh, hoặc bật 🔗 nối từ cảnh trước).` };
  }
  // a run can't start with "continue from the previous clip of this run"
  if (sources[0]?.fromPrev) return { ok: false, error: 'Cảnh đầu tiên cần ảnh.' };
  if (!todo.length) return { ok: false, error: 'Chưa có cảnh nào sẵn sàng.' };
  return { ok: true, scenes: todo, sources };
}

async function makeVideos() {
  const plan = videoPlan();
  if (!plan.ok) { showMsg('err', plan.error); return; }
  const { scenes, sources } = plan;
  const own = sources.filter(x => x.image).map(x => x.image);
  if (new Set(own).size !== own.length) { showMsg('err', 'Có 2 cảnh dùng chung một ảnh — đổi ảnh một cảnh rồi thử lại.'); return; }
  await ensureEnglish(scenes);
  const body = {
    sources, prompts: scenes.map(sceneVideoPrompt),
    model: story.videoModel, duration: Number(story.duration), ratio: story.ratio, audio: story.voice === 'speak',
    folder: `story_${story.id}`,
  };
  const chained = sources.filter(x => !x.image).length;
  showMsg('info', 'Đang hỏi Flow số credit (điền thử cảnh đầu, chưa tốn credit)…');
  await withBusy('check', async () => {
    try {
      const r = await api('/api/video', { ...body, confirm: false });
      if (!confirm(`Tạo ${scenes.length} video cảnh (${story.videoModel}, ${story.duration} giây)${chained ? `, ${chained} cảnh nối tiếp từ khung cuối cảnh trước` : ''}?\nFlow báo ${r.credits} credit/video → tổng ${r.credits * scenes.length} credit.`)) { showMsg('info', 'Đã huỷ, chưa tốn credit.'); return; }
      const b = await api('/api/video', { ...body, confirm: true, maxCredits: r.credits });
      for (const sc of scenes) { sc.status = 'pending'; if (isChained(sc)) sc.video = ''; }
      story.job = { kind: 'video', batchId: b.id, sceneIds: scenes.map(s => s.id) };
      saveStories();
      setTimeout(() => trackBatch(b), 0);
    } catch (e) { showMsg('err', 'Không tạo được video: ' + e.message); }
  });
}

async function makeFilm() {
  if (!story.scenes[0]?.image) { showMsg('err', 'Cảnh 1 cần ảnh (tạo ảnh cảnh 1 trước).'); return; }
  const empty = story.scenes.find(sc => !sc.action.trim() && !sc.lines.some(l => l.text.trim()));
  if (empty) { showMsg('err', `Cảnh ${story.scenes.indexOf(empty) + 1} chưa có diễn biến hay thoại.`); return; }
  await ensureEnglish(story.scenes);
  const { first, steps } = filmPlan();
  const body = {
    image: first.image, firstPrompt: sceneVideoPrompt(first), extends: steps.map(({ label, prompt }) => ({ label, prompt })),
    model: story.videoModel, duration: Number(story.duration), ratio: story.ratio, audio: story.voice === 'speak',
    folder: `story_${story.id}`,
  };
  showMsg('info', 'Đang hỏi Flow số credit cho video cảnh 1 (chưa tốn credit)…');
  await withBusy('check', async () => {
    try {
      const r = await api('/api/story/film', { ...body, confirm: false });
      const ext = steps.length * (r.extendCredits || 12);
      if (!confirm(`Tạo phim ${story.scenes.length} cảnh bằng "Kéo dài" của Flow?\n• Cảnh 1: video ${story.duration}s — ${r.credits} credit\n• ${steps.length} lần kéo dài × ~${r.extendCredits || 12} credit = ~${ext} credit\nTổng ~${r.credits + ext} credit. Mất khoảng ${Math.ceil((2 + steps.length * 1.5))} phút.`)) { showMsg('info', 'Đã huỷ, chưa tốn credit.'); return; }
      const b = await api('/api/story/film', { ...body, confirm: true, maxCredits: r.credits, maxExtendCredits: Math.max(20, (r.extendCredits || 12) + 4) });
      story.film = ''; story.filmSeconds = 0;
      for (const sc of story.scenes) sc.status = 'pending';
      story.job = { kind: 'film', batchId: b.id, sceneIds: [first.id, ...steps.map(st => st.sceneId)] };
      saveStories();
      setTimeout(() => trackBatch(b), 0);
    } catch (e) { showMsg('err', 'Không tạo được phim: ' + e.message); }
  });
}

/** Copy a batch's results onto the scenes; keep polling until it finishes. */
function applyBatch(b) {
  const job = story.job;
  if (!job || job.batchId !== b.id) return;
  b.items.forEach((it, k) => {
    const sc = story.scenes.find(s => s.id === job.sceneIds[k]);
    if (!sc) return;
    sc.status = it.status;
    if (job.kind === 'film') return; // statuses only; the film itself is story.film
    if (job.kind === 'image' && it.images?.[0]) { sc.image = it.images[0]; sc.video = ''; }
    if (job.kind === 'video' && it.frame && isChained(sc)) sc.image = it.frame;
    if (job.kind === 'video' && it.videos?.[0]) sc.video = it.videos[0];
  });
  if (b.finishedAt) {
    if (job.kind === 'film' && b.film) { story.film = b.film; story.filmSeconds = b.filmSeconds || 0; }
    story.job = null;
    for (const sc of story.scenes) if (sc.status !== 'error') sc.status = '';
  }
  saveStories();
}
async function trackBatch(b) {
  clearTimeout(stPollTimer);
  const storyId = story.id;
  // show it in the results column like other batches
  activeBatch = b;
  renderBatch();
  const sig = () => JSON.stringify([story.job, story.film, story.scenes.map(s => [s.status, s.image, s.video])]);
  const before = sig();
  applyBatch(b);
  if (sig() !== before || !$('stScenes')) renderStory(); // re-render only on change (keeps typing focus)
  if (b.finishedAt) {
    const done = b.items.filter(i => i.status === 'done').length;
    showMsg(done === b.items.length ? 'info' : 'warn', `${b.kind === 'video' ? '🎬' : '🖼'} Xong ${done}/${b.items.length} ${b.kind === 'video' ? 'video' : 'ảnh'} cảnh.` +
      (done < b.items.length ? ' Cảnh lỗi: ' + b.items.filter(i => i.status !== 'done').map(i => `${i.label}${i.error ? ` (${i.error})` : ''}`).join('; ') : ''));
    return;
  }
  stPollTimer = setTimeout(async () => {
    if (story.id !== storyId) return; // switched story — resumeJob() picks it up when switching back
    try { trackBatch(await api(`/api/batch?id=${encodeURIComponent(b.id)}`)); }
    catch (e) { story.job = null; saveStories(); renderStory(); showMsg('err', e.message); }
  }, 3000);
}
/** After a reload / story switch: continue following a batch still running on the server. */
async function resumeJob() {
  if (!story.job) return;
  try { trackBatch(await api(`/api/batch?id=${encodeURIComponent(story.job.batchId)}`)); }
  catch { story.job = null; for (const sc of story.scenes) if (sc.status === 'pending' || sc.status === 'running') sc.status = ''; saveStories(); renderStory(); }
}

async function joinMovie() {
  const clips = story.scenes.filter(s => s.video).map(s => ({ url: s.video, text: story.voice === 'subs' ? subtitleOf(s) : '' }));
  if (!clips.length) return;
  openTab('edit');
  await addToEditor(clips, { replace: true, name: story.title });
}

// ---------- init ----------
async function initStory() {
  loadStories();
  try {
    const o = await api('/api/options');
    stOpts = { models: o.models || [], ratios: o.ratios || [], video: { models: o.video?.models || [], credits: o.video?.credits || {}, ratios: o.video?.ratios || ['9:16', '16:9'] } };
  } catch { /* keep defaults */ }
  renderStory();
  resumeJob();
}
