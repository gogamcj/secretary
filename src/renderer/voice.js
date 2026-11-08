// 마이크 입력, 말소리 구간 감지(VAD), 음성 출력(TTS)
(function () {
  const SAMPLE_RATE = 16000;
  const FRAME = 1024; // 64ms
  const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
  const PRE_ROLL_FRAMES = 5; // 말 시작 전 320ms 포함
  const END_SILENCE_MS = 650;
  const MIN_SPEECH_MS = 350;
  const MAX_SEGMENT_MS = 15000;

  let ctx = null;
  let stream = null;
  let analyser = null;
  let processor = null;
  let paused = false;
  let onSegment = () => {};
  let onSpeechStart = () => {};

  let noiseFloor = 0.004;
  let speaking = false;
  let speechFrames = 0;
  let silenceMs = 0;
  let segment = [];
  const preRoll = [];

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function handleFrame(frame) {
    const level = rms(frame);
    const threshold = Math.max(0.012, noiseFloor * 3.2);
    const isSpeech = level > threshold;
    if (!speaking && !isSpeech) noiseFloor = noiseFloor * 0.97 + level * 0.03;

    if (paused) {
      speaking = false;
      segment = [];
      preRoll.length = 0;
      return;
    }

    if (!speaking) {
      preRoll.push(frame);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      speechFrames = isSpeech ? speechFrames + 1 : 0;
      if (speechFrames >= 2) {
        speaking = true;
        silenceMs = 0;
        segment = [...preRoll];
        preRoll.length = 0;
        onSpeechStart();
      }
      return;
    }

    segment.push(frame);
    silenceMs = isSpeech ? 0 : silenceMs + FRAME_MS;
    const lengthMs = segment.length * FRAME_MS;
    if (silenceMs >= END_SILENCE_MS || lengthMs >= MAX_SEGMENT_MS) {
      speaking = false;
      speechFrames = 0;
      const audio = concat(segment);
      segment = [];
      if (lengthMs - silenceMs >= MIN_SPEECH_MS) onSegment(audio);
    }
  }

  async function start() {
    if (ctx) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    // ScriptProcessor는 오래된 API지만 별도 파일 없이 모든 Electron 버전에서 동작합니다.
    processor = ctx.createScriptProcessor(FRAME, 1, 1);
    processor.onaudioprocess = (e) => handleFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(processor);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute).connect(ctx.destination);

    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      if (!paused && window.Voice.visualize) {
        window.HUD.setWave(buf);
        window.HUD.setLevel(Math.min(1, rms(buf) * 8));
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- TTS ----------
  let voice = null;
  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    const ko = voices.filter((v) => /^ko/i.test(v.lang));
    // 자연스러운 음성 우선 (Windows의 Online/Natural, Mac의 Yuna 등)
    voice = ko.find((v) => /natural|online|neural/i.test(v.name)) || ko.find((v) => /yuna|heami|sunhi|injoon/i.test(v.name)) || ko[0] || null;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  function cleanForSpeech(text) {
    return String(text)
      .replace(/https?:\/\/\S+/g, '링크')
      .replace(/[*#_`>|~]/g, '')
      .replace(/\(id:[^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 문장 단위 음성 대기열: 답변이 스트리밍으로 오는 동안 완성된 문장부터 바로 읽습니다.
  const queue = [];
  let speakingNow = false;
  let idleWaiters = [];
  let rate = 1.05;

  function pump() {
    if (speakingNow) return;
    const next = queue.shift();
    if (next === undefined) {
      idleWaiters.forEach((r) => r());
      idleWaiters = [];
      return;
    }
    speakingNow = true;
    const u = new SpeechSynthesisUtterance(next);
    u.lang = 'ko-KR';
    if (voice) u.voice = voice;
    u.rate = rate;
    const done = () => {
      speakingNow = false;
      pump();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  function enqueue(text, r) {
    if (!('speechSynthesis' in window)) return;
    if (r) rate = r;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    for (const part of clean.match(/[^.!?。\n]+[.!?。]?/g) || [clean]) if (part.trim()) queue.push(part.trim());
    pump();
  }

  function whenIdle() {
    if (!speakingNow && queue.length === 0) return Promise.resolve();
    return new Promise((r) => idleWaiters.push(r));
  }

  function speak(text, r) {
    enqueue(text, r);
    return whenIdle();
  }

  function stopSpeaking() {
    queue.length = 0;
    speakingNow = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    idleWaiters.forEach((r) => r());
    idleWaiters = [];
  }

  function chime(up = true) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(up ? 660 : 880, t0);
    o.frequency.exponentialRampToValueAtTime(up ? 1320 : 440, t0 + 0.12);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.2);
  }

  window.Voice = {
    start,
    speak,
    enqueue,
    whenIdle,
    stopSpeaking,
    chime,
    visualize: true,
    get active() {
      return !!ctx;
    },
    get hasKoreanVoice() {
      return !!voice;
    },
    setPaused(p) {
      paused = p;
    },
    onSegment(cb) {
      onSegment = cb;
    },
    onSpeechStart(cb) {
      onSpeechStart = cb;
    },
  };
})();
