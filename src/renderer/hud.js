// 자비스 홀로그램 코어 애니메이션 (canvas 2D)
(function () {
  const canvas = document.getElementById('core');
  const ctx = canvas.getContext('2d');
  const COLORS = {
    idle: [56, 217, 255],
    listening: [127, 231, 255],
    speaking: [56, 217, 255],
    thinking: [255, 181, 71],
    error: [255, 77, 94],
  };
  const SPEED = { idle: 1, listening: 1.6, speaking: 1.3, thinking: 3.2, error: 0.6 };

  let state = 'idle';
  let color = [...COLORS.idle];
  let speed = 1;
  let level = 0; // 0..1 마이크 또는 음성 크기
  let smoothLevel = 0;
  let wave = new Float32Array(128);
  let t = 0;
  let last = performance.now();
  let dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  window.addEventListener('resize', resize);
  resize();

  const rgba = (a) => `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${a})`;

  function arc(cx, cy, r, a0, a1, width, alpha) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(alpha);
    ctx.stroke();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const target = COLORS[state] || COLORS.idle;
    for (let i = 0; i < 3; i++) color[i] += (target[i] - color[i]) * Math.min(1, dt * 4);
    speed += ((SPEED[state] || 1) - speed) * Math.min(1, dt * 3);
    smoothLevel += (level - smoothLevel) * Math.min(1, dt * 12);
    t += dt * speed;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.42;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(0.8);
    ctx.shadowBlur = 12 * dpr;

    // 1. 바깥 눈금 링
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.05);
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const long = i % 10 === 0;
      const r0 = R * (long ? 0.93 : 0.955);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * R * 0.985, Math.sin(a) * R * 0.985);
      ctx.lineWidth = (long ? 2 : 1) * dpr;
      ctx.strokeStyle = rgba(long ? 0.75 : 0.3);
      ctx.stroke();
    }
    ctx.restore();

    // 2. 얇은 외곽 원과 점선
    arc(cx, cy, R * 1.0, 0, Math.PI * 2, 1 * dpr, 0.25);
    ctx.setLineDash([2 * dpr, 10 * dpr]);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.12);
    arc(0, 0, R * 0.88, 0, Math.PI * 2, 2 * dpr, 0.5);
    ctx.restore();
    ctx.setLineDash([]);

    // 3. 회전하는 큰 호 (세그먼트)
    const segs = [
      { r: 0.8, w: 6, n: 3, len: 0.55, sp: 0.35, a: 0.85 },
      { r: 0.72, w: 2, n: 5, len: 0.28, sp: -0.6, a: 0.6 },
      { r: 0.64, w: 10, n: 2, len: 0.9, sp: 0.22, a: 0.35 },
    ];
    for (const s of segs) {
      for (let i = 0; i < s.n; i++) {
        const base = t * s.sp + (i / s.n) * Math.PI * 2;
        arc(cx, cy, R * s.r, base, base + s.len, s.w * dpr, s.a);
      }
    }

    // 4. 음성 파형 링
    const waveR = R * 0.5;
    const amp = R * (0.04 + smoothLevel * 0.22);
    ctx.beginPath();
    const N = wave.length;
    for (let i = 0; i <= N; i++) {
      const k = i % N;
      const a = (k / N) * Math.PI * 2 - Math.PI / 2;
      const v = state === 'thinking' ? Math.sin(t * 6 + k * 0.5) * 0.3 : wave[k];
      const r = waveR + v * amp + Math.sin(t * 2 + k * 0.3) * R * 0.006;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = rgba(0.9);
    ctx.stroke();

    // 5. 안쪽 링 (아크 리액터)
    arc(cx, cy, R * 0.4, 0, Math.PI * 2, 1.5 * dpr, 0.55);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.8);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      arc(0, 0, R * 0.33, a + 0.08, a + Math.PI / 5 - 0.08, 7 * dpr, 0.55 + 0.35 * smoothLevel);
    }
    ctx.restore();

    // 6. 코어 빛
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    const coreR = R * (0.2 + smoothLevel * 0.06 + pulse * 0.01);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.9);
    g.addColorStop(0, 'rgba(235,252,255,0.95)');
    g.addColorStop(0.25, rgba(0.85));
    g.addColorStop(0.6, rgba(0.25));
    g.addColorStop(1, rgba(0));
    ctx.shadowBlur = 0;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.9, 0, Math.PI * 2);
    ctx.fill();

    // 7. 삼각형 코어 장식
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.4);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * R * 0.15;
      const y = Math.sin(a) * R * 0.15;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(240,253,255,0.7)';
    ctx.stroke();
    ctx.restore();

    // 8. 십자 조준선
    ctx.strokeStyle = rgba(0.25);
    ctx.lineWidth = 1 * dpr;
    for (const [x0, y0, x1, y1] of [
      [cx - R * 1.08, cy, cx - R * 0.98, cy],
      [cx + R * 0.98, cy, cx + R * 1.08, cy],
      [cx, cy - R * 1.08, cx, cy - R * 0.98],
      [cx, cy + R * 0.98, cx, cy + R * 1.08],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // 파형이 천천히 가라앉도록
    if (state !== 'listening') for (let i = 0; i < N; i++) wave[i] *= 0.92;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.HUD = {
    setState(s) {
      state = COLORS[s] ? s : 'idle';
    },
    setLevel(v) {
      level = Math.max(0, Math.min(1, v));
    },
    setWave(samples) {
      // samples: -1..1 배열을 128개 막대로 줄입니다
      const N = wave.length;
      const step = Math.max(1, Math.floor(samples.length / N));
      for (let i = 0; i < N; i++) {
        let m = 0;
        for (let j = 0; j < step; j++) m = Math.max(m, Math.abs(samples[i * step + j] || 0));
        wave[i] = Math.min(1, m * 3);
      }
    },
    fakeSpeech(on) {
      // TTS는 실제 파형을 얻을 수 없어 말하는 동안 자연스러운 움직임을 만듭니다
      if (this._fake) cancelAnimationFrame(this._fake);
      if (!on) {
        level = 0;
        return;
      }
      const loop = () => {
        const tt = performance.now() / 1000;
        level = 0.25 + 0.25 * Math.abs(Math.sin(tt * 7)) * (0.6 + 0.4 * Math.sin(tt * 2.3));
        for (let i = 0; i < wave.length; i++) wave[i] = Math.abs(Math.sin(tt * 9 + i * 0.45)) * level * 1.6;
        this._fake = requestAnimationFrame(loop);
      };
      loop();
    },
  };
})();
