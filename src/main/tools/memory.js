// 장기 기억: 사용자에 대한 사실, 선호, 메모를 저장하고 찾습니다.
const store = require('../store');

function all() {
  return store.read('memories', []);
}

function save(list) {
  store.write('memories', list);
}

function addMemory(text, category = '일반') {
  const list = all();
  const item = {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: String(text).trim(),
    category,
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  save(list);
  return item;
}

function searchMemories(query = '', limit = 20) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = all()
    .map((m) => {
      const hay = `${m.text} ${m.category}`.toLowerCase();
      const score = words.length === 0 ? 1 : words.filter((w) => hay.includes(w)).length;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt));
  return scored.slice(0, limit).map((x) => x.m);
}

function deleteMemory(id) {
  const list = all();
  const next = list.filter((m) => m.id !== id);
  save(next);
  return list.length !== next.length;
}

// 시스템 프롬프트에 넣을 최근 기억 요약
function memoryDigest(limit = 40) {
  const list = all().slice(-limit);
  if (list.length === 0) return '(아직 저장된 기억이 없습니다)';
  return list.map((m) => `- [${m.category}] ${m.text} (id:${m.id})`).join('\n');
}

const tools = [
  {
    name: 'remember',
    description:
      '사용자에 대해 오래 기억할 정보(이름, 가족, 선호, 주소, 습관, 중요한 사실, 메모)를 저장합니다. 사용자가 "기억해", "메모해"라고 하거나 다음에도 쓸 만한 정보를 말하면 사용하세요.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '기억할 내용 한 문장' },
        category: { type: 'string', description: '분류 (예: 개인정보, 선호, 업무, 가족, 메모)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async ({ text, category }) => {
      const m = addMemory(text, category || '일반');
      return `저장했습니다 (id: ${m.id})`;
    },
  },
  {
    name: 'recall',
    description: '저장된 기억과 메모를 검색합니다. 검색어를 비우면 최근 기억을 보여줍니다.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '찾을 단어들' },
      },
      additionalProperties: false,
    },
    run: async ({ query }) => {
      const found = searchMemories(query || '');
      if (found.length === 0) return '일치하는 기억이 없습니다.';
      return found.map((m) => `- ${m.text} [${m.category}] (id:${m.id}, ${m.createdAt.slice(0, 10)})`).join('\n');
    },
  },
  {
    name: 'forget',
    description: '저장된 기억 하나를 id로 삭제합니다.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => (deleteMemory(id) ? '삭제했습니다.' : '해당 id의 기억이 없습니다.'),
  },
];

module.exports = { tools, addMemory, searchMemories, deleteMemory, memoryDigest };
