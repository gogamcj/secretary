// 데스크톱 앱용 OAuth 로그인: 브라우저를 열고, 내 컴퓨터의 임시 주소(loopback)로 돌아오는 코드를 받습니다.
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PAGE_OK = `<!doctype html><meta charset="utf-8"><body style="background:#02060c;color:#7fe7ff;font-family:sans-serif;text-align:center;padding-top:20vh">
<h2>연결되었습니다</h2><p>이 창을 닫고 자비스로 돌아가세요.</p></body>`;

/**
 * 로컬 서버를 띄우고 인증 코드를 기다립니다.
 * @param {object} o
 * @param {number} o.port  0이면 아무 빈 포트
 * @param {string} o.path  콜백 경로
 * @param {(redirectUri:string, state:string)=>string} o.buildAuthUrl
 * @param {(url:string)=>Promise<void>} o.openBrowser
 * @returns {Promise<{code:string, redirectUri:string}>}
 */
function waitForCode({ port = 0, path = '/callback', host = '127.0.0.1', buildAuthUrl, openBrowser, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let redirectUri = '';
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${host}`);
      if (u.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE_OK);
      finish();
      if (err) return reject(new Error(`로그인이 취소되었거나 실패했습니다: ${err}`));
      if (gotState !== state) return reject(new Error('보안 확인(state)이 맞지 않습니다. 다시 시도해 주세요.'));
      if (!code) return reject(new Error('인증 코드가 없습니다.'));
      resolve({ code, redirectUri });
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error('로그인 대기 시간이 지났습니다.'));
    }, timeoutMs);
    function finish() {
      clearTimeout(timer);
      setTimeout(() => server.close(), 200);
    }
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`로그인용 로컬 서버를 열 수 없습니다 (포트 ${port}): ${e.message}`));
    });
    server.listen(port, host, async () => {
      const actualPort = server.address().port;
      const hostName = host === '127.0.0.1' && port !== 0 ? 'localhost' : host;
      redirectUri = `http://${hostName}:${actualPort}${path}`;
      try {
        await openBrowser(buildAuthUrl(redirectUri, state));
      } catch (e) {
        finish();
        reject(e);
      }
    });
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.error_description || data.error || data.msg || text;
    throw new Error(`토큰 요청 실패 (${res.status}): ${msg}`);
  }
  return data;
}

module.exports = { waitForCode, pkce, postForm };
