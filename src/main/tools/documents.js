// 문서 만들기: Word(.docx), 마크다운(.md), 텍스트(.txt) 파일을 내 컴퓨터에 저장합니다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const docx = require('docx');
const store = require('../store');

function docsDir() {
  const dir = store.getSettings().documentsDir || path.join(os.homedir(), 'Documents', 'Jarvis');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return String(name || '문서').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '문서';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}

// "# 제목", "## 소제목", "- 항목", "**굵게**" 정도의 간단한 마크다운을 Word 문단으로 바꿉니다.
function inlineRuns(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => (p.startsWith('**') && p.endsWith('**') ? new docx.TextRun({ text: p.slice(2, -2), bold: true }) : new docx.TextRun(p)));
}

function markdownToParagraphs(md) {
  const H = docx.HeadingLevel;
  return String(md)
    .split(/\r?\n/)
    .map((line) => {
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const level = [H.HEADING_1, H.HEADING_2, H.HEADING_3][m[1].length - 1];
        return new docx.Paragraph({ heading: level, children: inlineRuns(m[2]) });
      }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) return new docx.Paragraph({ bullet: { level: 0 }, children: inlineRuns(m[1]) });
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) return new docx.Paragraph({ numbering: { reference: 'num', level: 0 }, children: inlineRuns(m[1]) });
      return new docx.Paragraph({ children: inlineRuns(line) });
    });
}

async function createDocx(title, content, filePath) {
  const doc = new docx.Document({
    creator: 'JARVIS',
    title,
    styles: { default: { document: { run: { font: '맑은 고딕', size: 22 } } } },
    numbering: {
      config: [{ reference: 'num', levels: [{ level: 0, format: docx.LevelFormat.DECIMAL, text: '%1.', alignment: docx.AlignmentType.START }] }],
    },
    sections: [{ children: [new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, children: [new docx.TextRun(title)] }), ...markdownToParagraphs(content)] }],
  });
  fs.writeFileSync(filePath, await docx.Packer.toBuffer(doc));
}

function makeTools(electron) {
  return [
    {
      name: 'create_document',
      description:
        '보고서, 편지, 회의록, 견적서, 계획서 같은 문서를 내 컴퓨터에 파일로 만듭니다. format은 docx(워드, 기본), md, txt 중 하나입니다. content에는 "# 제목", "- 항목", "1. 번호", "**굵게**" 마크다운을 쓸 수 있습니다. 만든 뒤 바로 열어 줍니다.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          format: { type: 'string', enum: ['docx', 'md', 'txt'] },
          open_after: { type: 'boolean', description: '만든 뒤 열지 여부 (기본 true)' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      run: async ({ title, content, format = 'docx', open_after = true }) => {
        const p = uniquePath(docsDir(), safeName(title), format);
        if (format === 'docx') await createDocx(title, content, p);
        else fs.writeFileSync(p, format === 'md' ? `# ${title}\n\n${content}\n` : `${title}\n\n${content}\n`, 'utf8');
        if (open_after && electron?.shell) await electron.shell.openPath(p);
        return `문서를 저장했습니다: ${p}`;
      },
    },
    {
      name: 'list_documents',
      description: '자비스가 만든 문서 폴더의 파일 목록을 봅니다.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const dir = docsDir();
        const files = fs
          .readdirSync(dir)
          .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtime }))
          .sort((a, b) => b.t - a.t)
          .slice(0, 50);
        if (!files.length) return `(${dir} 폴더가 비어 있습니다)`;
        return `${dir}\n` + files.map((x) => `- ${x.f} (${x.t.toLocaleString('ko-KR')})`).join('\n');
      },
    },
    {
      name: 'read_text_file',
      description: '텍스트 파일(.txt, .md, .csv, .json 등)의 내용을 읽습니다.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      run: async ({ path: p }) => {
        const full = p.replace(/^~(?=$|[\\/])/, os.homedir());
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) return '파일이 너무 큽니다 (2MB 초과).';
        return fs.readFileSync(full, 'utf8').slice(0, 20000);
      },
    },
  ];
}

module.exports = { makeTools, markdownToParagraphs, createDocx, docsDir };
