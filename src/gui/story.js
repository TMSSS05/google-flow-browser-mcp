// "Truyện hoạt hình" (cartoon story) helpers: prompts for Gemini (write the script, draw a
// character) and parsing Gemini's JSON answer. The page builds the Flow image/video prompts.

const clean = (s, max = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** User rules (story-wide + per character) Gemini must respect, as a prompt block ('' when none). */
function rulesBlock(rules) {
  const list = (Array.isArray(rules) ? rules : String(rules || '').split('\n')).map(r => clean(r, 300)).filter(Boolean).slice(0, 40);
  return list.length ? `\nQUY TẮC BẮT BUỘC CỦA NGƯỜI DÙNG (ưu tiên cao nhất, không được vi phạm):\n${list.map(r => `- ${r}`).join('\n')}\n` : '';
}

function castLines(cast) {
  return cast.length
    ? cast.map(c => `- ${clean(c.name, 60)}: ${clean(c.fruit, 60)}${c.look ? `, ngoại hình: ${clean(c.look)}` : ''}${c.outfit ? `, trang phục: ${clean(c.outfit, 200)}` : ''}${c.voice ? `, giọng: ${clean(c.voice, 60)}` : ''}`).join('\n')
    : '(chưa có — hãy tự nghĩ 2–3 nhân vật là trái cây/rau củ được nhân hoá, có tên tiếng Việt dễ thương, tính cách đối lập nhau)';
}

// Rules shared by "write" and "fix": what makes a 40-second story hold together
const LOGIC_RULES = seconds => `QUY TẮC LOGIC (bắt buộc):
1. Có MỘT nhân vật chính với MỘT mục tiêu rõ ràng (muốn gì, vì sao) và MỘT trở ngại chính. Người xem phải hiểu điều đó ngay từ cảnh 1–2.
2. Chuỗi nhân quả: mỗi cảnh xảy ra VÌ cảnh trước (dùng được chữ "vì thế…", "nhưng…" để nối). Không có sự kiện ngẫu nhiên từ trên trời rơi xuống, không nhân vật xuất hiện vô cớ.
3. Leo thang: mỗi cảnh làm tình huống căng/hài hơn cảnh trước, không lặp lại cùng một ý.
4. Cài – mở: twist hoặc cú chốt ở cuối phải được CÀI SẴN bằng một chi tiết nhìn thấy được ở cảnh trước (một đồ vật, một câu nói, một thói quen). Khi xem lại thấy "à, thì ra vậy".
5. Kết thúc giải quyết mục tiêu/trở ngại đã nêu (thành công, thất bại hài hước, hoặc ngược đời) — không bỏ lửng.
6. Nhân vật hành động theo tính cách đã định; không đổi tính giữa chừng nếu không có lý do.
7. Liên tục: cùng địa điểm thì tả bối cảnh giống nhau; đồ vật, trang phục, thời gian trong ngày khớp giữa các cảnh; ai đang cầm gì thì cảnh sau vẫn cầm (trừ khi đã đặt xuống).
8. Thoại phải đẩy truyện đi (lộ mục tiêu, gây xung đột, hoặc chốt câu hài) — không thoại chào hỏi vô nghĩa. Tối đa 2 câu/cảnh, mỗi câu dưới 12 từ để nói kịp trong ${seconds} giây.
9. Mỗi cảnh ${seconds} giây chỉ chứa MỘT hành động chính quay được trong một cú máy (không "đi đến chợ rồi về nhà rồi nấu ăn" trong một cảnh).
10. Thử bỏ từng cảnh: nếu bỏ đi mà truyện vẫn hiểu được thì cảnh đó thừa — viết lại cho nó có vai trò.`;

const langName = lang => (lang === 'en' ? 'TIẾNG ANH (English)' : 'tiếng Việt');
const jsonShape = lang => `{
  "title": "tên truyện tiếng Việt",
  "logline": "1 câu tiếng Việt: AI muốn GÌ, nhưng VƯỚNG gì, và chuyện gì xảy ra",
  "outline": ["mở đầu: …", "xung đột: …", "leo thang: …", "cao trào: …", "kết/twist: …"],
  "cast": [ { "name": "tên", "fruit": "loại quả (tiếng Việt)", "personality": "tính cách (tiếng Việt)", "look": "ngoại hình (tiếng Việt): thân quả, mặt, màu sắc", "outfit": "trang phục và phụ kiện (tiếng Việt)", "voice": "giọng nói, vd: giọng nữ miền Bắc, nhí nhảnh" } ],
  "scenes": [
    { "purpose": "vai trò của cảnh trong truyện (tiếng Việt, vd: cài chi tiết chiếc tẩu)", "summary": "tóm tắt tiếng Việt, nêu rõ vì sao cảnh này xảy ra sau cảnh trước", "setting": "bối cảnh (tiếng Việt): nơi chốn, thời điểm trong ngày, chi tiết nền", "cast": ["tên nhân vật có mặt"], "action": "diễn biến (tiếng Việt): MỘT hành động chính, tư thế, biểu cảm; dùng tên nhân vật", "camera": "máy quay (tiếng Việt): cỡ cảnh / chuyển động máy", "lines": [ { "who": "tên", "text": "câu thoại bằng ${langName(lang)}" } ] }
  ]
}`;

/**
 * Prompt asking Gemini for a story split into short video scenes, as JSON.
 * Outline first (logline + beats), then scenes that follow from it.
 * input: { idea, tone, scenes, seconds, style, cast: [{ name, fruit, look, outfit, voice }] }
 */
export function storyPrompt({ idea, tone, scenes = 5, seconds = 8, style = '', cast = [], lang = 'vi', head = false, rules = [] }) {
  const n = Math.min(Math.max(Number(scenes) || 5, 2), 12);
  return `Bạn là biên kịch phim hoạt hình ngắn cho TikTok/Reels, nổi tiếng vì truyện chặt chẽ, có logic, có cú chốt. ${head ? 'Các nhân vật là NGƯỜI có đầu là quả thật (thân người, mặc quần áo), phong cách phim drama điện ảnh chân thực' : 'Các nhân vật là trái cây được nhân hoá (có mắt, miệng, tay chân, mặc quần áo)'}, bối cảnh đời thường Việt Nam.

Ý tưởng: ${clean(idea, 1500) || 'tự nghĩ một tình huống đời thường gần gũi, có twist bất ngờ nhưng hợp lý ở cuối'}
Giọng điệu: ${clean(tone, 100) || 'hài hước'}
Phong cách hình ảnh: ${clean(style, 300) || '2D cartoon'}
Số cảnh: đúng ${n} cảnh, mỗi cảnh là MỘT đoạn video ${seconds} giây.

Nhân vật:
${castLines(cast)}
${rulesBlock(rules)}
CÁCH LÀM (theo thứ tự):
Bước 1 — viết "logline" (1 câu) và "outline" (5 nhịp: mở đầu, xung đột, leo thang, cao trào, kết/twist).
Bước 2 — chia outline thành đúng ${n} cảnh; mỗi cảnh ghi "purpose" (vai trò trong truyện).
Bước 3 — tự rà lại theo QUY TẮC LOGIC bên dưới; cảnh nào vi phạm thì sửa trước khi trả lời.

${LOGIC_RULES(seconds)}

Định dạng:
- Mọi trường viết bằng tiếng Việt, RIÊNG câu thoại ("lines"."text") viết bằng ${langName(lang)}.
- "setting", "action", "camera", "look", "outfit" mô tả hình ảnh cụ thể, nhìn thấy được để AI vẽ/quay (không dùng tên riêng trong "look").
- Mọi nhân vật đều MẶC QUẦN ÁO hợp tính cách và giữ nguyên trang phục qua các cảnh.

Chỉ trả về MỘT khối JSON hợp lệ, không giải thích, theo đúng mẫu:
${jsonShape(lang)}`;
}

/** Prompt asking Gemini to check an existing script for logic holes and return a fixed version. */
export function reviewPrompt({ story, tone, seconds = 8, style = '', note = '', lang = 'vi', rules = [] }) {
  const n = Array.isArray(story?.scenes) ? story.scenes.length : 5;
  const slim = {
    title: clean(story?.title, 120), logline: clean(story?.logline, 400),
    cast: (story?.cast || []).map(c => ({ name: clean(c.name, 60), fruit: clean(c.fruit, 60), personality: clean(c.personality, 200), look: clean(c.look, 300), outfit: clean(c.outfit, 200), voice: clean(c.voice, 100) })),
    scenes: (story?.scenes || []).map((sc, i) => ({
      no: i + 1, purpose: clean(sc.purpose, 200), summary: clean(sc.summary, 400), setting: clean(sc.setting, 400), cast: sc.cast || [],
      action: clean(sc.action, 500), camera: clean(sc.camera, 200), lines: (sc.lines || []).map(l => ({ who: clean(l.who, 60), text: clean(l.text, 200) })),
    })),
  };
  return `Bạn là biên tập viên kịch bản phim hoạt hình ngắn (nhân vật là trái cây nhân hoá, bối cảnh Việt Nam). Dưới đây là kịch bản ${n} cảnh, mỗi cảnh là một video ${seconds} giây. Giọng điệu: ${clean(tone, 100) || 'hài hước'}. Phong cách hình ảnh: ${clean(style, 300) || '2D cartoon'}.
${note ? `\nYêu cầu thêm của người dùng: ${clean(note, 600)}\n` : ''}${rulesBlock(rules)}
KỊCH BẢN HIỆN TẠI (JSON):
${JSON.stringify(slim, null, 1)}

Việc cần làm:
1. Đọc kỹ và tìm mọi lỗ hổng theo QUY TẮC LOGIC bên dưới: chỗ vô lý, nhảy cóc, nhân vật làm việc không có động cơ, chi tiết không khớp giữa các cảnh, twist không được cài trước, kết bỏ lửng, thoại thừa.
2. Sửa ÍT NHẤT có thể nhưng phải hết lỗi: giữ ý tưởng, nhân vật, số cảnh (${n}) và những cảnh đã tốt; chỉ viết lại phần hỏng. Có thể đổi thứ tự hoặc thay hẳn một cảnh nếu cần.
3. Ghi lại các thay đổi vào "notes" (tiếng Việt, mỗi ý một dòng ngắn, nêu cảnh số mấy và vì sao).

${LOGIC_RULES(seconds)}

Định dạng: mọi trường viết bằng tiếng Việt (kể cả "setting", "action", "camera", "look", "outfit" — nếu đang là tiếng Anh thì chuyển sang tiếng Việt), RIÊNG câu thoại viết bằng ${langName(lang)}.

Chỉ trả về MỘT khối JSON hợp lệ, không giải thích, theo mẫu dưới, thêm trường "notes": ["…"]:
${jsonShape(lang)}`;
}

/** Pull the story JSON out of Gemini's answer (it may wrap it in prose or a code block). */
export function parseStory(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Gemini không trả về kịch bản dạng JSON — thử lại.');
  let data;
  try { data = JSON.parse(s.slice(start, end + 1)); } catch {
    // Common slip: trailing commas
    try { data = JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')); } catch { throw new Error('Kịch bản Gemini trả về bị lỗi định dạng — thử lại.'); }
  }
  const cast = (Array.isArray(data.cast) ? data.cast : []).slice(0, 8).map(c => ({
    name: clean(c.name, 60), fruit: clean(c.fruit, 60), personality: clean(c.personality, 200), look: clean(c.look, 500), outfit: clean(c.outfit, 300), voice: clean(c.voice, 100),
  })).filter(c => c.name);
  const scenes = (Array.isArray(data.scenes) ? data.scenes : []).slice(0, 12).map(sc => ({
    purpose: clean(sc.purpose, 200),
    summary: clean(sc.summary, 400),
    setting: clean(sc.setting, 500),
    cast: (Array.isArray(sc.cast) ? sc.cast : []).map(x => clean(x, 60)).filter(Boolean),
    action: clean(sc.action, 600),
    camera: clean(sc.camera, 200),
    lines: (Array.isArray(sc.lines) ? sc.lines : []).slice(0, 4).map(l => ({ who: clean(l.who, 60), text: clean(l.text, 200) })).filter(l => l.text),
  })).filter(sc => sc.action || sc.setting);
  if (!scenes.length) throw new Error('Gemini không chia được cảnh nào — thử viết ý tưởng cụ thể hơn.');
  return {
    title: clean(data.title, 120), logline: clean(data.logline, 400),
    outline: (Array.isArray(data.outline) ? data.outline : []).slice(0, 8).map(x => clean(x, 300)).filter(Boolean),
    notes: (Array.isArray(data.notes) ? data.notes : []).slice(0, 15).map(x => clean(x, 300)).filter(Boolean),
    cast, scenes,
  };
}

/** Prompt for Gemini to draw one character's reference sheet. */
export function characterPrompt({ name, fruit, look, outfit, style, withOutfitImage = false, head = false }) {
  const kind = head
    ? `một NGƯỜI có thân người thật, nhưng ĐẦU là một quả ${clean(fruit, 60) || 'trái cây'} thật khổng lồ (vỏ quả chân thực, có lá/cuống, kết cấu tự nhiên), trên vỏ quả có khuôn mặt người biểu cảm (mắt, lông mày, mũi, môi) liền mạch như được tạc vào quả.`
    : `một quả ${clean(fruit, 60) || 'trái cây'} được nhân hoá, có khuôn mặt biểu cảm, mắt to, tay chân như người.`;
  return `Vẽ thiết kế nhân vật (character design) cho phim ngắn.
Phong cách: ${clean(style, 400) || '2D cartoon, bold clean outlines, vibrant flat colors, soft shading'}.
Nhân vật "${clean(name, 60)}": ${kind} ${clean(look, 500)}
Trang phục: nhân vật MẶC QUẦN ÁO như người — ${withOutfitImage
    ? `mặc ĐÚNG bộ trang phục trong ảnh đính kèm (giữ nguyên kiểu dáng, màu sắc, chất liệu, hoạ tiết, phụ kiện). Chỉ lấy bộ quần áo, KHÔNG lấy người mẫu, khuôn mặt hay bối cảnh trong ảnh.${outfit ? ` Ghi chú: ${clean(outfit, 300)}` : ''}`
    : clean(outfit, 300) || 'quần áo đời thường hợp tính cách (áo sơ mi/áo phông và quần dài, hoặc váy), có giày dép'}. ${head ? 'Quần áo may đo vừa thân người, chất liệu chân thực.' : 'Quần áo ôm theo thân quả, màu sắc rõ ràng.'}
Chỉ MỘT nhân vật, đứng toàn thân, nhìn thẳng, tư thế tự nhiên thân thiện, nền trắng trơn.
Ảnh khung DỌC (3:4); nhân vật TO, ở giữa, chiếm khoảng 85% chiều cao khung hình, thấy rõ cả mặt, quần áo và giày.
Không chữ, không tên, không logo, không khung viền. Chỉ trả về ảnh, không cần giải thích.`;
}
