const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
const store = require('../src/main/store');
store.init(tmp, null);
store.saveSettings({ documentsDir: path.join(tmp, 'docs') });

const memory = require('../src/main/tools/memory');
const reminders = require('../src/main/tools/reminders');
const stt = require('../src/main/stt');
const google = require('../src/main/tools/google');
const kakao = require('../src/main/tools/kakao');
const documents = require('../src/main/tools/documents');
const { Agent } = require('../src/main/agent');

test('기억 저장/검색/삭제', () => {
  const m = memory.addMemory('아내 생일은 3월 14일', '가족');
  memory.addMemory('커피는 아메리카노를 좋아함', '선호');
  assert.equal(memory.searchMemories('생일')[0].id, m.id);
  assert.match(memory.memoryDigest(), /아메리카노/);
  assert.ok(memory.deleteMemory(m.id));
  assert.equal(memory.searchMemories('생일').length, 0);
});

test('리마인더 만기 처리', () => {
  const past = reminders.addReminder('약 먹기', new Date(Date.now() - 1000).toISOString());
  reminders.addReminder('회의', new Date(Date.now() + 3600e3).toISOString());
  const due = reminders.popDue();
  assert.deepEqual(due.map((r) => r.id), [past.id]);
  assert.equal(reminders.listReminders().length, 1);
  assert.throws(() => reminders.addReminder('x', '내일쯤'));
});

test('호출어 인식', () => {
  const w = ['자비스', 'jarvis'];
  assert.equal(stt.stripWakeWord('자비스 오늘 일정 알려줘', w), '오늘 일정 알려줘');
  assert.equal(stt.stripWakeWord('자비스야, 메일 확인해', w), '메일 확인해');
  assert.equal(stt.stripWakeWord('자비스 아침 알람 맞춰줘', w), '아침 알람 맞춰줘');
  assert.equal(stt.stripWakeWord('자비스야', w), '');
  assert.equal(stt.stripWakeWord('Jarvis, open chrome', w), 'open chrome');
  assert.equal(stt.stripWakeWord('오늘 날씨 좋다', w), null);
  assert.equal(stt.cleanup('시청해 주셔서 감사합니다.'), '');
});

test('메일 원문 만들기 (한글 제목)', () => {
  const raw = google.buildRawEmail({ to: 'a@b.com', subject: '견적서 보내드립니다', body: '안녕하세요' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  const bodyB64 = decoded.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(bodyB64, 'base64').toString('utf8'), '안녕하세요');
});

test('톡캘린더 시간은 UTC 5분 단위', () => {
  assert.equal(kakao.toKakaoTime('2026-11-08T15:03:00+09:00'), '2026-11-08T06:00:00Z');
  assert.equal(kakao.toKakaoTime('2026-11-08T15:03:00+09:00', true), '2026-11-08T06:05:00Z');
});

test('워드 문서 만들기', async () => {
  const [create] = documents.makeTools(null);
  const out = await create.run({ title: '회의록', content: '# 안건\n- 예산\n1. 일정\n**결론** 진행', open_after: false });
  const file = out.split(': ').pop();
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file).subarray(0, 2).toString(), 'PK');
});

test('에이전트 도구 루프 + 확인 창 취소', async () => {
  store.setSecret('anthropic_api_key', 'test-key');
  const calls = [];
  const ran = [];
  const tools = [
    { name: 'safe_tool', description: 'd', input_schema: { type: 'object', properties: {} }, run: async () => (ran.push('safe'), '안전 결과') },
    { name: 'risky_tool', description: 'd', input_schema: { type: 'object', properties: {} }, risky: () => '정말?', run: async () => (ran.push('risky'), 'x') },
  ];
  const agent = new Agent({ tools, confirm: async () => false });
  const responses = [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: '확인할게요' }, { type: 'tool_use', id: 't1', name: 'safe_tool', input: {} }, { type: 'tool_use', id: 't2', name: 'risky_tool', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '완료했습니다.' }] },
  ];
  agent.getClient = () => ({ beta: { messages: { create: async (p) => (calls.push(structuredClone(p)), responses.shift()) } } });
  const reply = await agent.ask('해줘');
  assert.equal(reply, '완료했습니다.');
  assert.deepEqual(ran, ['safe']);
  const second = calls[1];
  assert.equal(second.model, 'claude-opus-5-5');
  assert.equal(second.fallbacks, 'default');
  const results = second.messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.match(results[1].content, /취소/);
  assert.equal(agent.messages.length, 4);
});

test('에이전트 오류 시 대화 기록 되돌림', async () => {
  const agent = new Agent({ tools: [], confirm: async () => true });
  agent.getClient = () => ({ beta: { messages: { create: async () => { throw new Error('네트워크 끊김'); } } } });
  await assert.rejects(agent.ask('안녕'), /네트워크 끊김/);
  assert.equal(agent.messages.length, 0);
});

test('시스템 프롬프트는 대화 중 바뀌지 않고, 바뀌는 정보는 사용자 메시지에 들어감', async () => {
  const calls = [];
  const agent = new Agent({ tools: [], confirm: async () => true });
  agent.getClient = () => ({ beta: { messages: { create: async (p) => (calls.push(structuredClone(p)), { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '네' }] }) } } });
  await agent.ask('첫 번째', { google: false });
  memory.addMemory('대화 중 새로 생긴 기억');
  store.saveSettings({ userName: '바뀐이름' });
  await agent.ask('두 번째', { google: true });
  assert.deepEqual(calls[0].system, calls[1].system);
  assert.match(calls[1].messages.at(-1).content[0].text, /대화 중 새로 생긴 기억/);
  assert.equal(calls[1].messages.at(-1).content[1].text, '두 번째');
});

test('생각 블록 서명 오류가 나면 새 대화로 한 번 재시도', async () => {
  const AnthropicSDK = require('@anthropic-ai/sdk');
  const agent = new Agent({ tools: [], confirm: async () => true });
  agent.messages = [{ role: 'user', content: '예전' }, { role: 'assistant', content: [{ type: 'text', text: '예전 답' }] }];
  let n = 0;
  agent.getClient = () => ({ beta: { messages: { create: async (p) => {
    n++;
    if (n === 1) throw new AnthropicSDK.BadRequestError(400, { error: { message: 'Invalid `signature` in `thinking` block' } }, 'Invalid `signature` in `thinking` block', new Headers());
    assert.equal(p.messages.length, 1);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '복구됨' }] };
  } } } });
  assert.equal(await agent.ask('안녕'), '복구됨');
  assert.equal(n, 2);
});
