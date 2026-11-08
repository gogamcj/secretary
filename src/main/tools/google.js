// Gmail, 구글 캘린더, 구글 문서 연동 (Google REST API 직접 호출)
const store = require('../store');
const { waitForCode, pkce, postForm } = require('../oauth');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/documents',
  'openid',
  'email',
];
const TOKEN_KEY = 'google_tokens';

function clientInfo() {
  const s = store.getSettings();
  return { clientId: s.googleClientId, clientSecret: store.getSecret('google_client_secret') };
}

function isConnected() {
  return !!store.getSecretJSON(TOKEN_KEY)?.refresh_token;
}

async function connect(openBrowser) {
  const { clientId, clientSecret } = clientInfo();
  if (!clientId) throw new Error('설정에서 Google OAuth 클라이언트 ID를 먼저 입력해 주세요.');
  const { verifier, challenge } = pkce();
  const { code, redirectUri } = await waitForCode({
    port: 0,
    path: '/oauth/google',
    openBrowser,
    buildAuthUrl: (redirectUri, state) => {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      return u.toString();
    },
  });
  const params = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  };
  if (clientSecret) params.client_secret = clientSecret;
  const tok = await postForm('https://oauth2.googleapis.com/token', params);
  saveTokens(tok);
  return true;
}

function disconnect() {
  store.setSecretJSON(TOKEN_KEY, null);
}

function saveTokens(tok) {
  const prev = store.getSecretJSON(TOKEN_KEY) || {};
  store.setSecretJSON(TOKEN_KEY, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000 - 60000,
  });
}

async function accessToken() {
  const t = store.getSecretJSON(TOKEN_KEY);
  if (!t?.refresh_token) throw new Error('구글 계정이 연결되지 않았습니다. 설정에서 "구글 연결"을 눌러 주세요.');
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  const { clientId, clientSecret } = clientInfo();
  const params = { client_id: clientId, refresh_token: t.refresh_token, grant_type: 'refresh_token' };
  if (clientSecret) params.client_secret = clientSecret;
  const tok = await postForm('https://oauth2.googleapis.com/token', params);
  saveTokens(tok);
  return tok.access_token;
}

async function api(url, { method = 'GET', body, query } = {}) {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, item);
    }
  }
  const res = await fetch(u, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API 오류 (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

// ---------- Gmail ----------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeB64Url(s) {
  return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeB64Url(payload.body.data);
  for (const p of payload.parts || []) {
    const t = extractText(p);
    if (t) return t;
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeB64Url(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

function encodeHeader(v) {
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function buildRawEmail({ to, cc, subject, body }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body || '', 'utf8').toString('base64'),
  ].filter((l) => l !== null);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// ---------- Calendar ----------
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function toEventTime(value, allDay) {
  if (allDay) return { date: String(value).slice(0, 10) };
  return { dateTime: new Date(value).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

const fmtTime = (t) => (t?.date ? `${t.date} (종일)` : new Date(t?.dateTime).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }));

const tools = [
  {
    name: 'gmail_search',
    description: 'Gmail에서 메일을 검색합니다. Gmail 검색 문법을 씁니다 (예: "is:unread", "from:김철수", "newer_than:2d", "subject:견적").',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail 검색어. 비우면 받은편지함 최신 메일' },
        max: { type: 'integer', description: '최대 개수 (기본 10)' },
      },
      additionalProperties: false,
    },
    run: async ({ query, max }) => {
      const list = await api(`${GMAIL}/messages`, { query: { q: query || 'in:inbox', maxResults: Math.min(max || 10, 25) } });
      if (!list.messages?.length) return '해당하는 메일이 없습니다.';
      const rows = await Promise.all(
        list.messages.map(async ({ id }) => {
          const m = await api(`${GMAIL}/messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject'] } });
          const h = m.payload?.headers || [];
          const unread = m.labelIds?.includes('UNREAD') ? '[안읽음] ' : '';
          const date = new Date(Number(m.internalDate)).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
          return `- ${unread}${date} | ${header(h, 'From')} | ${header(h, 'Subject')} | ${m.snippet} (id:${id})`;
        }),
      );
      return rows.join('\n');
    },
  },
  {
    name: 'gmail_read',
    description: '메일 한 통의 본문을 읽습니다.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => {
      const m = await api(`${GMAIL}/messages/${id}`, { query: { format: 'full' } });
      const h = m.payload?.headers;
      const text = extractText(m.payload).slice(0, 12000);
      return `보낸 사람: ${header(h, 'From')}\n받는 사람: ${header(h, 'To')}\n날짜: ${header(h, 'Date')}\n제목: ${header(h, 'Subject')}\n\n${text}`;
    },
  },
  {
    name: 'gmail_send',
    description: 'Gmail로 메일을 보냅니다. draft_only가 true면 보내지 않고 임시보관함에 저장합니다. 보내기 전 사용자 확인 창이 뜹니다.',
    risky: (i) => (i.draft_only ? null : `메일을 보낼까요?\n\n받는 사람: ${i.to}\n제목: ${i.subject}\n\n${String(i.body).slice(0, 600)}`),
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '받는 사람 이메일 (여러 명은 쉼표로)' },
        cc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string', description: '본문 (일반 텍스트)' },
        draft_only: { type: 'boolean' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    run: async (i) => {
      const raw = buildRawEmail(i);
      if (i.draft_only) {
        const d = await api(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw } } });
        return `임시보관함에 저장했습니다 (draft id: ${d.id})`;
      }
      const r = await api(`${GMAIL}/messages/send`, { method: 'POST', body: { raw } });
      return `메일을 보냈습니다 (id: ${r.id})`;
    },
  },
  {
    name: 'calendar_list_events',
    description: '구글 캘린더(기본 캘린더)의 일정을 기간으로 조회합니다.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '시작 시각 ISO 8601 (시간대 포함)' },
        to: { type: 'string', description: '끝 시각 ISO 8601 (시간대 포함)' },
        query: { type: 'string', description: '제목 검색어 (선택)' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run: async ({ from, to, query }) => {
      const data = await api(CAL, {
        query: {
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: 50,
          q: query,
        },
      });
      if (!data.items?.length) return '해당 기간에 일정이 없습니다.';
      return data.items
        .map((e) => `- ${fmtTime(e.start)} ~ ${fmtTime(e.end)} | ${e.summary || '(제목 없음)'}${e.location ? ` @ ${e.location}` : ''} (id:${e.id})`)
        .join('\n');
    },
  },
  {
    name: 'calendar_create_event',
    description: '구글 캘린더에 일정을 추가합니다.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: '시작 ISO 8601 (종일이면 YYYY-MM-DD)' },
        end: { type: 'string', description: '끝 ISO 8601 (종일이면 다음 날 YYYY-MM-DD)' },
        all_day: { type: 'boolean' },
        location: { type: 'string' },
        description: { type: 'string' },
        reminder_minutes: { type: 'integer', description: '몇 분 전에 알림 (선택)' },
      },
      required: ['title', 'start', 'end'],
      additionalProperties: false,
    },
    run: async (i) => {
      const body = {
        summary: i.title,
        location: i.location,
        description: i.description,
        start: toEventTime(i.start, i.all_day),
        end: toEventTime(i.end, i.all_day),
      };
      if (Number.isInteger(i.reminder_minutes)) {
        body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: i.reminder_minutes }] };
      }
      const e = await api(CAL, { method: 'POST', body });
      return `구글 캘린더에 추가했습니다: ${fmtTime(e.start)} ${e.summary} (id:${e.id})\n${e.htmlLink}`;
    },
  },
  {
    name: 'calendar_delete_event',
    description: '구글 캘린더 일정을 id로 삭제합니다. 삭제 전 사용자 확인 창이 뜹니다.',
    risky: (i) => `구글 캘린더 일정을 삭제할까요? (id: ${i.id})`,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => {
      await api(`${CAL}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return '삭제했습니다.';
    },
  },
  {
    name: 'google_docs_create',
    description: '구글 문서(Google Docs)를 새로 만들고 내용을 넣습니다. 링크를 돌려줍니다.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: '문서 본문 (일반 텍스트, 줄바꿈 가능)' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    run: async ({ title, content }) => {
      const doc = await api('https://docs.googleapis.com/v1/documents', { method: 'POST', body: { title } });
      if (content) {
        await api(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
          method: 'POST',
          body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
        });
      }
      return `구글 문서를 만들었습니다: https://docs.google.com/document/d/${doc.documentId}/edit`;
    },
  },
];

module.exports = { tools, connect, disconnect, isConnected, buildRawEmail, extractText };
