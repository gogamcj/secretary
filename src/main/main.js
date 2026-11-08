// Electron 메인 프로세스: 창, 설정, 도구, 음성 인식, 알림을 연결합니다.
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, globalShortcut, session, systemPreferences, safeStorage } = require('electron');

const store = require('./store');
const stt = require('./stt');
const { Agent } = require('./agent');
const memory = require('./tools/memory');
const reminders = require('./tools/reminders');
const google = require('./tools/google');
const kakao = require('./tools/kakao');
const pc = require('./tools/pc');
const documents = require('./tools/documents');

let win = null;
let agent = null;

const HOTKEY = process.platform === 'darwin' ? 'Alt+J' : 'Alt+J';

function connections() {
  return { google: google.isConnected(), kakao: kakao.isConnected() };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function confirm(message) {
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

  ipcMain.handle('transcribe', async (_e, buffer) => {
    try {
      const audio = new Float32Array(buffer);
      const s = store.getSettings();
      const text = await stt.transcribe(audio, s.sttModel, (pct, file) => send('stt-progress', { pct, file }));
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: `음성 인식 오류: ${e.message}` };
    }
  });

  ipcMain.handle('wake:strip', (_e, text) => stt.stripWakeWord(String(text || ''), store.getSettings().wakeWords));

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
    },
    connections: connections(),
    platform: process.platform,
    hotkey: HOTKEY,
  }));

  ipcMain.handle('settings:save', (_e, { settings = {}, secrets = {} }) => {
    const allowed = Object.keys(store.DEFAULT_SETTINGS);
    const clean = Object.fromEntries(Object.entries(settings).filter(([k]) => allowed.includes(k)));
    store.saveSettings(clean);
    if (typeof secrets.anthropic === 'string' && secrets.anthropic) store.setSecret('anthropic_api_key', secrets.anthropic.trim());
    if (typeof secrets.googleSecret === 'string' && secrets.googleSecret) store.setSecret('google_client_secret', secrets.googleSecret.trim());
    if (typeof secrets.kakaoSecret === 'string' && secrets.kakaoSecret) store.setSecret('kakao_client_secret', secrets.kakaoSecret.trim());
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

  agent = new Agent({ tools: buildTools(), confirm, onStatus: (s) => send('status', s) });
  registerIpc();
  createWindow();

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
  stt.getPipe(store.getSettings().sttModel, (pct, file) => send('stt-progress', { pct, file })).then(
    () => send('stt-progress', { pct: 100, ready: true }),
    (e) => send('stt-progress', { error: e.message }),
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  reminders.stopScheduler();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
