// 사람 같은 AI 음성 (클라우드 TTS)
// - OpenAI: 한 키로 음성 인식과 같이 쓸 수 있고, 말투를 글로 지시할 수 있습니다.
// - ElevenLabs: 가장 사람 같은 음성. 별도 가입과 키가 필요합니다.
const store = require('./store');

const DEFAULT_INSTRUCTIONS =
  '영화 속 인공지능 비서 자비스처럼, 차분하고 품위 있는 30대 남성 목소리로 말하세요. 또렷하고 자연스러운 표준 한국어로, 너무 빠르지 않게, 약간의 따뜻함과 여유를 담아 말하세요.';

async function openaiTTS(text, s) {
  const apiKey = store.getSecret('openai_api_key');
  if (!apiKey) throw new Error('설정에서 OpenAI API 키를 입력해 주세요.');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: s.ttsCloudModel || 'gpt-4o-mini-tts',
      voice: s.ttsVoice || 'onyx',
      input: text,
      instructions: s.ttsInstructions || DEFAULT_INSTRUCTIONS,
      response_format: 'mp3',
      speed: Math.min(1.5, Math.max(0.7, Number(s.ttsRate) || 1)),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`OpenAI 음성 오류 (${res.status}): ${data.error?.message || 'unknown'}`);
  }
  return { mime: 'audio/mpeg', data: Buffer.from(await res.arrayBuffer()) };
}

async function elevenlabsTTS(text, s) {
  const apiKey = store.getSecret('elevenlabs_api_key');
  if (!apiKey) throw new Error('설정에서 ElevenLabs API 키를 입력해 주세요.');
  const voiceId = s.elevenVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: s.elevenModel || 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, Number(s.ttsRate) || 1)) },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`ElevenLabs 음성 오류 (${res.status}): ${data.detail?.message || data.detail || 'unknown'}`);
  }
  return { mime: 'audio/mpeg', data: Buffer.from(await res.arrayBuffer()) };
}

async function synthesize(text) {
  const s = store.getSettings();
  if (s.ttsProvider === 'openai') return openaiTTS(text, s);
  if (s.ttsProvider === 'elevenlabs') return elevenlabsTTS(text, s);
  throw new Error('클라우드 음성이 꺼져 있습니다.');
}

module.exports = { synthesize, DEFAULT_INSTRUCTIONS };
