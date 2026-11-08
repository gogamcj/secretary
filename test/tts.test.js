const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/main/store');
const tts = require('../src/main/tts');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-')), null);

function mockFetch(handler) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return handler(url, opts);
  };
  return { calls, restore: () => (global.fetch = orig) };
}
const okAudio = () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

test('기본 음성이면 클라우드 요청을 하지 않는다', async () => {
  store.saveSettings({ ttsProvider: 'system' });
  await assert.rejects(tts.synthesize('안녕'), /꺼져/);
});

test('키가 없으면 안내 오류', async () => {
  store.saveSettings({ ttsProvider: 'openai' });
  store.setSecret('openai_api_key', '');
  await assert.rejects(tts.synthesize('안녕'), /OpenAI API 키/);
  store.saveSettings({ ttsProvider: 'elevenlabs' });
  await assert.rejects(tts.synthesize('안녕'), /ElevenLabs API 키/);
});

test('OpenAI 음성: 목소리·말투·속도를 보낸다', async () => {
  store.saveSettings({ ttsProvider: 'openai', ttsVoice: 'ash', ttsRate: 3, ttsInstructions: '' });
  store.setSecret('openai_api_key', 'sk-test');
  const m = mockFetch(okAudio);
  try {
    const r = await tts.synthesize('안녕하세요');
    assert.equal(r.mime, 'audio/mpeg');
    assert.equal(r.data.length, 3);
    const c = m.calls[0];
    assert.match(c.url, /audio\/speech/);
    assert.equal(c.opts.headers.Authorization, 'Bearer sk-test');
    assert.equal(c.body.voice, 'ash');
    assert.equal(c.body.input, '안녕하세요');
    assert.equal(c.body.speed, 1.5);
    assert.equal(c.body.instructions, tts.DEFAULT_INSTRUCTIONS);
  } finally {
    m.restore();
  }
});

test('ElevenLabs 음성: 목소리 ID와 오류 메시지', async () => {
  store.saveSettings({ ttsProvider: 'elevenlabs', elevenVoiceId: 'abc', ttsRate: 1 });
  store.setSecret('elevenlabs_api_key', 'xi-test');
  const m = mockFetch(() => ({ ok: false, status: 401, json: async () => ({ detail: { message: 'invalid key' } }) }));
  try {
    await assert.rejects(tts.synthesize('안녕'), /ElevenLabs 음성 오류 \(401\): invalid key/);
    assert.match(m.calls[0].url, /text-to-speech\/abc\?/);
    assert.equal(m.calls[0].opts.headers['xi-api-key'], 'xi-test');
    assert.equal(m.calls[0].body.model_id, 'eleven_multilingual_v2');
  } finally {
    m.restore();
  }
});
