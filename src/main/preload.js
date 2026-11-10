const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('jarvis', {
  ask: (text) => ipcRenderer.invoke('ask', text),
  transcribe: (float32, purpose) => ipcRenderer.invoke('transcribe', float32.buffer, purpose),
  tts: (text) => ipcRenderer.invoke('tts', text),
  stripWakeWord: (text) => ipcRenderer.invoke('wake:strip', text),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  resetConversation: () => ipcRenderer.invoke('conversation:reset'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  googleConnect: () => ipcRenderer.invoke('google:connect'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  kakaoConnect: () => ipcRenderer.invoke('kakao:connect'),
  kakaoDisconnect: () => ipcRenderer.invoke('kakao:disconnect'),
  kakaoRedirectUri: () => ipcRenderer.invoke('kakao:redirect-uri'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  listReminders: () => ipcRenderer.invoke('reminders:list'),
  mobileInfo: () => ipcRenderer.invoke('mobile:info'),
  mobileNewToken: () => ipcRenderer.invoke('mobile:new-token'),
  onStatus: on('status'),
  onReminder: on('reminder'),
  onHotkey: on('hotkey'),
  onSttProgress: on('stt-progress'),
});
