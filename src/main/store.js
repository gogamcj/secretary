// 간단한 JSON 저장소. 설정, 기억, 알림, 토큰을 앱 데이터 폴더에 저장합니다.
// 비밀 값(API 키, 토큰)은 OS 보안 저장소(safeStorage)로 암호화합니다.
const fs = require('fs');
const path = require('path');

let baseDir = null;
let safe = null; // electron.safeStorage (테스트에서는 null)

function init(dir, safeStorage) {
  baseDir = dir;
  safe = safeStorage || null;
  fs.mkdirSync(baseDir, { recursive: true });
}

function file(name) {
  if (!baseDir) throw new Error('store.init()가 먼저 호출되어야 합니다.');
  return path.join(baseDir, `${name}.json`);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function write(name, data) {
  const target = file(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// ---- 비밀 값 ----
function canEncrypt() {
  try {
    return !!(safe && safe.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function getSecret(key) {
  const all = read('secrets', {});
  const v = all[key];
  if (!v) return '';
  if (v.enc && canEncrypt()) {
    try {
      return safe.decryptString(Buffer.from(v.enc, 'base64'));
    } catch {
      return '';
    }
  }
  return v.plain || '';
}

function setSecret(key, value) {
  const all = read('secrets', {});
  if (!value) {
    delete all[key];
  } else if (canEncrypt()) {
    all[key] = { enc: safe.encryptString(value).toString('base64') };
  } else {
    all[key] = { plain: value };
  }
  write('secrets', all);
}

function getSecretJSON(key) {
  const s = getSecret(key);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function setSecretJSON(key, obj) {
  setSecret(key, obj ? JSON.stringify(obj) : '');
}

// ---- 설정 ----
const DEFAULT_SETTINGS = {
  userName: '',
  assistantName: '자비스',
  model: 'claude-opus-5-5',
  effort: 'low',
  wakeWordEnabled: true,
  wakeWords: ['자비스', '쟈비스', '재비스', '자비쓰', '저비스', '짜비스', 'jarvis', 'javis'],
  sttModel: 'Xenova/whisper-small',
  sttProvider: 'local', // local | openai
  sttCloudModel: 'gpt-4o-mini-transcribe',
  fastMode: false,
  ttsEnabled: true,
  ttsProvider: 'system', // system | openai | elevenlabs
  ttsVoice: 'onyx',
  ttsCloudModel: 'gpt-4o-mini-tts',
  ttsInstructions: '',
  elevenVoiceId: '',
  elevenModel: 'eleven_multilingual_v2',
  ttsRate: 1.05,
  documentsDir: '',
  confirmRiskyActions: true,
  googleClientId: '',
  kakaoRestKey: '',
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings', next);
  return next;
}

module.exports = {
  init,
  read,
  write,
  getSecret,
  setSecret,
  getSecretJSON,
  setSecretJSON,
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
};
