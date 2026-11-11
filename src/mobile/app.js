// 아이폰용 자비스 화면. PC 자비스의 모바일 연결 서버와 통신합니다.
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'jarvis_token';
  const VOICE_KEY = 'jarvis_voice';

  const storage = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {}
    },
  };

  // QR 코드 링크(#k=...)로 들어오면 연결 코드를 저장하고 주소창에서 지웁니다.
  const m = /[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    storage.set(TOKEN_KEY, m[1]);
    history.replaceState(null, '', location.pathname);
  }

  let token = storage.get(TOKEN_KEY);
  let voiceOn = storage.get(VOICE_KEY) !== 'off';
  let busy = false;
  let pollTimer = null;
  let shownConfirm = null;

  const log = $('log');
  const input = $('input');

  function add(kind, text) {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setDot(state) {
    $('dot').className = `dot ${state}`;
  }

  async function api(path, { method = 'GET', json, body, raw } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const res = await fetch(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
    if (raw) return res;
    const data = await res.json().catch(() => ({ ok: false, error: `오류 (${res.status})` }));
    if (res.status === 401) showPair(data.error);
    return data;
  }

  function showPair(msg) {
    $('pair').hidden = false;
    log.hidden = true;
    $('ask-form').hidden = true;
    if (msg) $('hint').textContent = msg;
    setDot('off');
  }

  function hidePair() {
    $('pair').hidden = true;
    log.hidden = false;
    $('ask-form').hidden = false;
  }

  async function refresh() {
    if (!token) return showPair();
    try {
      const s = await api('/api/status');
      if (!s.ok) return;
      hidePair();
      if (s.assistantName) $('name').textContent = s.assistantName;
      setDot(busy || s.busy ? 'busy' : 'on');
      $('hint').textContent = hintText(s);
      handleConfirm(s.confirm);
      return s;
    } catch {
      setDot('off');
      $('hint').textContent = 'PC 자비스에 연결할 수 없습니다. PC가 켜져 있고 자비스가 실행 중인지 확인하세요.';
    }
  }

  function hintText(s) {
    if (busy && s.status?.tool) return `작업 중: ${s.status.tool}`;
    if (busy) return '생각하는 중…';
    if (!micSupported()) return '키보드의 🎤 버튼을 누르면 말로 입력할 수 있습니다.';
    return '🎙 버튼을 눌러 말하고, 다시 눌러 끝내세요.';
  }

  function handleConfirm(c) {
    const dlg = $('confirm');
    if (!c) {
      if (dlg.open) dlg.close('none');
      shownConfirm = null;
      return;
    }
    if (shownConfirm === c.id) return;
    shownConfirm = c.id;
    $('confirm-text').textContent = c.message;
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue === 'none') return;
      await api('/api/confirm', { method: 'POST', json: { id: c.id, ok: dlg.returnValue === 'yes' } }).catch(() => {});
    };
  }

  // ---------- 음성 출력 ----------
  const audio = new Audio();
  audio.playsInline = true;
  let unlocked = false;
  function unlockAudio() {
    // iOS는 사용자가 누른 순간에만 소리를 켤 수 있어, 보낼 때 미리 풀어 둡니다.
    if (unlocked || !voiceOn) return;
    unlocked = true;
    audio.src = URL.createObjectURL(silentWav());
    audio.play().catch(() => {});
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }

  function silentWav() {
    const b = new DataView(new ArrayBuffer(46));
    const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    b.setUint32(4, 38, true);
    str(8, 'WAVEfmt ');
    b.setUint32(16, 16, true);
    b.setUint16(20, 1, true);
    b.setUint16(22, 1, true);
    b.setUint32(24, 8000, true);
    b.setUint32(28, 16000, true);
    b.setUint16(32, 2, true);
    b.setUint16(34, 16, true);
    str(36, 'data');
    b.setUint32(40, 2, true);
    return new Blob([b.buffer], { type: 'audio/wav' });
  }

  async function speak(text) {
    if (!voiceOn || !text) return;
    try {
      const res = await api('/api/tts', { method: 'POST', json: { text }, raw: true });
      if (res.status === 200) {
        const blob = await res.blob();
        audio.src = URL.createObjectURL(blob);
        await audio.play();
        return;
      }
    } catch {}
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
  }

  function renderVoice() {
    $('btn-voice').classList.toggle('muted', !voiceOn);
    $('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
  }

  // ---------- 묻기 ----------
  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    add('me', text);
    busy = true;
    $('btn-send').disabled = true;
    const thinking = add('bot thinking', '');
    pollTimer = setInterval(refresh, 1000);
    refresh();
    try {
      const r = await api('/api/ask', { method: 'POST', json: { text } });
      thinking.remove();
      if (r.ok) {
        add('bot', r.reply || '(답이 비어 있습니다)');
        speak(r.reply);
      } else {
        add('err', r.error || '오류가 났습니다.');
      }
    } catch {
      thinking.remove();
      add('err', 'PC 자비스에 연결할 수 없습니다.');
    } finally {
      busy = false;
      clearInterval(pollTimer);
      $('btn-send').disabled = false;
      refresh();
    }
  }

  // ---------- 마이크 (HTTPS 주소에서만 사용 가능) ----------
  function micSupported() {
    return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && 'MediaRecorder' in window;
  }

  let rec = null;
  let recStop = null;
  async function toggleMic() {
    if (rec) return recStop();
    unlockAudio();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      return add('err', '마이크를 쓸 수 없습니다. 아이폰 설정에서 마이크 권한을 허용하세요.');
    }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const auto = setTimeout(() => recStop(), 30000);
    recStop = () => {
      clearTimeout(auto);
      if (rec && rec.state !== 'inactive') rec.stop();
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      rec = null;
      $('btn-mic').classList.remove('rec');
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/mp4' });
      $('hint').textContent = '받아 적는 중…';
      try {
        const pcm = await toPcm16k(blob);
        const r = await api('/api/transcribe', { method: 'POST', body: pcm.buffer });
        if (r.ok && r.text?.trim()) ask(r.text);
        else add('sys', r.error || '말씀을 알아듣지 못했습니다.');
      } catch (e) {
        add('err', `음성 처리 오류: ${e.message}`);
      }
      refresh();
    };
    rec.start();
    $('btn-mic').classList.add('rec');
    $('hint').textContent = '듣고 있습니다… 다 말했으면 🎙 버튼을 다시 누르세요.';
  }

  // 녹음 파일을 Whisper가 쓰는 16kHz 모노 PCM으로 바꿉니다.
  async function toPcm16k(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    const length = Math.max(1, Math.ceil(decoded.duration * 16000));
    const off = new OfflineAudioContext(1, length, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0);
  }

  // ---------- 이벤트 ----------
  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlockAudio();
    const text = input.value;
    input.value = '';
    input.style.height = '';
    ask(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('ask-form').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  });
  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-voice').addEventListener('click', () => {
    voiceOn = !voiceOn;
    storage.set(VOICE_KEY, voiceOn ? 'on' : 'off');
    if (!voiceOn) {
      audio.pause();
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    }
    renderVoice();
  });
  $('btn-reset').addEventListener('click', async () => {
    if (busy) return;
    await api('/api/reset', { method: 'POST', json: {} }).catch(() => {});
    log.textContent = '';
    add('sys', '새 대화를 시작했습니다.');
  });
  $('pair-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('pair-code').value.trim();
    const mm = /k=([A-Za-z0-9_-]+)/.exec(code);
    token = mm ? mm[1] : code;
    storage.set(TOKEN_KEY, token);
    refresh();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());

  $('btn-mic').hidden = !micSupported();
  renderVoice();
  refresh().then((s) => {
    if (s?.ok) add('sys', `${s.assistantName || '자비스'}에 연결되었습니다. 무엇을 도와드릴까요?`);
  });
})();
