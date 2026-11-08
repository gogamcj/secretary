// 카카오 연동
// 1) 공식 카카오 API: 톡캘린더(일정 조회/추가/삭제), "나와의 채팅"으로 메시지 보내기
// 2) PC 카카오톡 앱 조작(비공식): 친구/단톡방에 메시지 보내기
//    - Windows: PowerShell + Win32 창 메시지 (카카오톡 PC 실행·로그인 상태 필요)
//    - Mac: kmsg CLI (brew install channprj/tap/kmsg, 손쉬운 사용 권한 필요)
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('../store');
const { waitForCode, postForm } = require('../oauth');

const REDIRECT_PORT = 5781;
const REDIRECT_PATH = '/oauth/kakao';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const TOKEN_KEY = 'kakao_tokens';

function restKey() {
  return store.getSettings().kakaoRestKey;
}

function isConnected() {
  return !!store.getSecretJSON(TOKEN_KEY)?.refresh_token;
}

async function connect(openBrowser) {
  const clientId = restKey();
  if (!clientId) throw new Error('설정에서 카카오 REST API 키를 먼저 입력해 주세요.');
  const { code } = await waitForCode({
    port: REDIRECT_PORT,
    path: REDIRECT_PATH,
    openBrowser,
    buildAuthUrl: (_redirect, state) => {
      const u = new URL('https://kauth.kakao.com/oauth/authorize');
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'talk_message,talk_calendar',
        state,
      }).toString();
      return u.toString();
    },
  });
  const params = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT_URI, code };
  const secret = store.getSecret('kakao_client_secret');
  if (secret) params.client_secret = secret;
  saveTokens(await postForm('https://kauth.kakao.com/oauth/token', params));
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
    expires_at: Date.now() + (tok.expires_in || 21599) * 1000 - 60000,
  });
}

async function accessToken() {
  const t = store.getSecretJSON(TOKEN_KEY);
  if (!t?.refresh_token) throw new Error('카카오 계정이 연결되지 않았습니다. 설정에서 "카카오 연결"을 눌러 주세요.');
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  const params = { grant_type: 'refresh_token', client_id: restKey(), refresh_token: t.refresh_token };
  const secret = store.getSecret('kakao_client_secret');
  if (secret) params.client_secret = secret;
  saveTokens(await postForm('https://kauth.kakao.com/oauth/token', params));
  return store.getSecretJSON(TOKEN_KEY).access_token;
}

async function kapi(pathname, { method = 'GET', form, query } = {}) {
  const u = new URL(`https://kapi.kakao.com${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const res = await fetch(u, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`카카오 API 오류 (${res.status}): ${data.msg || JSON.stringify(data)}`);
  return data;
}

// 톡캘린더는 시작/끝 시각이 UTC, 5분 단위여야 합니다.
function toKakaoTime(value, roundUp = false) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`시간 형식을 이해하지 못했습니다: ${value}`);
  const step = 5 * 60 * 1000;
  const ms = roundUp ? Math.ceil(d.getTime() / step) * step : Math.floor(d.getTime() / step) * step;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const fmt = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

// ---------- PC 카카오톡 앱 조작 ----------
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:JARVIS_KAKAO))
$p = $payload | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class KW {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$WM_SETTEXT = 0x000C; $WM_KEYDOWN = 0x0100; $WM_KEYUP = 0x0101; $VK_RETURN = [IntPtr]0x0D
function Press-Enter($h) { [KW]::PostMessage($h, $WM_KEYDOWN, $VK_RETURN, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 30; [KW]::PostMessage($h, $WM_KEYUP, $VK_RETURN, [IntPtr]::Zero) | Out-Null }

$room = [KW]::FindWindow($null, $p.room)
if ($room -eq [IntPtr]::Zero) {
  $main = [KW]::FindWindow($null, "카카오톡")
  if ($main -eq [IntPtr]::Zero) { $main = [KW]::FindWindow($null, "KakaoTalk") }
  if ($main -eq [IntPtr]::Zero) { throw "카카오톡 PC 앱이 실행 중이 아닙니다. 카카오톡을 켜고 로그인해 주세요." }
  $child = [KW]::FindWindowEx($main, [IntPtr]::Zero, "EVA_ChildWindow", $null)
  $w1 = [KW]::FindWindowEx($child, [IntPtr]::Zero, "EVA_Window", $null)
  $w2 = [KW]::FindWindowEx($child, $w1, "EVA_Window", $null)
  $search = [KW]::FindWindowEx($w2, [IntPtr]::Zero, "Edit", $null)
  if ($search -eq [IntPtr]::Zero) { throw "카카오톡 채팅 목록의 검색창을 찾지 못했습니다. 카카오톡에서 '채팅' 탭을 열어 두세요." }
  [KW]::SendMessage($search, $WM_SETTEXT, [IntPtr]::Zero, $p.room) | Out-Null
  Start-Sleep -Milliseconds 700
  Press-Enter $search
  for ($i = 0; $i -lt 20 -and $room -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 150; $room = [KW]::FindWindow($null, $p.room) }
  [KW]::SendMessage($search, $WM_SETTEXT, [IntPtr]::Zero, "") | Out-Null
}
if ($room -eq [IntPtr]::Zero) { throw ("채팅방 '" + $p.room + "'을(를) 열지 못했습니다. 채팅방 이름을 정확히 말해 주세요.") }
$edit = [KW]::FindWindowEx($room, [IntPtr]::Zero, "RICHEDIT50W", $null)
if ($edit -eq [IntPtr]::Zero) { throw "채팅방 입력창을 찾지 못했습니다." }
[KW]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $p.message) | Out-Null
Start-Sleep -Milliseconds 150
Press-Enter $edit
Write-Output "OK"
`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.toString().trim());
    });
  });
}

async function sendDesktop(room, message) {
  if (process.platform === 'win32') {
    const file = path.join(os.tmpdir(), 'jarvis-kakao-send.ps1');
    fs.writeFileSync(file, '﻿' + WIN_SCRIPT, 'utf8');
    const env = { ...process.env, JARVIS_KAKAO: Buffer.from(JSON.stringify({ room, message }), 'utf8').toString('base64') };
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { env });
    return `카카오톡 '${room}'에 보냈습니다.`;
  }
  if (process.platform === 'darwin') {
    await run(await kmsgPath(), ['send', room, message]);
    return `카카오톡 '${room}'에 보냈습니다.`;
  }
  throw new Error('이 운영체제에서는 카카오톡 PC 앱 조작을 지원하지 않습니다.');
}

async function kmsgPath() {
  for (const p of ['/opt/homebrew/bin/kmsg', '/usr/local/bin/kmsg']) if (fs.existsSync(p)) return p;
  try {
    return await run('/bin/sh', ['-lc', 'command -v kmsg']);
  } catch {
    throw new Error('Mac에서 카톡을 보내려면 kmsg가 필요합니다. 터미널에서 "brew install channprj/tap/kmsg"를 실행하고 손쉬운 사용 권한을 허용해 주세요.');
  }
}

const tools = [
  {
    name: 'kakao_send_to_friend',
    description:
      '이 컴퓨터의 카카오톡 앱으로 친구나 단톡방에 메시지를 보냅니다. room은 카카오톡 채팅방 이름과 정확히 같아야 합니다 (1:1이면 보통 친구 이름). 카카오톡 PC 앱이 켜져 있고 로그인되어 있어야 합니다. 보내기 전 사용자 확인 창이 뜹니다.',
    risky: (i) => `카카오톡을 보낼까요?\n\n채팅방: ${i.room}\n\n${String(i.message).slice(0, 600)}`,
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '채팅방 이름 (친구 이름 또는 단톡방 이름)' },
        message: { type: 'string' },
      },
      required: ['room', 'message'],
      additionalProperties: false,
    },
    run: async ({ room, message }) => sendDesktop(room, message),
  },
  {
    name: 'kakao_read_chat',
    description: '(Mac 전용) 카카오톡 채팅방의 최근 메시지를 읽습니다. kmsg가 설치되어 있어야 합니다.',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        limit: { type: 'integer', description: '가져올 메시지 수 (기본 20)' },
      },
      required: ['room'],
      additionalProperties: false,
    },
    run: async ({ room, limit }) => {
      if (process.platform !== 'darwin') return '카카오톡 메시지 읽기는 현재 Mac에서만 지원합니다.';
      return (await run(await kmsgPath(), ['read', room, '--limit', String(limit || 20)])).slice(0, 12000);
    },
  },
  {
    name: 'kakao_send_to_me',
    description: '공식 카카오 API로 "나와의 채팅"에 메시지를 보냅니다. 메모, 할 일, 링크를 휴대폰으로 보낼 때 좋습니다.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '보낼 내용 (최대 200자 권장)' },
        link: { type: 'string', description: '함께 보낼 웹 링크 (선택)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async ({ text, link }) => {
      const url = link || 'https://www.kakao.com';
      const template = { object_type: 'text', text: String(text).slice(0, 200), link: { web_url: url, mobile_web_url: url } };
      if (link) template.button_title = '열기';
      await kapi('/v2/api/talk/memo/default/send', { method: 'POST', form: { template_object: JSON.stringify(template) } });
      return '나와의 채팅으로 보냈습니다.';
    },
  },
  {
    name: 'kakao_calendar_list_events',
    description: '카카오 톡캘린더의 일정을 조회합니다. 한 번에 최대 31일 범위입니다.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '시작 ISO 8601' },
        to: { type: 'string', description: '끝 ISO 8601' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run: async ({ from, to }) => {
      const data = await kapi('/v2/api/calendar/events', {
        query: { from: toKakaoTime(from), to: toKakaoTime(to, true), limit: 100 },
      });
      const events = data.events || [];
      if (!events.length) return '해당 기간에 톡캘린더 일정이 없습니다.';
      return events
        .map((e) => `- ${fmt(e.time?.start_at)} ~ ${fmt(e.time?.end_at)}${e.time?.all_day ? ' (종일)' : ''} | ${e.title} (id:${e.id})`)
        .join('\n');
    },
  },
  {
    name: 'kakao_calendar_create_event',
    description: '카카오 톡캘린더에 일정을 추가합니다. 시각은 5분 단위로 맞춰집니다.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: '시작 ISO 8601 (시간대 포함)' },
        end: { type: 'string', description: '끝 ISO 8601 (시간대 포함)' },
        all_day: { type: 'boolean' },
        description: { type: 'string' },
        location: { type: 'string' },
        reminder_minutes: { type: 'integer', description: '몇 분 전에 알림 (5분 단위)' },
      },
      required: ['title', 'start', 'end'],
      additionalProperties: false,
    },
    run: async (i) => {
      const event = {
        title: i.title,
        time: {
          start_at: toKakaoTime(i.start),
          end_at: toKakaoTime(i.end, true),
          time_zone: 'Asia/Seoul',
          all_day: !!i.all_day,
          lunar: false,
        },
      };
      if (i.description) event.description = i.description;
      if (i.location) event.location = { name: i.location };
      if (Number.isInteger(i.reminder_minutes)) event.reminders = [Math.max(5, Math.round(i.reminder_minutes / 5) * 5)];
      const r = await kapi('/v2/api/calendar/create/event', { method: 'POST', form: { event: JSON.stringify(event) } });
      return `톡캘린더에 추가했습니다: ${fmt(event.time.start_at)} ${i.title} (id:${r.event_id})`;
    },
  },
  {
    name: 'kakao_calendar_delete_event',
    description: '카카오 톡캘린더 일정을 id로 삭제합니다. 삭제 전 사용자 확인 창이 뜹니다.',
    risky: (i) => `톡캘린더 일정을 삭제할까요? (id: ${i.id})`,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => {
      await kapi('/v2/api/calendar/delete/event', { method: 'DELETE', query: { event_id: id } });
      return '삭제했습니다.';
    },
  },
];

module.exports = { tools, connect, disconnect, isConnected, toKakaoTime, REDIRECT_URI, WIN_SCRIPT };
