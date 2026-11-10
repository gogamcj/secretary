// 화면 조작 (Claude 컴퓨터 사용 도구): 화면을 찍어 Claude에게 보여 주고,
// Claude가 고른 마우스·키보드 동작을 실제로 실행합니다.
// - 화면 캡처: Electron desktopCapturer (주 모니터)
// - Windows: PowerShell에 C#(user32.dll)을 한 번 올려 두고 계속 재사용합니다.
// - Mac: osascript(JavaScript for Automation)로 CoreGraphics 이벤트를 보냅니다.
//   (시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용 / 화면 기록에서 JARVIS를 허용해야 합니다.)
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LONG_EDGE = 1280; // 스크린샷 긴 변 (모델 한도 안, 비용·속도 절약)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 키 이름 ----------
const MOD_ALIASES = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', super: 'super', cmd: 'super', command: 'super', meta: 'super', win: 'super', windows: 'super' };
const KEY_ALIASES = {
  return: 'Return', enter: 'Return', kp_enter: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', page_up: 'Page_Up', pageup: 'Page_Up', prior: 'Page_Up',
  page_down: 'Page_Down', pagedown: 'Page_Down', next: 'Page_Down', insert: 'Insert', caps_lock: 'Caps_Lock', print: 'Print',
};

/** "ctrl+shift+t" → { mods: ['ctrl','shift'], key: 't' }. "shift" 하나만 → { mods: [], key: 'shift' } */
function normKey(p) {
  const low = p.toLowerCase();
  if (MOD_ALIASES[low]) return MOD_ALIASES[low];
  if (KEY_ALIASES[low]) return KEY_ALIASES[low];
  if (/^f([1-9]|1[0-2])$/i.test(p)) return p.toUpperCase();
  return p.length === 1 ? p.toLowerCase() : p;
}
function parseCombo(text) {
  const parts = String(text || '')
    .split(/\+(?!$)/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normKey);
  if (!parts.length) return { mods: [], key: null };
  return { mods: parts.slice(0, -1).filter((m) => MAC_FLAG_NAMES.has(m)), key: parts[parts.length - 1] };
}
const MAC_FLAG_NAMES = new Set(['ctrl', 'shift', 'alt', 'super']);

function parseMods(text) {
  if (!text) return [];
  return String(text)
    .split('+')
    .map((p) => MOD_ALIASES[p.trim().toLowerCase()])
    .filter(Boolean);
}

// ---------- Windows ----------
const WIN_VK = {
  ctrl: 0x11, shift: 0x10, alt: 0x12, super: 0x5b, Return: 0x0d, Tab: 0x09, Escape: 0x1b, BackSpace: 0x08, Delete: 0x2e, space: 0x20,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27, Home: 0x24, End: 0x23, Page_Up: 0x21, Page_Down: 0x22, Insert: 0x2d, Caps_Lock: 0x14, Print: 0x2c,
  '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0,
};
const WIN_EXTENDED = new Set([0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2d, 0x2e, 0x5b]);
function winVk(name) {
  if (WIN_VK[name] !== undefined) return WIN_VK[name];
  if (/^F([1-9]|1[0-2])$/.test(name)) return 0x6f + Number(name.slice(1));
  if (/^[a-z]$/i.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  throw new Error(`모르는 키: ${name}`);
}

const WIN_HELPER = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class JarvisInput {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  public struct POINT { public int X; public int Y; }
  public static void Init() { SetProcessDPIAware(); }
  public static string Run(string line) {
    var a = line.Split(' ');
    switch (a[0]) {
      case "move": SetCursorPos(int.Parse(a[1]), int.Parse(a[2])); return "OK";
      case "btn": {
        uint f = 0;
        bool up = a[2] == "up";
        if (a[1] == "left") f = up ? 0x4u : 0x2u;
        else if (a[1] == "right") f = up ? 0x10u : 0x8u;
        else f = up ? 0x40u : 0x20u;
        mouse_event(f, 0, 0, 0, UIntPtr.Zero); return "OK";
      }
      case "wheel": mouse_event(a[1] == "v" ? 0x800u : 0x1000u, 0, 0, int.Parse(a[2]), UIntPtr.Zero); return "OK";
      case "key": {
        uint kf = (a[2] == "up" ? 0x2u : 0u) | (a[3] == "1" ? 0x1u : 0u);
        keybd_event((byte)int.Parse(a[1]), 0, kf, UIntPtr.Zero); return "OK";
      }
      case "pos": { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
    }
    return "ERR";
  }
}
"@
[JarvisInput]::Init()
[Console]::Out.WriteLine("READY")
while (($line = [Console]::In.ReadLine()) -ne $null) { try { [Console]::Out.WriteLine([JarvisInput]::Run($line)) } catch { [Console]::Out.WriteLine("ERR " + $_) } }
`;

class WinDriver {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.buf = '';
    this.waiters = [];
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      // 도우미 스크립트를 임시 파일로 저장해 실행하고, 명령은 한 줄씩 표준 입력으로 보냅니다.
      const file = path.join(os.tmpdir(), 'jarvis-input-helper.ps1');
      fs.writeFileSync(file, '\ufeff' + WIN_HELPER.replace(/\r?\n/g, '\r\n'), 'utf8');
      const p = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
      this.proc = p;
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line === 'READY') resolve();
          else if (line && this.waiters.length) this.waiters.shift()(line);
        }
      });
      p.on('exit', () => {
        this.ready = null;
        this.proc = null;
        this.waiters.splice(0).forEach((w) => w('ERR helper exited'));
        reject(new Error('입력 도우미가 종료되었습니다.'));
      });
      setTimeout(() => reject(new Error('입력 도우미를 시작하지 못했습니다.')), 20000);
    });
    this.ready.catch(() => {});
    return this.ready;
  }
  async cmd(line) {
    await this.start();
    return new Promise((resolve, reject) => {
      this.waiters.push((out) => (out.startsWith('ERR') ? reject(new Error(out)) : resolve(out)));
      this.proc.stdin.write(line + '\r\n');
    });
  }
  // x, y: 물리 픽셀
  move(x, y) {
    return this.cmd(`move ${Math.round(x)} ${Math.round(y)}`);
  }
  button(b, down) {
    return this.cmd(`btn ${b} ${down ? 'down' : 'up'}`);
  }
  async click(b, count) {
    for (let i = 0; i < count; i++) {
      await this.button(b, true);
      await this.button(b, false);
      if (i < count - 1) await sleep(40);
    }
  }
  async drag(x1, y1, x2, y2) {
    await this.move(x1, y1);
    await this.button('left', true);
    for (let s = 1; s <= 10; s++) {
      await this.move(x1 + ((x2 - x1) * s) / 10, y1 + ((y2 - y1) * s) / 10);
      await sleep(15);
    }
    await this.button('left', false);
  }
  async scroll(dir, amount) {
    const n = Math.max(1, Math.min(30, Math.round(amount || 3)));
    if (dir === 'up' || dir === 'down') return this.cmd(`wheel v ${(dir === 'up' ? 120 : -120) * n}`);
    return this.cmd(`wheel h ${(dir === 'right' ? 120 : -120) * n}`);
  }
  key(name, down) {
    const vk = winVk(name);
    return this.cmd(`key ${vk} ${down ? 'down' : 'up'} ${WIN_EXTENDED.has(vk) ? 1 : 0}`);
  }
  async position() {
    const [x, y] = (await this.cmd('pos')).split(' ').map(Number);
    return { x, y };
  }
  pasteMods() {
    return ['ctrl'];
  }
  stop() {
    if (this.proc) this.proc.kill();
  }
}

// ---------- Mac ----------
const MAC_KEYCODE = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23,
  '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, Return: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42,
  ',': 43, '/': 44, n: 45, m: 46, '.': 47, Tab: 48, space: 49, '`': 50, BackSpace: 51, Escape: 53, super: 55, shift: 56, Caps_Lock: 57, alt: 58, ctrl: 59,
  Left: 123, Right: 124, Down: 125, Up: 126, Home: 115, End: 119, Page_Up: 116, Page_Down: 121, Delete: 117, Insert: 114,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};
const MAC_FLAG = { super: 0x100000, shift: 0x20000, ctrl: 0x40000, alt: 0x80000 };

class MacDriver {
  constructor() {
    this.held = new Set(); // 눌린 수정키 (플래그 계산용)
    this.mouseDown = false;
  }
  run(body) {
    const script = `ObjC.import('CoreGraphics');
function post(e){ $.CGEventPost(0, e); }
function here(){ return $.CGEventGetLocation($.CGEventCreate(null)); }
function pt(x, y){ return typeof $.CGPointMake === 'function' ? $.CGPointMake(x, y) : { x: x, y: y }; }
function mouse(type, x, y, btn, clicks){ var e = $.CGEventCreateMouseEvent(null, type, pt(x, y), btn); if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); post(e); }
function key(code, down, flags){ var e = $.CGEventCreateKeyboardEvent(null, code, down); $.CGEventSetFlags(e, flags); post(e); }
function pause(ms){ delay(ms / 1000); }
${body}`;
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)));
        else resolve(String(stdout).trim());
      });
    });
  }
  move(x, y) {
    return this.run(`mouse(${this.mouseDown ? 6 : 5}, ${x}, ${y}, 0, 0);`);
  }
  button(b, down) {
    const t = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[b];
    if (b === 'left') this.mouseDown = down;
    return this.run(`var p = here(); mouse(${down ? t[0] : t[1]}, p.x, p.y, ${t[2]}, 1);`);
  }
  click(b, count) {
    const t = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[b];
    return this.run(`var p = here(); for (var i = 1; i <= ${count}; i++) { mouse(${t[0]}, p.x, p.y, ${t[2]}, i); mouse(${t[1]}, p.x, p.y, ${t[2]}, i); pause(30); }`);
  }
  drag(x1, y1, x2, y2) {
    return this.run(`mouse(5, ${x1}, ${y1}, 0, 0); mouse(1, ${x1}, ${y1}, 0, 1);
for (var s = 1; s <= 10; s++) { mouse(6, ${x1} + (${x2 - x1}) * s / 10, ${y1} + (${y2 - y1}) * s / 10, 0, 0); pause(15); }
mouse(2, ${x2}, ${y2}, 0, 1);`);
  }
  scroll(dir, amount) {
    const n = Math.max(1, Math.min(30, Math.round(amount || 3)));
    const dy = dir === 'up' ? n : dir === 'down' ? -n : 0;
    const dx = dir === 'left' ? n : dir === 'right' ? -n : 0;
    // 스크롤 휠 이벤트가 안 되는 macOS에서는 방향키로 대신 움직입니다.
    const fallback = { up: 126, down: 125, left: 123, right: 124 }[dir];
    return this.run(`try { post($.CGEventCreateScrollWheelEvent2(null, 0, 2, ${dy}, ${dx}, 0)); } catch (err) { for (var i = 0; i < ${n}; i++) { key(${fallback}, true, 0); key(${fallback}, false, 0); } }`);
  }
  key(name, down) {
    const code = MAC_KEYCODE[name];
    if (code === undefined) throw new Error(`모르는 키: ${name}`);
    if (MAC_FLAG[name]) down ? this.held.add(name) : this.held.delete(name);
    const flags = [...this.held].reduce((f, m) => f | MAC_FLAG[m], 0);
    return this.run(`key(${code}, ${down ? 'true' : 'false'}, ${flags});`);
  }
  async position() {
    const out = await this.run(`var p = here(); Math.round(p.x) + ' ' + Math.round(p.y);`);
    const [x, y] = out.split(' ').map(Number);
    return { x, y };
  }
  pasteMods() {
    return ['super'];
  }
  stop() {}
}

// ---------- 컴퓨터 ----------
/**
 * electron: { desktopCapturer, screen, clipboard, nativeImage }
 * driver: 테스트에서 가짜 드라이버를 넣을 수 있습니다.
 */
class Computer {
  constructor(electron, driver) {
    this.e = electron;
    this.platform = process.platform;
    this.driver = driver || (this.platform === 'win32' ? new WinDriver() : this.platform === 'darwin' ? new MacDriver() : null);
    this.k = 1; // 스크린샷 픽셀 / 화면 논리 픽셀
    this.display = null;
  }

  supported() {
    return !!this.driver;
  }

  primary() {
    this.display = this.e.screen.getPrimaryDisplay();
    return this.display;
  }

  // 스크린샷 좌표 → 드라이버 좌표 (Windows: 물리 픽셀, Mac: 포인트)
  toDriver([x, y]) {
    const d = this.display || this.primary();
    const lx = d.bounds.x + x / this.k;
    const ly = d.bounds.y + y / this.k;
    const f = this.platform === 'win32' ? d.scaleFactor || 1 : 1;
    return [lx * f, ly * f];
  }

  fromDriver({ x, y }) {
    const d = this.display || this.primary();
    const f = this.platform === 'win32' ? d.scaleFactor || 1 : 1;
    return [Math.round((x / f - d.bounds.x) * this.k), Math.round((y / f - d.bounds.y) * this.k)];
  }

  async capture(longEdge) {
    const d = this.primary();
    const { width, height } = d.size; // 논리 픽셀
    const scale = Math.min(longEdge / Math.max(width, height), d.scaleFactor || 1);
    const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
    const sources = await this.e.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) {
      throw new Error(
        this.platform === 'darwin'
          ? '화면을 캡처하지 못했습니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 JARVIS를 허용한 뒤 앱을 다시 켜 주세요.'
          : '화면을 캡처하지 못했습니다.',
      );
    }
    return { img: src.thumbnail, width };
  }

  async screenshot() {
    const { img, width } = await this.capture(MAX_LONG_EDGE);
    this.k = img.getSize().width / width;
    return img.toJPEG(80).toString('base64');
  }

  async zoom([x0, y0, x1, y1]) {
    const { img, width } = await this.capture(4096);
    const kFull = img.getSize().width / width;
    const r = kFull / this.k;
    const rect = {
      x: Math.max(0, Math.round(Math.min(x0, x1) * r)),
      y: Math.max(0, Math.round(Math.min(y0, y1) * r)),
      width: Math.max(8, Math.round(Math.abs(x1 - x0) * r)),
      height: Math.max(8, Math.round(Math.abs(y1 - y0) * r)),
    };
    let crop = img.crop(rect);
    const s = crop.getSize();
    const fit = MAX_LONG_EDGE / Math.max(s.width, s.height);
    if (fit < 1) crop = crop.resize({ width: Math.round(s.width * fit), height: Math.round(s.height * fit) });
    return crop.toJPEG(85).toString('base64');
  }

  async moveTo(coordinate) {
    if (!coordinate) return;
    const [x, y] = this.toDriver(coordinate);
    await this.driver.move(x, y);
    await sleep(30);
  }

  async withMods(text, fn) {
    const mods = parseMods(text);
    for (const m of mods) await this.driver.key(m, true);
    try {
      return await fn();
    } finally {
      for (const m of mods.reverse()) await this.driver.key(m, false);
    }
  }

  async pressCombo(text) {
    const { mods, key } = parseCombo(text);
    if (!key) throw new Error(`키 이름이 비었습니다: ${text}`);
    for (const m of mods) await this.driver.key(m, true);
    try {
      await this.driver.key(key, true);
      await this.driver.key(key, false);
    } finally {
      for (const m of [...mods].reverse()) await this.driver.key(m, false);
    }
  }

  // 한글을 포함한 글자는 클립보드에 넣고 붙여넣기로 입력합니다 (키보드 한/영 상태와 상관없이 정확).
  async typeText(text) {
    const cb = this.e.clipboard;
    const prev = cb.readText();
    cb.writeText(String(text));
    await this.pressCombo([...this.driver.pasteMods(), 'v'].join('+'));
    await sleep(250);
    cb.writeText(prev);
  }

  /** 도구 이름과 입력으로 동작 하나를 실행합니다. 이미지가 필요하면 { image } 를 돌려줍니다. */
  async perform(name, input = {}) {
    if (!this.driver) throw new Error('이 운영체제에서는 화면 조작을 지원하지 않습니다.');
    const d = this.driver;
    switch (name) {
      case 'screenshot':
        return { image: await this.screenshot() };
      case 'zoom':
        if (!Array.isArray(input.region) || input.region.length !== 4) throw new Error('region은 [x0, y0, x1, y1] 이어야 합니다.');
        return { image: await this.zoom(input.region) };
      case 'mouse_move':
        await this.moveTo(input.coordinate);
        return { text: 'OK' };
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        await this.moveTo(input.coordinate);
        const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
        const count = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
        await this.withMods(input.text, () => d.click(button, count));
        return { text: 'OK' };
      }
      case 'left_click_drag': {
        const [x1, y1] = this.toDriver(input.start_coordinate);
        const [x2, y2] = this.toDriver(input.coordinate);
        await this.withMods(input.text, () => d.drag(x1, y1, x2, y2));
        return { text: 'OK' };
      }
      case 'left_mouse_down':
        await d.button('left', true);
        return { text: 'OK' };
      case 'left_mouse_up':
        await d.button('left', false);
        return { text: 'OK' };
      case 'cursor_position': {
        const [x, y] = this.fromDriver(await d.position());
        return { text: `[${x}, ${y}]` };
      }
      case 'scroll':
        await this.moveTo(input.coordinate);
        await this.withMods(input.text, () => d.scroll(input.scroll_direction, input.scroll_amount));
        return { text: 'OK' };
      case 'type':
        await this.typeText(input.text || '');
        return { text: 'OK' };
      case 'key': {
        const n = Math.max(1, Math.min(100, Number(input.repeat) || 1));
        for (let i = 0; i < n; i++) await this.pressCombo(input.text);
        return { text: 'OK' };
      }
      case 'hold_key': {
        const { mods, key } = parseCombo(input.text);
        const keys = [...mods, ...(key ? [key] : [])];
        for (const k of keys) await d.key(k, true);
        await sleep(Math.min(300, Number(input.duration) || 1) * 1000);
        for (const k of keys.reverse()) await d.key(k, false);
        return { text: 'OK' };
      }
      case 'wait':
        await sleep(Math.min(300, Math.max(0, Number(input.duration) || 1)) * 1000);
        return { text: 'OK' };
      default:
        throw new Error(`지원하지 않는 화면 동작: ${name}`);
    }
  }

  stop() {
    this.driver?.stop?.();
  }
}

module.exports = { Computer, parseCombo, parseMods, winVk, MAC_KEYCODE };
