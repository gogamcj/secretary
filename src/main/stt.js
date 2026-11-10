// 음성 인식: Whisper 모델을 내 컴퓨터에서 실행합니다 (인터넷 없이 동작, 처음 한 번만 모델 다운로드).
let pipePromise = null;
let loadedModel = '';
let cacheDir = '';

function init(dir) {
  cacheDir = dir;
}

async function getPipe(model, onProgress) {
  if (pipePromise && loadedModel === model) return pipePromise;
  loadedModel = model;
  pipePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (cacheDir) env.cacheDir = cacheDir;
    env.allowRemoteModels = true;
    return pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (onProgress && p.status === 'progress' && p.total) onProgress(Math.round((p.loaded / p.total) * 100), p.file);
      },
    });
  })();
  pipePromise.catch(() => {
    pipePromise = null;
  });
  return pipePromise;
}

/**
 * @param {Float32Array} audio 16kHz 모노 PCM
 * @returns {Promise<string>}
 */
async function transcribe(audio, model, onProgress) {
  const asr = await getPipe(model || 'Xenova/whisper-small', onProgress);
  const out = await asr(audio, { language: 'korean', task: 'transcribe', chunk_length_s: 30 });
  return cleanup(String(out?.text || ''));
}

// Whisper가 소리 없는 구간에서 자주 지어내는 문장을 걸러냅니다.
const HALLUCINATIONS = [/^시청해\s*주셔서\s*감사합니다\.?$/, /^구독과\s*좋아요/, /^MBC\s*뉴스/, /^감사합니다\.?$/, /^\.+$/, /^\(.*\)$/];

function cleanup(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (HALLUCINATIONS.some((r) => r.test(t))) return '';
  return t;
}

/** 호출어를 찾아 떼어냅니다. 호출어가 없으면 null을 돌려줍니다. */
function stripWakeWord(text, wakeWords) {
  const lower = text.toLowerCase();
  for (const w of wakeWords) {
    const idx = lower.indexOf(w.toLowerCase());
    if (idx !== -1 && idx < 12) return afterWake(text.slice(idx + w.length));
  }
  // 정확히 "자비스"가 아니어도 비슷하게 들린 말(차비스, 자비쓰, 잡이스, 자빗으 등)을 호출어로 봅니다.
  if (wakeWords.some((w) => /자비스|jarvis/i.test(w))) {
    const end = fuzzyJarvisEnd(text);
    if (end !== -1) return afterWake(text.slice(end));
  }
  return null;
}

function afterWake(rest) {
  return rest
    .replace(/^(야|아)(?=$|[\s,.!?~])/, '')
    .replace(/^[\s,.!?~]+/, '')
    .trim();
}

// 한글 음절 → [초성, 중성, 종성] 번호
function jamo(ch) {
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return null;
  return [Math.floor(c / 588), Math.floor((c % 588) / 28), c % 28];
}
// 초성: ㅈ12 ㅉ13 ㅊ14 / ㅂ7 ㅃ8 ㅍ17 / ㅅ9 ㅆ10 ㅇ11
// 중성: ㅏ0 ㅐ1 ㅑ2 ㅓ4 ㅔ5 ㅕ6 ㅖ7 / ㅣ20 ㅟ16 ㅢ19 ㅔ5 ㅖ7 / ㅡ18 ㅜ13 ㅠ17 ㅣ20
// 종성: 없음0 ㅅ19 ㅆ20 ㅂ17
const J1 = (j) => [12, 13, 14].includes(j[0]) && [0, 1, 2, 4, 5].includes(j[1]) && [0, 17].includes(j[2]);
const J2 = (j) => [7, 8, 17, 11].includes(j[0]) && [20, 16, 19, 5, 7].includes(j[1]);
const J3 = (j) => [9, 10, 11].includes(j[0]) && [18, 13, 17, 20].includes(j[1]) && [0, 19, 20].includes(j[2]);

/** 앞부분(6음절 안)에서 "자비스"와 비슷한 소리를 찾아, 그 끝 위치를 돌려줍니다. 없으면 -1. */
function fuzzyJarvisEnd(text) {
  const chars = [];
  for (let i = 0; i < text.length && chars.length < 8; i++) {
    if (/\s|[,.!?~]/.test(text[i])) continue;
    chars.push({ ch: text[i], i, j: jamo(text[i]) });
  }
  for (let k = 0; k + 1 < chars.length && k < 6; k++) {
    const a = chars[k].j;
    const b = chars[k + 1].j;
    if (!a || !b || !J1(a) || !J2(b)) continue;
    // 자+빗 (종성 ㅅ/ㅆ)으로 끝나는 경우: "자빗", "자빗으"
    if ([19, 20].includes(b[2])) {
      const c = chars[k + 2]?.j;
      return c && c[0] === 11 && c[1] === 18 ? chars[k + 2].i + 1 : chars[k + 1].i + 1;
    }
    const c = chars[k + 2]?.j;
    if (c && b[2] === 0 && J3(c) && !(a[0] === 14 && b[0] === 11)) {
      // 오탐을 줄이기 위해, 첫 소리가 ㅈ/ㅉ이거나 둘째 소리가 ㅂ/ㅃ/ㅍ일 때만 인정 ("차이스" 같은 말은 제외)
      return chars[k + 2].i + 1;
    }
  }
  return -1;
}

// ---------- 클라우드 음성 인식 (OpenAI) ----------
// 한국어 정확도가 높고, 컴퓨터 성능과 상관없이 1초 안팎으로 빠릅니다.
function toWav(float32, sampleRate = 16000) {
  const buf = Buffer.alloc(44 + float32.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + float32.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(float32.length * 2, 40);
  for (let i = 0; i < float32.length; i++) {
    const v = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

async function transcribeCloud(audio, { apiKey, model = 'gpt-4o-transcribe', prompt = '' }) {
  if (!apiKey) throw new Error('설정에서 OpenAI API 키를 입력해 주세요.');
  const form = new FormData();
  form.append('file', new Blob([toWav(audio)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('language', 'ko');
  if (prompt) form.append('prompt', prompt);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`클라우드 음성 인식 오류 (${res.status}): ${data.error?.message || 'unknown'}`);
  return cleanup(String(data.text || ''));
}

module.exports = { init, transcribe, transcribeCloud, toWav, getPipe, cleanup, stripWakeWord, fuzzyJarvisEnd };
