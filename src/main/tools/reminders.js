// 로컬 알림/할 일. 정해진 시간에 데스크톱 알림과 음성으로 알려줍니다.
const store = require('../store');

let timer = null;

function all() {
  return store.read('reminders', []);
}

function save(list) {
  store.write('reminders', list);
}

function addReminder(text, at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error(`시간 형식을 이해하지 못했습니다: ${at}`);
  const list = all();
  const item = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: String(text).trim(),
    at: when.toISOString(),
    done: false,
  };
  list.push(item);
  save(list);
  return item;
}

function listReminders(includeDone = false) {
  return all()
    .filter((r) => includeDone || !r.done)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function deleteReminder(id) {
  const list = all();
  const next = list.filter((r) => r.id !== id);
  save(next);
  return list.length !== next.length;
}

// 만기된 알림을 찾아 done 처리하고 돌려줍니다.
function popDue(now = new Date()) {
  const list = all();
  const due = [];
  for (const r of list) {
    if (!r.done && new Date(r.at) <= now) {
      r.done = true;
      due.push(r);
    }
  }
  if (due.length) save(list);
  return due;
}

function startScheduler(onDue, intervalMs = 20000) {
  stopScheduler();
  const tick = () => {
    try {
      for (const r of popDue()) onDue(r);
    } catch (e) {
      console.error('[reminders]', e);
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

const fmt = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

const tools = [
  {
    name: 'add_reminder',
    description:
      '정해진 시각에 이 컴퓨터에서 알림과 음성으로 알려주는 리마인더/할 일을 추가합니다. 구글 캘린더 일정과 별개이며, "몇 시에 알려줘" 같은 요청에 사용합니다.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '알려줄 내용' },
        at: { type: 'string', description: '알림 시각, 시간대가 포함된 ISO 8601 (예: 2026-11-08T15:00:00+09:00)' },
      },
      required: ['text', 'at'],
      additionalProperties: false,
    },
    run: async ({ text, at }) => {
      const r = addReminder(text, at);
      return `리마인더 추가: ${fmt(r.at)} - ${r.text} (id:${r.id})`;
    },
  },
  {
    name: 'list_reminders',
    description: '남아 있는 리마인더/할 일 목록을 봅니다.',
    input_schema: {
      type: 'object',
      properties: { include_done: { type: 'boolean' } },
      additionalProperties: false,
    },
    run: async ({ include_done }) => {
      const list = listReminders(!!include_done);
      if (!list.length) return '예정된 리마인더가 없습니다.';
      return list.map((r) => `- ${fmt(r.at)} ${r.text}${r.done ? ' (완료)' : ''} (id:${r.id})`).join('\n');
    },
  },
  {
    name: 'delete_reminder',
    description: '리마인더를 id로 삭제합니다.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => (deleteReminder(id) ? '삭제했습니다.' : '해당 id가 없습니다.'),
  },
];

module.exports = { tools, addReminder, listReminders, deleteReminder, popDue, startScheduler, stopScheduler };
