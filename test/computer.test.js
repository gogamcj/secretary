const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/main/store');
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cu-')), null);
const stt = require('../src/main/stt');
const { Computer, parseCombo } = require('../src/main/computer');
const { Agent } = require('../src/main/agent');

// 가짜 화면(2560x1440 논리 픽셀, 배율 1)과 가짜 입력 장치
function fakeElectron() {
  let clip = '원래 클립보드';
  const img = (w, h) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    toJPEG: () => Buffer.from(`jpeg${w}x${h}`),
    crop: (r) => img(r.width, r.height),
    resize: (s) => img(s.width, s.height),
  });
  return {
    clipboard: { readText: () => clip, writeText: (t) => (clip = t) },
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 2560, height: 1440 }, bounds: { x: 0, y: 0 }, scaleFactor: 1 }) },
    desktopCapturer: { getSources: async ({ thumbnailSize }) => [{ display_id: '1', thumbnail: img(thumbnailSize.width, thumbnailSize.height) }] },
  };
}
function fakeDriver() {
  const log = [];
  return {
    log,
    move: async (x, y) => log.push(`move ${Math.round(x)},${Math.round(y)}`),
    button: async (b, d) => log.push(`${b} ${d ? 'down' : 'up'}`),
    click: async (b, n) => log.push(`click ${b} x${n}`),
    drag: async (...a) => log.push(`drag ${a.map(Math.round).join(',')}`),
    scroll: async (d, n) => log.push(`scroll ${d} ${n}`),
    key: async (k, d) => log.push(`key ${k} ${d ? 'down' : 'up'}`),
    position: async () => ({ x: 1280, y: 720 }),
    pasteMods: () => ['ctrl'],
  };
}

test('키 조합 해석', () => {
  assert.deepEqual(parseCombo('ctrl+shift+T'), { mods: ['ctrl', 'shift'], key: 't' });
  assert.deepEqual(parseCombo('Return'), { mods: [], key: 'Return' });
  assert.deepEqual(parseCombo('cmd+space'), { mods: ['super'], key: 'space' });
});

test('스크린샷 좌표를 실제 화면 좌표로 바꿔 클릭', async () => {
  const d = fakeDriver();
  const c = new Computer(fakeElectron(), d);
  const shot = await c.perform('screenshot');
  assert.equal(Buffer.from(shot.image, 'base64').toString(), 'jpeg1280x720'); // 긴 변 1280으로 줄임
  await c.perform('left_click', { coordinate: [640, 360], text: 'shift' });
  assert.deepEqual(d.log, ['move 1280,720', 'key shift down', 'click left x1', 'key shift up']);
  assert.equal((await c.perform('cursor_position')).text, '[640, 360]');
});

test('글자 입력은 클립보드 붙여넣기 후 원래 클립보드 복원', async () => {
  const d = fakeDriver();
  const e = fakeElectron();
  const c = new Computer(e, d);
  await c.perform('type', { text: '안녕하세요' });
  assert.deepEqual(d.log, ['key ctrl down', 'key v down', 'key v up', 'key ctrl up']);
  assert.equal(e.clipboard.readText(), '원래 클립보드');
});

test('비슷하게 들린 호출어도 인식', () => {
  const w = ['자비스'];
  assert.equal(stt.stripWakeWord('차비스 날씨 알려줘', w), '날씨 알려줘');
  assert.equal(stt.stripWakeWord('자빗으 유튜브 틀어줘', w), '유튜브 틀어줘');
  assert.equal(stt.stripWakeWord('잡이스, 메일 확인', w), '메일 확인');
  assert.equal(stt.stripWakeWord('자비심을 가지세요', w), null);
  assert.equal(stt.stripWakeWord('오늘 차 비싸다', w), null);
});

function fakeClient(responses, seen) {
  return {
    beta: {
      messages: {
        stream: (p) => {
          seen.push(JSON.parse(JSON.stringify(p)));
          const r = responses.shift();
          return { on() { return this; }, finalMessage: async () => r };
        },
      },
    },
  };
}

test('화면 조작: 한 번 허락받고, 묶음 실행, toolset_name을 돌려주고, 끝나면 창 복원', async () => {
  store.saveSettings({ computerUseEnabled: true, confirmRiskyActions: true, model: 'claude-opus-5-5' });
  const d = fakeDriver();
  const events = [];
  let asked = 0;
  const agent = new Agent({
    tools: [],
    confirm: async () => (asked++, true),
    computer: new Computer(fakeElectron(), d),
    hooks: { computerStart: () => events.push('start'), computerEnd: () => events.push('end') },
  });
  const seen = [];
  agent.client = fakeClient(
    [
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'screenshot', toolset_name: 'computer', input: {} },
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't2', name: 'left_click', toolset_name: 'computer', input: { coordinate: [10, 10] } },
          { type: 'tool_use', id: 't3', name: 'zoom', toolset_name: 'computer', input: { region: [1] } },
          { type: 'tool_use', id: 't4', name: 'type', toolset_name: 'computer', input: { text: 'x' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '검색창을 열었어요.' }] },
    ],
    seen,
  );
  agent.clientKey = 'k';
  store.setSecret('anthropic_api_key', 'k');
  const reply = await agent.ask('크롬 열어서 검색해줘');
  assert.equal(reply, '검색창을 열었어요.');
  assert.equal(asked, 1);
  assert.deepEqual(events, ['start', 'end']);
  const tools = seen[0].tools;
  assert.ok(tools.some((t) => t.type === 'computer_toolset_20260801' && !t.name));
  assert.ok(tools.some((t) => t.type === 'web_search_20260209'));
  const r1 = seen[1].messages.at(-1).content[0];
  assert.equal(r1.toolset_name, 'computer');
  assert.equal(r1.content[0].type, 'image');
  const r2 = seen[2].messages.at(-1).content;
  assert.deepEqual(r2.map((r) => [r.tool_use_id, !!r.is_error]), [['t2', false], ['t3', true], ['t4', true]]);
  assert.match(r2[2].content, /Not executed/);
  assert.ok(r2.every((r) => r.toolset_name === 'computer'));
  assert.ok(!d.log.some((l) => l.startsWith('key v'))); // 실패 뒤 동작은 실행 안 함
});

test('화면 조작 꺼져 있으면 도구 목록에 없음', () => {
  store.saveSettings({ computerUseEnabled: false });
  const agent = new Agent({ tools: [], confirm: async () => true, computer: new Computer(fakeElectron(), fakeDriver()) });
  assert.ok(!agent.toolDefs().some((t) => t.type === 'computer_toolset_20260801'));
});
