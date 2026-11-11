// Electron 메인 프로세스: 창, 설정, 도구, 음성 인식, 알림을 연결합니다.
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, globalShortcut, session, systemPreferences, safeStorage, desktopCapturer, screen } = require('electron');

const store = require('./store');
const stt = require('./stt');
const tts = require('./tts');
const { Agent } = require('./agent');
const { Computer } = require('./computer');
const memory = require('./tools/memory');
const reminders = require('./tools/reminders');
const google = require('./tools/google');
const kakao = require('./tools/kakao');
const pc = require('./tools/pc');
const documents = require('./tools/documents');
const mobile = require('./mobile');

let win = null;
let agent = null;
let mobileServer = null;
let mobileAsking = false; // 지금 처리 중인 명령이 아이폰에서 왔는지
let mobileError = '';

const LOCAL_WAKE_MODEL = 'Xenova/whisper-base';
const STT_HINT = '자비스, 카카오톡, 톡캘린더, 구글 캘린더, 지메일, 일정, 알림, 메일, 검색, 브라우저, 유튜브, 네이버';

// 음성 인식 힌트: 기본 단어 + 이름 + 설정의 "자주 쓰는 단어"
function sttPrompt() {
  const s = store.getSettings();
  const extra = [s.assistantName, s.userName, s.sttHints].filter(Boolean).join(', ');
  return extra ? `${STT_HINT}, ${extra}` : STT_HINT;
}
const STOP_HOTKEY = 'Alt+Shift+X';

function wakeWords() {
  return [...new Set([...store.DEFAULT_SETTINGS.wakeWords, ...(store.getSettings().wakeWords || [])])];
}

function localSttModel() {
  const s = store.getSettings();
  return s.sttProvider === 'openai' ? LOCAL_WAKE_MODEL : s.sttModel;
}

const HOTKEY = process.platform === 'darwin' ? 'Alt+J' : 'Alt+J';

function connections() {
  return { google: google.isConnected(), kakao: kakao.isConnected() };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function confirm(message) {
  // 아이폰에서 보낸 명령이면 확인 창도 아이폰에 띄웁니다.
  if (mobileAsking && mobileServer) return mobileServer.requestConfirm(message);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '자비스 확인',
    message: '이 작업을 실행할까요?',
    detail: message,
    buttons: ['실행', '취소'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#02060c',
    title: 'J.A.R.V.I.S.',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

function buildTools() {
  const electron = { shell, clipboard };
  return [
    ...memory.tools,
    ...reminders.tools,
    ...google.tools,
    ...kakao.tools,
    ...documents.makeTools(electron),
    ...pc.makeTools(electron),
  ];
}

async function transcribeAudio(audio, purpose = 'command') {
  const s = store.getSettings();
  const progress = (pct, file) => send('stt-progress', { pct, file });
  const cloud = s.sttProvider === 'openai';
  const cloudOpts = { apiKey: store.getSecret('openai_api_key'), model: s.sttCloudModel, prompt: sttPrompt() };
  if (!cloud) return stt.transcribe(audio, s.sttModel, progress);
  if (purpose === 'wake') {
    // 호출어는 내 컴퓨터의 가벼운 모델로 먼저 확인하고, 호출어가 있을 때만 클라우드로 정확히 다시 받아씁니다.
    const quick = await stt.transcribe(audio, LOCAL_WAKE_MODEL, progress);
    return stt.stripWakeWord(quick, wakeWords()) === null ? quick : stt.transcribeCloud(audio, cloudOpts);
  }
  return stt.transcribeCloud(audio, cloudOpts);
}

// ---- 아이폰 연결 ----
function mobileToken() {
  let t = store.getSecret('mobile_token');
  if (!t) {
    t = mobile.newToken();
    store.setSecret('mobile_token', t);
  }
  return t;
}

async function stopMobile() {
  if (!mobileServer) return;
  const s = mobileServer;
  mobileServer = null;
  await s.close();
}

async function startMobile() {
  await stopMobile();
  mobileError = '';
  const s = store.getSettings();
  if (!s.mobileEnabled) return;
  mobileToken();
  const server = mobile.createMobileServer({
    getToken: () => store.getSecret('mobile_token'),
    ask: async (text) => {
      mobileAsking = true;
      try {
        return await agent.ask(text, connections());
      } finally {
        mobileAsking = false;
      }
    },
    transcribe: (audio) => transcribeAudio(audio, 'command'),
    tts: (text) => tts.synthesize(text),
    reset: () => agent.reset(),
    info: () => ({ assistantName: store.getSettings().assistantName || '자비스', connections: connections() }),
  });
  try {
    await server.listen(Number(s.mobilePort) || 5790);
    mobileServer = server;
  } catch (e) {
    mobileError = e.code === 'EADDRINUSE' ? `포트 ${s.mobilePort}이(가) 이미 사용 중입니다. 다른 번호로 바꿔 보세요.` : e.message;
  }
}

async function mobileInfo() {
  const QRCode = require('qrcode');
  const s = store.getSettings();
  const port = Number(s.mobilePort) || 5790;
  const token = s.mobileEnabled ? mobileToken() : '';
  const urls = [];
  if (mobileServer) {
    for (const a of mobile.lanAddresses()) {
      const url = `http://${a.address}:${port}/#k=${token}`;
      urls.push({ ...a, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
    }
  }
  return { enabled: !!s.mobileEnabled, running: !!mobileServer, port, error: mobileError, token, urls };
}

function registerIpc() {
  ipcMain.handle('ask', async (_e, text) => {
    try {
      const reply = await agent.ask(String(text || ''), connections());
      send('status', { state: 'idle' });
      return { ok: true, reply };
    } catch (e) {
      send('status', { state: 'idle' });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('transcribe', async (_e, buffer, purpose = 'command') => {
    const t0 = Date.now();
    try {
      const text = await transcribeAudio(new Float32Array(buffer), purpose);
      return { ok: true, text, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: `음성 인식 오류: ${e.message}`, ms: Date.now() - t0 };
    }
  });

  ipcMain.handle('tts', async (_e, text) => {
    try {
      const { mime, data } = await tts.synthesize(String(text || '').slice(0, 1500));
      return { ok: true, mime, data: new Uint8Array(data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('wake:strip', (_e, text) => stt.stripWakeWord(String(text || ''), wakeWords()));

  ipcMain.handle('agent:stop', () => (agent.stop(), true));

  ipcMain.handle('conversation:reset', () => {
    agent.reset();
    return true;
  });

  ipcMain.handle('settings:get', () => ({
    settings: store.getSettings(),
    secrets: {
      anthropic: !!store.getSecret('anthropic_api_key'),
      googleSecret: !!store.getSecret('google_client_secret'),
      kakaoSecret: !!store.getSecret('kakao_client_secret'),
      openai: !!store.getSecret('openai_api_key'),
      elevenlabs: !!store.getSecret('elevenlabs_api_key'),
    },
    ttsDefaultInstructions: tts.DEFAULT_INSTRUCTIONS,
    connections: connections(),
    platform: process.platform,
    hotkey: HOTKEY,
  }));

  ipcMain.handle('settings:save', async (_e, { settings = {}, secrets = {} }) => {
    const before = store.getSettings();
    const allowed = Object.keys(store.DEFAULT_SETTINGS);
    const clean = Object.fromEntries(Object.entries(settings).filter(([k]) => allowed.includes(k)));
    store.saveSettings(clean);
    if (typeof secrets.anthropic === 'string' && secrets.anthropic) store.setSecret('anthropic_api_key', secrets.anthropic.trim());
    if (typeof secrets.googleSecret === 'string' && secrets.googleSecret) store.setSecret('google_client_secret', secrets.googleSecret.trim());
    if (typeof secrets.kakaoSecret === 'string' && secrets.kakaoSecret) store.setSecret('kakao_client_secret', secrets.kakaoSecret.trim());
    if (typeof secrets.openai === 'string' && secrets.openai) store.setSecret('openai_api_key', secrets.openai.trim());
    if (typeof secrets.elevenlabs === 'string' && secrets.elevenlabs) store.setSecret('elevenlabs_api_key', secrets.elevenlabs.trim());
    const after = store.getSettings();
    if (before.mobileEnabled !== after.mobileEnabled || Number(before.mobilePort) !== Number(after.mobilePort) || !!after.mobileEnabled !== !!mobileServer) {
      await startMobile();
    }
    // 바뀐 음성 모델을 미리 불러 둡니다
    stt.getPipe(localSttModel(), (pct, file) => send('stt-progress', { pct, file })).then(
      () => send('stt-progress', { pct: 100, ready: true }),
      (e) => send('stt-progress', { error: e.message }),
    );
    return true;
  });

  const openBrowser = (url) => shell.openExternal(url);
  ipcMain.handle('google:connect', async () => {
    try {
      await google.connect(openBrowser);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('google:disconnect', () => (google.disconnect(), true));
  ipcMain.handle('kakao:connect', async () => {
    try {
      await kakao.connect(openBrowser);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('kakao:disconnect', () => (kakao.disconnect(), true));
  ipcMain.handle('kakao:redirect-uri', () => kakao.REDIRECT_URI);
  ipcMain.handle('open-external', (_e, url) => (/^https?:/i.test(url) ? shell.openExternal(url) : null));
  ipcMain.handle('reminders:list', () => reminders.listReminders());
  ipcMain.handle('mobile:info', () => mobileInfo());
  ipcMain.handle('mobile:new-token', async () => {
    store.setSecret('mobile_token', mobile.newToken());
    return mobileInfo();
  });
}

app.whenReady().then(async () => {
  store.init(app.getPath('userData'), safeStorage);
  stt.init(path.join(app.getPath('userData'), 'models'));

  // 마이크 권한
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'notifications'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'notifications');
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {}
  }

  const computer = new Computer({ desktopCapturer, screen, clipboard });
  agent = new Agent({
    tools: buildTools(),
    confirm,
    onStatus: (s) => {
      // 아이폰 명령은 아이폰에만 진행 상황을 보냅니다 (PC가 대신 말하거나 멈춘 화면이 되지 않게).
      if (mobileAsking) mobileServer?.setStatus(s);
      else send('status', s);
    },
    computer,
    hooks: {
      // 화면을 조작하는 동안 자비스 창을 내려서, 다른 앱을 가리지 않게 합니다.
      async computerStart() {
        if (process.platform === 'darwin') {
          // 손쉬운 사용 권한이 없으면 클릭·입력이 무시되므로 먼저 요청합니다.
          try {
            if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
          } catch {}
        }
        globalShortcut.register(STOP_HOTKEY, () => agent.stop());
        if (win && !win.isDestroyed()) win.minimize();
        await new Promise((r) => setTimeout(r, 400));
      },
      async computerEnd() {
        globalShortcut.unregister(STOP_HOTKEY);
        if (win && !win.isDestroyed()) {
          win.restore();
          win.showInactive();
        }
      },
    },
  });
  app.on('will-quit', () => computer.stop());
  registerIpc();
  createWindow();
  startMobile();

  reminders.startScheduler((r) => {
    if (Notification.isSupported()) new Notification({ title: '자비스 알림', body: r.text }).show();
    send('reminder', r);
  });

  globalShortcut.register(HOTKEY, () => {
    if (!win) createWindow();
    win.show();
    win.focus();
    send('hotkey');
  });

  // 음성 모델을 미리 불러와 첫 명령을 빠르게 합니다.
  stt.getPipe(localSttModel(), (pct, file) => send('stt-progress', { pct, file })).then(
    () => send('stt-progress', { pct: 100, ready: true }),
    (e) => send('stt-progress', { error: e.message }),
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopMobile();
  reminders.stopScheduler();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
