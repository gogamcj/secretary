// 화면 쪽 말소리 구간 감지(VAD)를 가짜 마이크 소리로 확인합니다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function loadVoice() {
  let proc;
  const window = { HUD: { setWave() {}, setLevel() {} } };
  const ctx = {
    window,
    requestAnimationFrame: () => {},
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    AudioContext: class {
      constructor() { this.state = 'running'; }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { connect() {}, getFloatTimeDomainData() {} }; }
      createScriptProcessor() { proc = { connect: () => ({ connect() {} }) }; return proc; }
      createGain() { return { gain: {}, connect: () => ({ connect() {} }) }; }
      get destination() { return {}; }
      resume() {}
    },
  };
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/voice.js'), 'utf8');
  new Function(...Object.keys(ctx), src)(...Object.values(ctx));
  return { Voice: window.Voice, feed: (f) => proc.onaudioprocess({ inputBuffer: { getChannelData: () => f } }) };
}

async function run(noise, speech) {
  const { Voice, feed } = loadVoice();
  await Voice.start();
  Voice.setMaxSegment(7000);
  const segs = [];
  Voice.onSegment((a) => segs.push(a.length / 16000));
  let t = 0;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let n = 0; n < (16000 * 10) / 1024; n++) {
    const f = new Float32Array(1024);
    for (let i = 0; i < 1024; i++, t++) {
      const talking = (t / 16000) % 1.8 < 0.4;
      f[i] = (talking ? speech * Math.sin(t * 0.3) : 0) + rand() * noise;
    }
    feed(f);
  }
  return segs;
}

test('조용한 방: 말이 끝나면 바로 구간이 끝남', async () => {
  const segs = await run(0.002, 0.3);
  assert.ok(segs.length >= 4, `구간 수 ${segs.length}`);
  assert.ok(segs.every((s) => s < 2), `구간 길이 ${segs}`);
});

test('팬 소음이 있는 방: 말이 끝나는 걸 놓치지 않음', async () => {
  const segs = await run(0.07, 0.15);
  assert.ok(segs.length >= 3, `구간 수 ${segs.length}`);
  assert.ok(segs.slice(1).every((s) => s < 2), `구간 길이 ${segs}`);
});
