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

module.exports = { init, transcribe, getPipe, cleanup, stripWakeWord };
