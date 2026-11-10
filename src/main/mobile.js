// 아이폰(모바일) 연결 서버
// PC에서 켜져 있는 자비스에 아이폰 사파리로 접속해 쓰게 해 줍니다.
// - 두뇌(Claude)와 도구(메일, 캘린더, 카카오톡, PC 조작)는 모두 PC에서 실행됩니다.
// - 아이폰은 연결 코드(토큰)가 있어야만 쓸 수 있습니다. 처음 한 번 QR/링크로 받아 저장합니다.
// - 위험한 작업의 확인 창은 명령을 보낸 아이폰 화면에 뜹니다.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC_DIR = path.join(__dirname, '..', 'mobile');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
};

const MAX_JSON = 64 * 1024;
const MAX_AUDIO = 16000 * 4 * 120; // 16kHz float32 최대 2분
const MAX_BAD_AUTH = 10;
const BLOCK_MS = 10 * 60 * 1000;
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// 아이폰에서 접속할 수 있는 이 컴퓨터의 주소들 (와이파이, Tailscale 100.x 등)
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = a.address.startsWith('100.') || /tailscale|utun/i.test(name);
      out.push({ name, address: a.address, tailscale });
    }
  }
  return out.sort((a, b) => Number(a.tailscale) - Number(b.tailscale));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req, MAX_JSON);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('잘못된 요청입니다.'), { status: 400 });
  }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * handlers:
 *   getToken(): string             현재 연결 코드
 *   ask(text): Promise<string>     자비스에게 묻기 (확인은 requestConfirm으로 아이폰에 옴)
 *   transcribe(Float32Array): Promise<string>
 *   tts(text): Promise<{mime, data}>  (클라우드 음성이 꺼져 있으면 throw → 아이폰 기본 음성 사용)
 *   reset(): void
 *   info(): object                 상태 표시용 (이름, 연결된 서비스)
 */
function createMobileServer(handlers) {
  const bad = new Map(); // ip -> { count, until }
  let busy = false;
  let pending = null; // { id, message, resolve, timer }
  let lastStatus = null;

  function blocked(ip) {
    const b = bad.get(ip);
    if (!b) return false;
    if (b.until && b.until > Date.now()) return true;
    if (b.until && b.until <= Date.now()) bad.delete(ip);
    return false;
  }

  function failAuth(ip) {
    const b = bad.get(ip) || { count: 0, until: 0 };
    b.count += 1;
    if (b.count >= MAX_BAD_AUTH) b.until = Date.now() + BLOCK_MS;
    bad.set(ip, b);
  }

  function authorized(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && safeEqual(m[1], handlers.getToken());
  }

  // 아이폰에서 온 명령 도중 위험한 작업이면 아이폰에 확인을 요청합니다.
  function requestConfirm(message) {
    if (pending) pending.resolve(false);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const done = (ok) => {
        clearTimeout(pending?.timer);
        pending = null;
        resolve(!!ok);
      };
      pending = { id, message: String(message || ''), resolve: done, timer: setTimeout(() => done(false), CONFIRM_TIMEOUT_MS) };
    });
  }

  function setStatus(s) {
    if (!s || s.state === 'delta') return;
    lastStatus = s.state === 'idle' ? null : { state: s.state, tool: s.tool || null };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC_FILES[p]) {
      const [file, type] = STATIC_FILES[p];
      fs.readFile(path.join(STATIC_DIR, file), (err, data) => {
        if (err) return sendJSON(res, 404, { ok: false, error: 'not found' });
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }

    if (!p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'not found' });

    const ip = req.socket.remoteAddress || '';
    if (blocked(ip)) return sendJSON(res, 429, { ok: false, error: '연결 코드가 여러 번 틀려 잠시 막혔습니다. 10분 뒤 다시 시도하세요.' });
    if (!authorized(req)) {
      failAuth(ip);
      return sendJSON(res, 401, { ok: false, error: '연결 코드가 맞지 않습니다. PC 자비스 설정의 QR 코드로 다시 연결하세요.' });
    }
    bad.delete(ip);

    if (req.method === 'GET' && p === '/api/status') {
      return sendJSON(res, 200, {
        ok: true,
        busy,
        status: lastStatus,
        confirm: pending ? { id: pending.id, message: pending.message } : null,
        ...(handlers.info ? handlers.info() : {}),
      });
    }

    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });

    if (p === '/api/ask') {
      const { text } = await readJSON(req);
      const q = String(text || '').trim().slice(0, 4000);
      if (!q) return sendJSON(res, 400, { ok: false, error: '내용이 비어 있습니다.' });
      if (busy) return sendJSON(res, 409, { ok: false, error: '자비스가 다른 명령을 처리하고 있습니다. 잠시 뒤 다시 시도하세요.' });
      busy = true;
      try {
        const reply = await handlers.ask(q);
        return sendJSON(res, 200, { ok: true, reply });
      } finally {
        busy = false;
        lastStatus = null;
        if (pending) pending.resolve(false);
      }
    }

    if (p === '/api/confirm') {
      const { id, ok } = await readJSON(req);
      if (!pending || pending.id !== id) return sendJSON(res, 404, { ok: false, error: '확인할 작업이 없습니다.' });
      pending.resolve(ok === true);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/transcribe') {
      const buf = await readBody(req, MAX_AUDIO);
      if (!buf.length || buf.length % 4 !== 0) return sendJSON(res, 400, { ok: false, error: '음성 데이터가 올바르지 않습니다.' });
      const audio = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      const text = await handlers.transcribe(audio);
      return sendJSON(res, 200, { ok: true, text });
    }

    if (p === '/api/tts') {
      const { text } = await readJSON(req);
      try {
        const { mime, data } = await handlers.tts(String(text || '').slice(0, 1500));
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': data.length });
        return res.end(data);
      } catch {
        res.writeHead(204);
        return res.end();
      }
    }

    if (p === '/api/reset') {
      handlers.reset();
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!res.headersSent) sendJSON(res, e.status || 500, { ok: false, error: e.message || '오류가 났습니다.' });
      else res.end();
    });
  });

  return {
    server,
    requestConfirm,
    setStatus,
    get busy() {
      return busy;
    },
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      if (pending) pending.resolve(false);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createMobileServer, newToken, lanAddresses, safeEqual };
