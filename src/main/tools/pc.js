// PC 조작: 앱 실행, 파일·웹 열기, 명령 실행, 클립보드, 시스템 정보
const os = require('os');
const { exec, execFile } = require('child_process');

function sh(command, timeout = 60000) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];
    execFile(shell, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      resolve(err && !out ? `실패: ${err.message}` : out.slice(0, 12000) || '(출력 없음)');
    });
  });
}

function openApp(name) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-a', name], (err) => (err ? reject(new Error(`'${name}' 앱을 찾지 못했습니다.`)) : resolve()));
    } else if (process.platform === 'win32') {
      // 시작 메뉴 바로가기 이름, 실행 파일 이름, 또는 경로 모두 시도
      const ps = `
$n = $env:JARVIS_APP
$lnk = Get-ChildItem -Path "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -like "*$n*" } | Select-Object -First 1
if ($lnk) { Start-Process $lnk.FullName; exit 0 }
$app = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1
if ($app) { Start-Process ("shell:AppsFolder\\" + $app.AppID); exit 0 }
Start-Process $n`;
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, JARVIS_APP: name }, windowsHide: true }, (err) =>
        err ? reject(new Error(`'${name}' 앱을 찾지 못했습니다.`)) : resolve(),
      );
    } else {
      exec(`${name} &`, (err) => (err ? reject(err) : resolve()));
    }
  });
}

function makeTools(electron) {
  const { shell, clipboard } = electron;
  return [
    {
      name: 'open_app',
      description: '이 컴퓨터의 앱을 실행합니다 (예: 카카오톡, 크롬, 메모장, 계산기, Safari, 엑셀). Mac은 앱 이름, Windows는 시작 메뉴 이름으로 찾습니다.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: '앱 이름' } },
        required: ['name'],
        additionalProperties: false,
      },
      run: async ({ name }) => {
        await openApp(name);
        return `'${name}'을(를) 실행했습니다.`;
      },
    },
    {
      name: 'open_target',
      description: '웹 주소(https://...)는 기본 브라우저로, 파일이나 폴더 경로는 기본 앱으로 엽니다.',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string', description: 'URL 또는 파일/폴더 경로' } },
        required: ['target'],
        additionalProperties: false,
      },
      run: async ({ target }) => {
        if (/^(https?|mailto):/i.test(target)) {
          await shell.openExternal(target);
        } else {
          const p = target.replace(/^~(?=$|[\\/])/, os.homedir());
          const err = await shell.openPath(p);
          if (err) throw new Error(err);
        }
        return `열었습니다: ${target}`;
      },
    },
    {
      name: 'run_command',
      description:
        '이 컴퓨터에서 터미널 명령을 실행하고 결과를 돌려줍니다. Windows는 PowerShell, Mac은 zsh입니다. 볼륨 조절, 파일 찾기, 프로그램 상태 확인, 시스템 설정처럼 다른 도구로 안 되는 PC 조작에 사용하세요. 실행 전 사용자 확인 창이 뜹니다.',
      risky: (i) => `이 명령을 실행할까요?\n\n${i.command}${i.reason ? `\n\n이유: ${i.reason}` : ''}`,
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          reason: { type: 'string', description: '이 명령이 무엇을 하는지 한국어로 짧게' },
        },
        required: ['command', 'reason'],
        additionalProperties: false,
      },
      run: async ({ command }) => sh(command),
    },
    {
      name: 'clipboard',
      description: '클립보드를 읽거나(action=read) 텍스트를 복사합니다(action=write).',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'] },
          text: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      run: async ({ action, text }) => {
        if (action === 'write') {
          clipboard.writeText(text || '');
          return '클립보드에 복사했습니다.';
        }
        return clipboard.readText().slice(0, 8000) || '(클립보드가 비어 있습니다)';
      },
    },
    {
      name: 'system_info',
      description: '이 컴퓨터의 운영체제, 배터리 외 기본 정보, 메모리, 현재 시각을 확인합니다.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () =>
        [
          `운영체제: ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()}`,
          `컴퓨터 이름: ${os.hostname()}`,
          `CPU: ${os.cpus()[0]?.model} x ${os.cpus().length}`,
          `메모리: ${(os.freemem() / 2 ** 30).toFixed(1)}GB 남음 / ${(os.totalmem() / 2 ** 30).toFixed(1)}GB`,
          `홈 폴더: ${os.homedir()}`,
          `현재 시각: ${new Date().toLocaleString('ko-KR')}`,
        ].join('\n'),
    },
  ];
}

module.exports = { makeTools, sh };
