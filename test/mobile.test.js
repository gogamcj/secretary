const test = require('node:test');
const assert = require('node:assert');
const { createMobileServer, newToken, safeEqual } = require('../src/main/mobile');

async function start(overrides = {}) {
  const token = newToken();
  const calls = { ask: [], reset: 0 };
  let srv;
  const handlers = {
    getToken: () => token,
    ask: async (text) => {
      calls.ask.push(text);
      if (text === '위험') {
        const ok = await srv.requestConfirm('메일 보내기');
        return ok ? '보냈습니다' : '취소했습니다';
      }
      return `답: ${text}`;
    },
    transcribe: async (audio) => `samples:${audio.length}`,
    tts: async () => {
      throw new Error('off');
    },
    reset: () => calls.reset++,
    info: () => ({ assistantName: '자비스' }),
    ...overrides,
  };
  srv = createMobileServer(handlers);
  const port = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', json, body, auth = token } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : body,
    });
  return { srv, call, calls, token };
}

test('safeEqual: 길이·내용이 같아야 통과', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('', ''));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('모바일 서버: 화면 파일은 누구나, API는 연결 코드가 있어야', async () => {
  const { srv, call } = await start();
  try {
    const page = await call('/', { auth: null });
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /자비스/);
    assert.strictEqual((await call('/api/status', { auth: null })).status, 401);
    assert.strictEqual((await call('/api/status', { auth: 'wrong' })).status, 401);
    const s = await (await call('/api/status')).json();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.assistantName, '자비스');
  } finally {
    await srv.close();
  }
});

test('모바일 서버: 틀린 코드를 여러 번 넣으면 잠깁니다', async () => {
  const { srv, call } = await start();
  try {
    for (let i = 0; i < 10; i++) await call('/api/status', { auth: 'nope' });
    assert.strictEqual((await call('/api/status')).status, 429);
  } finally {
    await srv.close();
  }
});

test('모바일 서버: 묻기, 받아쓰기, 음성 꺼짐, 새 대화', async () => {
  const { srv, call, calls } = await start();
  try {
    const r = await (await call('/api/ask', { method: 'POST', json: { text: ' 안녕 ' } })).json();
    assert.deepStrictEqual(r, { ok: true, reply: '답: 안녕' });
    assert.strictEqual((await call('/api/ask', { method: 'POST', json: { text: '' } })).status, 400);

    const pcm = new Float32Array(1600);
    const t = await (await call('/api/transcribe', { method: 'POST', body: Buffer.from(pcm.buffer) })).json();
    assert.strictEqual(t.text, 'samples:1600');
    assert.strictEqual((await call('/api/transcribe', { method: 'POST', body: Buffer.from([1, 2, 3]) })).status, 400);

    assert.strictEqual((await call('/api/tts', { method: 'POST', json: { text: 'x' } })).status, 204);
    await call('/api/reset', { method: 'POST', json: {} });
    assert.strictEqual(calls.reset, 1);
  } finally {
    await srv.close();
  }
});

test('모바일 서버: 위험한 작업은 아이폰에서 확인하고, 처리 중엔 다른 명령을 막습니다', async () => {
  const { srv, call } = await start();
  try {
    const pending = call('/api/ask', { method: 'POST', json: { text: '위험' } }).then((r) => r.json());
    let s;
    for (let i = 0; i < 50; i++) {
      s = await (await call('/api/status')).json();
      if (s.confirm) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(s.busy, true);
    assert.strictEqual(s.confirm.message, '메일 보내기');
    assert.strictEqual((await call('/api/ask', { method: 'POST', json: { text: '또' } })).status, 409);
    assert.strictEqual((await call('/api/confirm', { method: 'POST', json: { id: 'bad', ok: true } })).status, 404);
    await call('/api/confirm', { method: 'POST', json: { id: s.confirm.id, ok: true } });
    assert.deepStrictEqual(await pending, { ok: true, reply: '보냈습니다' });
    const after = await (await call('/api/status')).json();
    assert.strictEqual(after.busy, false);
    assert.strictEqual(after.confirm, null);
  } finally {
    await srv.close();
  }
});
