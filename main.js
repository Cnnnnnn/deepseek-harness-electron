const { app, BrowserWindow, dialog, ipcMain, shell, clipboard } = require('electron');
const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOST = '127.0.0.1';
const BASE_PORT = 3080;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_MIRROR = 'https://registry.npmmirror.com';
// 固定已验证的 dsh 版本，避免上游发破坏性新版本
const DSH_PKG = '@deepseek-ai/dsh@0.1.0-rc.7';
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟
const isWin = process.platform === 'win32';

// ---------- 手动安装命令（一键安装失败时的兜底） ----------

const MANUAL_INSTALL_UNIX = [
  'export NVM_DIR="$HOME/.nvm"',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
  'nvm install 22',
  'nvm use 22',
  'mkdir -p "$HOME/.local/npm-cache"',
  'export npm_config_cache="$HOME/.local/npm-cache"',
  'npm i -g ' + DSH_PKG + ' --registry=' + NPM_REGISTRY,
].join('\n');

const MANUAL_INSTALL_WIN = [
  '$ErrorActionPreference = "Continue"',
  'node -v',
  'if (-not $?) {',
  '  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements',
  '  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")',
  '}',
  'node -v',
  'if (-not $?) { Write-Host "错误：无法安装 Node，请手动安装 Node 22"; exit 1 }',
  'New-Item -ItemType Directory -Force -Path "$HOME/.local/npm-cache" | Out-Null',
  '$env:npm_config_cache = "$HOME/.local/npm-cache"',
  'npm i -g ' + DSH_PKG + ' --registry=' + NPM_REGISTRY,
].join('\n');

function manualInstallCmd() {
  return isWin ? MANUAL_INSTALL_WIN : MANUAL_INSTALL_UNIX;
}

let dshProc = null;
let installProc = null;
let mainWindow = null;
let precheckWin = null;
let installing = false;
let activePort = BASE_PORT;
let logStream = null;
let quitting = false;
let dshRestarts = 0;
let dshRestartResetAt = 0;

// ============ 日志（落盘到系统日志目录 install.log） ============

function logToFile(line) {
  try {
    if (!logStream) {
      const dir = app.getPath('logs');
      fs.mkdirSync(dir, { recursive: true });
      logStream = fs.createWriteStream(path.join(dir, 'install.log'), { flags: 'a' });
    }
    logStream.write(line + '\n');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function logLine(text) {
  logToFile(text);
  console.log(text);
}

// ============ 通用工具 ============

function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function waitForPort(host, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      const socket = net.connect({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(poll, 300);
      });
    };
    poll();
  });
}

// 从 startPort 起找一个空闲端口（不再复用 3080 上可能存在的陌生进程）
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > startPort + 1000) { resolve(startPort); return; }
      const socket = net.connect({ host: HOST, port: p });
      socket.once('connect', () => { socket.destroy(); tryPort(p + 1); });
      socket.once('error', () => resolve(p));
    };
    tryPort(startPort);
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, env: opts.env || process.env }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function parseVersion(v) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// dsh 要求 Node >= 20.19 或 >= 22.12
function nodeMeetsRequirement(v) {
  const p = parseVersion(v);
  if (!p) return false;
  if (p.major === 20) return p.minor >= 19;
  if (p.major === 22) return p.minor >= 12;
  return p.major > 22;
}

// 按 semver 数值比较，避免字符串排序把 v9.x 排在 v22.x 前面
function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;  // 无法解析的放最后
  if (!pb) return -1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

// ============ 环境检测 ============

// 通过 shell 解析 PATH（含 nvm），拿到真正的 dsh 路径，覆盖 volta/fnm/asdf 等
function findDshViaShell() {
  return new Promise((resolve) => {
    let cmd = '/bin/bash';
    let args = ['-lc', 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; command -v dsh'];
    if (isWin) {
      cmd = 'cmd.exe';
      args = ['/c', 'where dsh'];
    }
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve(err || lines.length === 0 ? null : lines[lines.length - 1]);
    });
  });
}

function findDshCandidates() {
  const home = os.homedir();
  const candidates = [];

  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      versions.sort(compareVersion).reverse();
      for (const v of versions) {
        const p = path.join(nvmDir, v, 'bin', 'dsh');
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch (e) { /* ignore */ }
  }

  const extra = [
    '/opt/homebrew/bin/dsh',
    '/opt/homebrew/opt/node@22/bin/dsh',
    '/usr/local/bin/dsh',
    '/usr/local/opt/node@22/bin/dsh',
    path.join(home, 'Library/pnpm/dsh'),
    path.join(home, '.local', 'bin', 'dsh'),
    path.join(home, '.volta', 'bin', 'dsh'),
  ];
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    extra.push(
      path.join(appData, 'npm', 'dsh.cmd'),
      path.join(appData, 'npm', 'dsh'),
      path.join(home, '.local', 'dsh.cmd'),
      path.join(home, '.local', 'bin', 'dsh.cmd'),
    );
  }
  for (const p of extra) {
    if (fs.existsSync(p)) candidates.push(p);
  }

  return candidates;
}

// 运行 dsh --version（Windows 上是 .cmd shim，需经 cmd.exe）
function runDshVersion(dshPath) {
  const envPath = isWin
    ? path.dirname(dshPath) + ';' + process.env.PATH
    : path.dirname(dshPath) + ':' + process.env.PATH;
  const env = { ...process.env, PATH: envPath };
  if (isWin) {
    return run('cmd.exe', ['/c', 'dsh --version'], { env });
  }
  return run(dshPath, ['--version'], { env });
}

async function detectEnvironment() {
  const problems = [];
  let dshPath = null;
  let version = null;

  const seen = new Set();
  const candidates = [];
  const addCandidate = (p) => {
    if (p && !seen.has(p)) { seen.add(p); candidates.push(p); }
  };
  addCandidate(await findDshViaShell());
  for (const p of findDshCandidates()) addCandidate(p);

  if (candidates.length === 0) {
    problems.push({
      type: 'dsh-missing',
      title: '未检测到 DeepSeek Harness (dsh)',
      detail: '需要 Node ≥ 22.12 以及 ' + DSH_PKG,
    });
    return { ok: false, problems, dshPath, version, installCmd: manualInstallCmd() };
  }

  for (const c of candidates) {
    const r = await runDshVersion(c);
    if (r.code === 0 && r.stdout.trim()) {
      dshPath = c;
      version = r.stdout.trim();
      break;
    }
  }

  if (!dshPath) {
    let nodeVer = '未知';
    let why = '通常是 Node 版本过低（dsh 需要 Node ≥ 20.19 / 22.12）。';
    try {
      const nodeCmd = isWin ? ['cmd.exe', ['/c', 'node -v']] : ['/bin/bash', ['-lc', 'node -v']];
      const nr = await run(nodeCmd[0], nodeCmd[1], { timeout: 5000 });
      nodeVer = nr.stdout.trim() || '未知';
      if (nodeMeetsRequirement(nodeVer)) {
        why = '当前 Node ' + nodeVer + ' 满足要求，可能是 dsh 安装损坏，建议重装。';
      } else {
        why = '当前 Node ' + nodeVer + ' 过低（dsh 需要 Node ≥ 20.19 / 22.12）。';
      }
    } catch (e) { /* ignore */ }
    problems.push({
      type: 'node-incompatible',
      title: 'dsh 已安装但无法运行',
      detail: why + ' 建议安装 Node 22。',
    });
  }

  return { ok: problems.length === 0, problems, dshPath, version, installCmd: manualInstallCmd() };
}

// ============ 一键安装 ============

function buildUnixInstallScript() {
  const L = [
    'set +e',
    'export NVM_DIR="$HOME/.nvm"',
    'export REG="' + NPM_REGISTRY + '"',
    'export MIRROR="' + NPM_MIRROR + '"',
    'export DSH_PKG="' + DSH_PKG + '"',
    'log() { echo "[install] $*"; }',
    'stage() { echo "[install:stage] $1"; }',
    '',
    'stage node',
    '# 1. 确保 Node 22',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then',
    '  . "$NVM_DIR/nvm.sh"',
    '  log "检测到 nvm，安装/使用 Node 22 ..."',
    '  nvm install 22',
    '  nvm use 22',
    'elif command -v brew >/dev/null 2>&1; then',
    '  log "未检测到 nvm，使用 Homebrew 安装 node@22 ..."',
    '  brew install node@22',
    '  export PATH="$(brew --prefix node@22)/bin:$PATH"',
    'else',
    '  log "错误：未检测到 nvm 或 Homebrew，无法自动安装 Node 22"',
    '  exit 1',
    'fi',
    '',
    'stage install',
    '# 2. 安装 dsh（独立缓存规避权限问题 + 镜像 fallback）',
    'log "安装 $DSH_PKG ..."',
    '',
    'mkdir -p "$HOME/.local/npm-cache" "$HOME/.local"',
    'export npm_config_cache="$HOME/.local/npm-cache"',
    '',
    'if [ -d "$HOME/.npm" ] && [ ! -w "$HOME/.npm" ]; then',
    '  log "检测到 ~/.npm 权限受限，尝试 sudo chown 修复..."',
    '  sudo -n chown -R "$(whoami)" "$HOME/.npm" 2>/dev/null && log "sudo chown 成功" || log "sudo 跳过，已使用独立缓存继续安装"',
    'fi',
    '',
    'if npm i -g "$DSH_PKG" --registry="$REG" 2>/dev/null; then',
    '  log "官方 registry 安装成功"',
    'elif npm i -g "$DSH_PKG" --registry="$MIRROR" 2>/dev/null; then',
    '  log "npmmirror 镜像安装成功"',
    'else',
    '  log "全局安装失败，fallback 到 --prefix=$HOME/.local（npmmirror）"',
    '  npm i -g --prefix="$HOME/.local" "$DSH_PKG" --registry="$MIRROR"',
    'fi',
    '',
    'stage verify',
    '# 3. 验证',
    'log "验证安装 ..."',
    'export PATH="$HOME/.local/bin:$PATH"',
    'if command -v dsh >/dev/null 2>&1; then',
    '  dsh --version',
    'else',
    '  log "dsh 仍不在 PATH，请复制上方命令在终端中手动安装"',
    '  exit 1',
    'fi',
  ];
  return L.join('\n');
}

function buildWindowsInstallScript() {
  const L = [
    '$ErrorActionPreference = "Continue"',
    'function Log($m) { Write-Host "[install] $m" }',
    'function Stage($s) { Write-Host "[install:stage] $s" }',
    '',
    'Stage node',
    'Log "检查 Node ..."',
    'node -v',
    'if (-not $?) {',
    '  Log "未检测到 Node，尝试 winget 安装 Node LTS ..."',
    '  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements',
    '  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")',
    '}',
    'node -v',
    'if (-not $?) { Log "错误：无法安装 Node，请手动安装 Node 22"; exit 1 }',
    '',
    'Stage install',
    'Log "安装 ' + DSH_PKG + ' ..."',
    'New-Item -ItemType Directory -Force -Path "$HOME/.local/npm-cache" | Out-Null',
    'New-Item -ItemType Directory -Force -Path "$HOME/.local" | Out-Null',
    '$env:npm_config_cache = "$HOME/.local/npm-cache"',
    '',
    'if (npm i -g "' + DSH_PKG + '" --registry="' + NPM_REGISTRY + '") {',
    '  Log "官方 registry 安装成功"',
    '} elseif (npm i -g "' + DSH_PKG + '" --registry="' + NPM_MIRROR + '") {',
    '  Log "npmmirror 镜像安装成功"',
    '} else {',
    '  Log "全局安装失败，fallback 到 --prefix=$HOME/.local"',
    '  npm i -g --prefix="$HOME/.local" "' + DSH_PKG + '" --registry="' + NPM_MIRROR + '"',
    '}',
    '',
    'Stage verify',
    'Log "验证安装 ..."',
    '$env:Path = "$HOME/.local;$HOME/.local/bin;" + $env:Path',
    'if (Get-Command dsh -ErrorAction SilentlyContinue) { dsh --version } else { Log "dsh 仍不在 PATH，请复制上方命令手动安装"; exit 1 }',
  ];
  return L.join('\n');
}

function buildInstallScript() {
  return isWin ? buildWindowsInstallScript() : buildUnixInstallScript();
}

// 终止整个安装进程组（shell + npm 子进程），避免残留孤儿进程
function killInstallProc() {
  if (!installProc) return;
  try {
    process.kill(-installProc.pid, 'SIGKILL'); // 负 pid = 整个进程组
  } catch (e) {
    try { installProc.kill('SIGKILL'); } catch (e2) { /* ignore */ }
  }
  installProc = null;
}

function installDsh({ onLog, onDone }) {
  const script = buildInstallScript();
  const isWinScript = isWin;
  const child = isWinScript
    ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        env: { ...process.env, HOME: os.homedir() },
        detached: true,
      })
    : spawn('/bin/bash', ['-c', script], {
        env: { ...process.env, HOME: os.homedir() },
        detached: true, // 独立进程组，便于整体终止
      });
  installProc = child;
  logLine('[install] 开始自动安装');

  const emit = (buf) => {
    const text = buf.toString();
    if (text) {
      logToFile(text);
      onLog(text);
    }
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);

  let settled = false;
  const finish = (success) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    installProc = null;
    onDone(success);
  };

  // 安装超时兜底，避免网络挂起时永久卡住
  const timer = setTimeout(() => {
    logLine('[install] 安装超时，终止进程');
    killInstallProc();
    finish(false);
  }, INSTALL_TIMEOUT_MS);

  child.on('close', (code) => { finish(code === 0); });
  child.on('error', (err) => { logLine('[install] 安装进程错误: ' + err.message); finish(false); });
}

// ============ 启动流程 ============

async function ensureDshRunning(dshPath) {
  // 始终启动自己的 dsh 实例；带启动重试 + 运行中崩溃自动重启
  await launchDsh(dshPath, 3);
}

function spawnDsh(dshPath, port) {
  const envPath = isWin
    ? path.dirname(dshPath) + ';' + process.env.PATH
    : path.dirname(dshPath) + ':' + process.env.PATH;
  const env = { ...process.env, PATH: envPath };
  const args = ['web', '--host', HOST, '--port', String(port)];
  // Windows 上 dsh 是 .cmd shim，需要 shell 解析
  return spawn(isWin ? 'dsh' : dshPath, args, { env, stdio: 'ignore', shell: isWin });
}

async function launchDsh(dshPath, attempts, fixedPort) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    // 崩溃重启时复用原端口（fixedPort），窗口无需刷新；首次启动则探测空闲端口
    const port = fixedPort || (await findFreePort(BASE_PORT));
    activePort = port;
    if (dshProc) {
      try { dshProc.kill(); } catch (e) { /* ignore */ }
      dshProc = null;
    }
    dshProc = spawnDsh(dshPath, port);
    const ok = await waitForPort(HOST, port);
    if (ok) {
      dshProc.on('exit', (code, signal) => onDshExit(code, signal, dshPath));
      return;
    }
    lastErr = new Error('dsh web 启动超时（第 ' + i + '/' + attempts + ' 次尝试）');
    try { dshProc.kill(); } catch (e) { /* ignore */ }
    dshProc = null;
  }
  throw lastErr;
}

function onDshExit(code, signal, dshPath) {
  dshProc = null;
  if (quitting) return;
  logLine('[dsh] web 进程退出（code=' + code + ' signal=' + signal + '），准备自动重启');
  // 连续崩溃保护：60 秒内最多自动重启 3 次，避免死循环
  const now = Date.now();
  if (now > dshRestartResetAt) { dshRestarts = 0; dshRestartResetAt = now + 60000; }
  if (++dshRestarts > 3) {
    logLine('[dsh] 连续崩溃过多，已停止自动重启，请手动重启应用');
    return;
  }
  launchDsh(dshPath, 1, activePort).catch((err) => {
    logLine('[dsh] 自动重启失败: ' + err.message);
  });
}

function isHttpUrl(u) {
  return u.startsWith('http://') || u.startsWith('https://');
}

function hardenWindow(win, port) {
  // 阻断弹窗，外部 http(s) 链接交给系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 只允许停留在本机 dsh 页面，阻止导航到其它站点
  win.webContents.on('will-navigate', (e, url) => {
    let allowed = false;
    try {
      const u = new URL(url);
      allowed = u.hostname === HOST && u.port === String(port);
    } catch (err) { /* ignore */ }
    if (!allowed) {
      e.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
    }
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'DeepSeek Harness',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  hardenWindow(mainWindow, port);
  const url = 'http://' + HOST + ':' + port;
  mainWindow.loadURL(url).then(() => {
    console.log('[dsh] 已加载', url);
  }).catch((err) => {
    console.error('[dsh] 加载失败:', err.message);
  });
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error('[dsh] did-fail-load:', code, desc);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startApp(result) {
  try {
    await ensureDshRunning(result.dshPath);
  } catch (err) {
    dialog.showErrorBox(
      'DeepSeek Harness',
      '启动失败：' + err.message + '\n请确认 ' + DSH_PKG + ' 可用。'
    );
    app.quit();
    return;
  }
  createWindow(activePort);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) createWindow(activePort);
  });
}

// ============ 预检窗口 ============

function showPrecheckWindow(result) {
  console.log('[dsh] 环境未就绪，打开预检窗口');
  precheckWin = new BrowserWindow({
    width: 680,
    height: 560,
    title: 'DeepSeek Harness 环境检查',
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  precheckWin.setMenuBarVisibility(false);
  precheckWin.loadFile(path.join(__dirname, 'precheck.html'));
  precheckWin.webContents.on('did-finish-load', () => {
    precheckWin.webContents.send('precheck:result', result);
  });
  precheckWin.on('closed', () => {
    precheckWin = null;
    if (mainWindow === null) app.quit();
  });
}

// ============ IPC ============

ipcMain.handle('precheck:copy', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.on('precheck:install', async () => {
  if (installing) return;
  installing = true;
  installDsh({
    onLog: (text) => precheckWin?.webContents.send('precheck:log', text),
    onDone: async (success) => {
      installing = false;
      if (success) {
        const result = await detectEnvironment();
        if (result.ok) {
          precheckWin?.webContents.send('precheck:done', { success: true, version: result.version });
          setTimeout(() => {
            precheckWin?.close();
            startApp(result);
          }, 600);
        } else {
          precheckWin?.webContents.send('precheck:done', {
            success: false,
            message: '安装命令已执行，但检测仍不通过，请查看日志或使用下方命令手动安装。',
          });
        }
      } else {
        precheckWin?.webContents.send('precheck:done', {
          success: false,
          message: '自动安装失败，请使用下方命令在终端中手动安装。',
        });
      }
    },
  });
});

ipcMain.on('precheck:cancel', () => {
  // 取消前先终止可能仍在运行的安装进程组，避免残留孤儿进程
  killInstallProc();
  app.quit();
});

// ============ 应用生命周期 ============

// 单实例锁：第二个实例启动时聚焦已有窗口
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (precheckWin) {
      precheckWin.focus();
    }
  });

  app.whenReady().then(async () => {
    const result = await detectEnvironment();
    if (result.ok) {
      await startApp(result);
    } else {
      showPrecheckWindow(result);
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  quitting = true;
  killInstallProc();
  if (dshProc) {
    try { dshProc.kill(); } catch (e) { /* ignore */ }
    dshProc = null;
  }
  if (logStream) {
    try { logStream.end(); } catch (e) { /* ignore */ }
    logStream = null;
  }
});
