// 화면 동작: 음성 흐름, 대화 기록, 설정 창
(function () {
  const api = window.jarvis;
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');

  const TOOL_LABEL = {
    remember: '기억 저장',
    recall: '기억 찾는 중',
    forget: '기억 삭제',
    add_reminder: '알림 등록',
    list_reminders: '알림 확인',
    delete_reminder: '알림 삭제',
    gmail_search: 'Gmail 검색',
    gmail_read: '메일 읽는 중',
    gmail_send: '메일 보내는 중',
    calendar_list_events: '구글 캘린더 확인',
    calendar_create_event: '구글 캘린더 등록',
    calendar_delete_event: '구글 일정 삭제',
    google_docs_create: '구글 문서 작성',
    kakao_send_to_friend: '카카오톡 보내는 중',
    kakao_read_chat: '카카오톡 읽는 중',
    kakao_send_to_me: '나에게 카톡 보내는 중',
    kakao_calendar_list_events: '톡캘린더 확인',
    kakao_calendar_create_event: '톡캘린더 등록',
    kakao_calendar_delete_event: '톡캘린더 삭제',
    create_document: '문서 작성',
    list_documents: '문서 목록',
    read_text_file: '파일 읽는 중',
    open_app: '앱 실행',
    open_target: '여는 중',
    run_command: '명령 실행',
    clipboard: '클립보드',
    system_info: '시스템 확인',
    web_search: '웹 검색',
    web_fetch: '웹페이지 읽는 중',
  };
  const COMPUTER_LABEL = {
    screenshot: '화면 보는 중',
    zoom: '화면 확대',
    left_click: '클릭',
    right_click: '오른쪽 클릭',
    middle_click: '가운데 클릭',
    double_click: '더블클릭',
    triple_click: '세 번 클릭',
    left_click_drag: '끌어서 놓기',
    mouse_move: '마우스 이동',
    scroll: '스크롤',
    type: '글자 입력',
    key: '키 누르기',
    hold_key: '키 누르고 있기',
    wait: '기다리는 중',
  };
  function toolLabel(name) {
    if (String(name).startsWith('computer:')) return `화면 조작 · ${COMPUTER_LABEL[name.slice(9)] || name.slice(9)}`;
    return TOOL_LABEL[name] || name;
  }

  let settings = {};
  let mode = 'off'; // off | wake | command
  let busy = false;
  let commandTimer = null;
  let sttReady = false;
  let heardTimer = null;

  // ---------- 화면 ----------
  function setState(state, main, sub) {
    document.body.dataset.state = state;
    window.HUD.setState(state);
    if (main) $('status-main').textContent = main;
    if (sub !== undefined) $('status-sub').textContent = sub;
  }

  function idleState() {
    if (mode === 'wake') setState('idle', 'STANDBY', `"${settings.assistantName || '자비스'}"라고 불러 주세요`);
    else if (mode === 'command') setState('listening', 'LISTENING', '듣고 있습니다…');
    else setState('idle', 'STANDBY', '마이크 버튼을 누르거나 입력하세요');
  }

  function addLog(kind, text) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    if (kind === 'user' || kind === 'jarvis') {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = kind === 'user' ? (settings.userName || 'YOU').toUpperCase() : 'J.A.R.V.I.S.';
      div.appendChild(who);
    }
    div.appendChild(document.createTextNode(text));
    logEl.appendChild(div);
    while (logEl.children.length > 200) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setInd(id, on, warn = false) {
    const el = $(id);
    el.classList.toggle('on', !!on);
    el.classList.toggle('warn', !on && warn);
  }

  async function refreshReminders() {
    const list = await api.listReminders();
    const ul = $('reminders');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="empty">예정된 알림이 없습니다</li>';
      return;
    }
    for (const r of list.slice(0, 12)) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = new Date(r.at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      li.append(t, document.createTextNode(r.text));
      ul.appendChild(li);
    }
  }

  function tickClock() {
    const d = new Date();
    $('clock-time').textContent = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    $('clock-date').textContent = d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }

  // ---------- 음성 흐름 ----------
  function baseMode() {
    window.Voice.setMaxSegment?.(7000);
    return settings.wakeWordEnabled && window.Voice.active ? 'wake' : 'off';
  }

  function enterCommand() {
    if (!window.Voice.active) {
      addLog('error', '마이크를 사용할 수 없습니다. 마이크 권한을 확인해 주세요.');
      return;
    }
    window.Voice.stopSpeaking();
    window.Voice.wake();
    mode = 'command';
    window.Voice.setMaxSegment(12000);
    window.Voice.chime(true);
    idleState();
    if (!sttReady) $('status-sub').textContent = '음성 인식 모델을 준비 중이에요. 첫 명령은 조금 느릴 수 있어요…';
    armCommandTimer();
  }

  function armCommandTimer() {
    clearTimeout(commandTimer);
    commandTimer = setTimeout(() => {
      if (mode === 'command' && !busy && !transcribing) {
        mode = baseMode();
        window.Voice.setMaxSegment(7000);
        idleState();
      }
    }, 8000);
  }

  // 들어온 음성 구간 처리: 한 번에 하나씩, 밀린 것은 최신 것만 남깁니다.
  // (예전에는 주변 소리까지 전부 줄을 세워 처리해서, 명령이 그 뒤에서 한참 기다리는 문제가 있었습니다.)
  let pending = null;
  let transcribing = false;

  function onSegmentCaptured(audio) {
    const captured = { audio, mode };
    if (captured.mode === 'off' || busy) return;
    if (captured.mode === 'command') {
      clearTimeout(commandTimer);
      pending = captured; // 명령은 항상 우선
    } else if (!pending || pending.mode !== 'command') {
      pending = captured;
    }
    pumpSegments();
  }

  async function pumpSegments() {
    if (transcribing || !pending) return;
    const job = pending;
    pending = null;
    transcribing = true;
    try {
      await handleSegment(job.audio, job.mode);
    } catch (e) {
      addLog('error', e.message);
    } finally {
      transcribing = false;
      if (mode === 'command' && !busy) armCommandTimer();
    }
    pumpSegments();
  }

  async function handleSegment(audio, capturedMode) {
    if (busy) return;
    const wasCommand = capturedMode === 'command';
    if (wasCommand) setState('thinking', 'PROCESSING', sttReady ? '알아듣는 중…' : '음성 인식 모델 준비 중… (처음 한 번만 오래 걸려요)');
    const res = await api.transcribe(audio, wasCommand ? 'command' : 'wake');
    if (!res.ok) {
      addLog('error', res.error);
      mode = baseMode();
      idleState();
      return;
    }
    const text = res.text;
    if (wasCommand) {
      if (!text) {
        addLog('system', '말씀을 알아듣지 못했어요. 마이크 가까이에서 다시 말씀해 주세요.');
        mode = baseMode();
        idleState();
        return;
      }
      await handleCommand(text, res.ms);
      return;
    }
    if (!text) return;
    const rest = await api.stripWakeWord(text);
    if (rest === null) {
      // 호출어가 없는 말은 무시하되, 무엇이 들렸는지 잠깐 보여줘서 인식 상태를 알 수 있게 합니다.
      if (mode === 'wake' && !busy) {
        $('status-sub').textContent = `들린 말: "${text.slice(0, 40)}" (호출어 없음)`;
        clearTimeout(heardTimer);
        heardTimer = setTimeout(() => mode === 'wake' && !busy && idleState(), 3500);
      }
      return;
    }
    if (rest === '') enterCommand();
    else await handleCommand(rest, res.ms);
  }

  // 스트리밍 답변을 문장 단위로 바로 읽어 주기 위한 상태
  const live = { active: false, buf: '', spoke: false, firstAt: 0, shown: '' };

  function speakSentence(text) {
    if (!settings.ttsEnabled || !text.trim()) return;
    if (!live.spoke) {
      setState('speaking', 'RESPONDING', '');
      window.Voice.visualize = false;
      window.HUD.fakeSpeech(true);
    }
    live.spoke = true;
    window.Voice.enqueue(text, Number(settings.ttsRate) || 1.05);
  }

  function onDelta(delta) {
    if (!live.active) return;
    if (!live.firstAt) live.firstAt = performance.now();
    live.buf += delta;
    live.shown = (live.shown + delta).slice(-140);
    $('status-sub').textContent = live.shown;
    // 완성된 문장부터 읽기
    let m;
    while ((m = live.buf.match(/^([\s\S]*?[.!?。\n])(\s+|$)/)) && m[1].trim().length > 1) {
      speakSentence(m[1]);
      live.buf = live.buf.slice(m[0].length);
    }
  }

  function flushLive() {
    if (live.buf.trim()) speakSentence(live.buf);
    live.buf = '';
  }

  async function handleCommand(text, sttMs) {
    clearTimeout(commandTimer);
    busy = true;
    window.Voice.setPaused(true);
    window.Voice.stopSpeaking();
    addLog('user', text);
    setState('thinking', 'PROCESSING', '생각하는 중…');
    Object.assign(live, { active: true, buf: '', spoke: false, firstAt: 0, shown: '' });
    const t0 = performance.now();
    try {
      const res = await api.ask(text);
      flushLive();
      live.active = false;
      const sec = (ms) => `${(ms / 1000).toFixed(1)}초`;
      const timing = [sttMs ? `음성 인식 ${sec(sttMs)}` : null, live.firstAt ? `첫 답 ${sec(live.firstAt - t0)}` : null, `전체 ${sec(performance.now() - t0)}`]
        .filter(Boolean)
        .join(' · ');
      if (res.ok) {
        addLog('jarvis', res.reply);
        addLog('timing', timing);
        if (!live.spoke) await say(res.reply);
      } else {
        addLog('error', res.error);
        setState('error', 'ERROR', res.error);
        if (!live.spoke) await say(res.error);
      }
      if (live.spoke) await window.Voice.whenIdle();
    } finally {
      live.active = false;
      window.HUD.fakeSpeech(false);
      window.Voice.visualize = true;
      busy = false;
      mode = baseMode();
      window.Voice.setPaused(false);
      idleState();
      refreshReminders();
    }
  }

  async function say(text) {
    if (!settings.ttsEnabled) return;
    setState('speaking', 'RESPONDING', '');
    window.Voice.visualize = false;
    window.HUD.fakeSpeech(true);
    try {
      await window.Voice.speak(text, Number(settings.ttsRate) || 1.05);
    } finally {
      window.HUD.fakeSpeech(false);
      window.Voice.visualize = true;
    }
  }

  // ---------- 설정 ----------
  const form = $('settings-form');
  const FIELDS = ['userName', 'assistantName', 'model', 'effort', 'sttProvider', 'sttModel', 'sttCloudModel', 'ttsRate', 'sttHints', 'ttsProvider', 'ttsVoice', 'ttsCloudModel', 'ttsInstructions', 'elevenVoiceId', 'googleClientId', 'kakaoRestKey', 'documentsDir', 'mobilePort'];
  const CHECKS = ['wakeWordEnabled', 'ttsEnabled', 'confirmRiskyActions', 'fastMode', 'webSearchEnabled', 'computerUseEnabled', 'mobileEnabled'];
  const SECRETS = ['anthropic', 'googleSecret', 'kakaoSecret', 'openai', 'elevenlabs'];

  async function loadSettings() {
    const data = await api.getSettings();
    settings = data.settings;
    document.body.classList.toggle('mac', data.platform === 'darwin');
    $('hint').textContent = `"${settings.assistantName || '자비스'}"라고 부르거나 ${data.platform === 'darwin' ? 'Option+J' : 'Alt+J'}`;
    for (const f of FIELDS) form.elements[f].value = settings[f] ?? '';
    for (const c of CHECKS) form.elements[c].checked = !!settings[c];
    for (const s of SECRETS) {
      form.elements[s].value = '';
      form.querySelector(`[data-secret="${s}"]`).textContent = data.secrets[s] ? '● 저장됨' : '';
    }
    $('conn-google').textContent = data.connections.google ? '● 연결됨' : '○ 미연결';
    $('conn-google').className = `conn ${data.connections.google ? 'on' : 'off'}`;
    $('conn-kakao').textContent = data.connections.kakao ? '● 연결됨' : '○ 미연결';
    $('conn-kakao').className = `conn ${data.connections.kakao ? 'on' : 'off'}`;
    $('kakao-redirect').textContent = await api.kakaoRedirectUri();
    if (data.platform === 'darwin') {
      $('computer-help').textContent =
        '자비스가 화면을 찍어 보고, 사람처럼 클릭하고 입력합니다. 처음 한 번 시스템 설정 > 개인정보 보호 및 보안에서 "화면 기록"과 "손쉬운 사용"에 JARVIS를 허용해 주세요. 시작할 때 한 번 확인을 묻고, 결제·비밀번호·삭제·전송 같은 일은 하기 전에 물어봅니다. 도중에 멈추려면 Option+Shift+X 를 누르세요. 화면 사진이 Claude로 전송되고, 작업 한 번에 수십~수백 원 정도 듭니다.';
    }
    $('kakao-desktop-help').textContent =
      data.platform === 'darwin'
        ? '친구·단톡방에 카톡을 보내려면 Mac에 kmsg를 설치하세요: 터미널에서 brew install channprj/tap/kmsg (손쉬운 사용 권한 필요)'
        : '친구·단톡방에 카톡을 보내려면 카카오톡 PC 앱을 켜고 로그인한 채로 두세요.';
    form.elements.ttsInstructions.placeholder = data.ttsDefaultInstructions || '';
    window.Voice.setTtsProvider(settings.ttsProvider);
    setInd('ind-claude', data.secrets.anthropic, true);
    setInd('ind-google', data.connections.google);
    setInd('ind-kakao', data.connections.kakao);
    renderMobile(await api.mobileInfo());
    return data;
  }

  function renderMobile(info) {
    const conn = $('conn-mobile');
    conn.textContent = info.running ? '● 켜짐' : '○ 꺼짐';
    conn.className = `conn ${info.running ? 'on' : 'off'}`;
    const box = $('mobile-box');
    box.textContent = '';
    if (info.error) {
      const p = document.createElement('p');
      p.className = 'help err';
      p.textContent = info.error;
      box.appendChild(p);
    }
    for (const u of info.urls || []) {
      const card = document.createElement('div');
      card.className = 'mobile-qr';
      const img = document.createElement('img');
      img.src = u.qr;
      img.alt = 'QR 코드';
      const cap = document.createElement('div');
      cap.innerHTML = `<b></b><code></code>`;
      cap.querySelector('b').textContent = u.tailscale ? 'Tailscale (밖에서도)' : `같은 와이파이 (${u.name})`;
      cap.querySelector('code').textContent = u.url.replace(/#k=.*/, '');
      card.append(img, cap);
      box.appendChild(card);
    }
    if (info.running && info.token) {
      const p = document.createElement('p');
      p.className = 'help';
      p.innerHTML = '연결 코드: <code class="select"></code>';
      p.querySelector('code').textContent = info.token;
      box.appendChild(p);
    }
    $('btn-mobile-token').disabled = !info.enabled;
  }

  async function saveSettings() {
    const next = {};
    for (const f of FIELDS) next[f] = form.elements[f].value.trim();
    next.ttsRate = Number(next.ttsRate) || 1.05;
    next.mobilePort = Math.min(65535, Math.max(1024, Number(next.mobilePort) || 5790));
    for (const c of CHECKS) next[c] = form.elements[c].checked;
    const secrets = {};
    for (const s of SECRETS) if (form.elements[s].value.trim()) secrets[s] = form.elements[s].value.trim();
    await api.saveSettings({ settings: next, secrets });
    await loadSettings();
    mode = baseMode();
    idleState();
    $('save-msg').textContent = '저장했습니다';
    setTimeout(() => ($('save-msg').textContent = ''), 2000);
  }

  async function connectService(fn, name) {
    await saveSettings();
    $('save-msg').textContent = `${name} 로그인 창을 브라우저에서 열었습니다…`;
    const res = await fn();
    $('save-msg').textContent = res.ok ? `${name} 연결 완료` : '';
    if (!res.ok) alert(res.error);
    await loadSettings();
  }

  // ---------- 이벤트 ----------
  $('btn-settings').onclick = async () => {
    await loadSettings();
    $('settings').showModal();
  };
  $('btn-save').onclick = saveSettings;
  $('btn-mobile-token').onclick = async () => {
    if (!confirm('연결 코드를 새로 만들면 지금 연결된 휴대폰은 QR로 다시 연결해야 합니다. 계속할까요?')) return;
    renderMobile(await api.mobileNewToken());
  };
  $('btn-google').onclick = () => connectService(api.googleConnect, '구글');
  $('btn-kakao').onclick = () => connectService(api.kakaoConnect, '카카오');
  $('btn-google-off').onclick = async () => (await api.googleDisconnect(), loadSettings());
  $('btn-kakao-off').onclick = async () => (await api.kakaoDisconnect(), loadSettings());
  document.querySelectorAll('[data-href]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal(a.dataset.href);
    }),
  );

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text || busy) return;
    $('input').value = '';
    window.Voice.stopSpeaking();
    handleCommand(text);
  });
  $('btn-mic').onclick = () => (busy ? window.Voice.stopSpeaking() : enterCommand());
  $('btn-reset').onclick = async () => {
    await api.resetConversation();
    logEl.innerHTML = '';
    addLog('system', '새 대화를 시작합니다. 저장된 기억은 그대로 유지됩니다.');
  };
  $('quick').addEventListener('click', (e) => {
    const q = e.target.closest('button')?.dataset.q;
    if (q && !busy) handleCommand(q);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.Voice.stopSpeaking();
      api.stopAgent();
    }
  });

  api.onHotkey(() => (busy ? window.Voice.stopSpeaking() : enterCommand()));
  api.onStatus((s) => {
    if (s.state === 'thinking') setState('thinking', 'PROCESSING', '생각하는 중…');
    else if (s.state === 'tool') {
      const label = toolLabel(s.tool);
      setState('thinking', 'EXECUTING', `${label}…`);
      addLog('tool', `▸ ${label}`);
    } else if (s.state === 'confirm') setState('thinking', 'AWAITING', '확인 창에서 승인해 주세요');
    else if (s.state === 'delta') onDelta(s.text);
    else if (s.state === 'segment-end') flushLive();
  });
  api.onReminder(async (r) => {
    addLog('jarvis', `알림: ${r.text}`);
    refreshReminders();
    if (!busy) await say(`알림입니다. ${r.text}`);
  });
  api.onSttProgress((p) => {
    if (p.error) {
      setInd('ind-voice', false, true);
      addLog('error', `음성 인식 모델을 불러오지 못했습니다: ${p.error}`);
    } else if (p.ready) {
      sttReady = true;
      setInd('ind-voice', true);
      if (!busy) idleState();
    } else if (p.pct !== undefined && !busy) {
      sttReady = false;
      $('status-sub').textContent = `음성 인식 모델 준비 중… ${p.pct}% (처음 한 번만)`;
    }
  });

  window.Voice.onSegment(onSegmentCaptured);
  window.Voice.onSpeechStart(() => {
    if (mode === 'command') clearTimeout(commandTimer);
  });

  // ---------- 시작 ----------
  (async function boot() {
    tickClock();
    setInterval(tickClock, 1000 * 10);
    let cloudErrShown = false;
    window.Voice.onCloudError((msg) => {
      if (cloudErrShown) return;
      cloudErrShown = true;
      addLog('system', `사람 같은 음성을 불러오지 못해 기본 음성으로 읽었어요. (${msg})`);
    });
    const data = await loadSettings();
    refreshReminders();
    setInterval(refreshReminders, 60 * 1000);
    try {
      await window.Voice.start();
      setInd('ind-mic', true);
    } catch (e) {
      setInd('ind-mic', false, true);
      addLog('error', `마이크를 열 수 없습니다: ${e.message}`);
    }
    mode = baseMode();
    idleState();
    const name = settings.userName ? `${settings.userName}님` : '';
    if (!data.secrets.anthropic) {
      addLog('system', '처음 오셨네요. 오른쪽 위 톱니바퀴(설정)에서 Claude API 키를 입력하면 바로 쓸 수 있습니다.');
    } else {
      addLog('jarvis', `${name ? `${name}, ` : ''}모든 시스템 정상입니다. 무엇을 도와드릴까요?`);
    }
  })();
})();
