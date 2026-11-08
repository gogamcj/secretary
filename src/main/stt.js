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
    if (idx !== -1 && idx < 12) {
      return text
        .slice(idx + w.length)
        .replace(/^(야|아)(?=$|[\s,.!?~])/, '')
        .replace(/^[\s,.!?~]+/, '')
        .trim();
    }
  }
  return null;
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

async function transcribeCloud(audio, { apiKey, model = 'gpt-4o-mini-transcribe', prompt = '' }) {
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

module.exports = { init, transcribe, transcribeCloud, toWav, getPipe, cleanup, stripWakeWord };
