// 最小 smoke test：语法检查 + 关键修复标记校验（不依赖 Electron 运行时）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const failures = [];
function check(name, cond) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    console.log('  FAIL ' + name);
    failures.push(name);
  }
}

console.log('[1] 语法检查 main.js');
try {
  execFileSync('node', ['--check', path.join(root, 'main.js')], { stdio: 'pipe' });
  check('main.js 语法正确', true);
} catch (e) {
  check('main.js 语法正确', false);
  console.log(e.stderr ? e.stderr.toString() : e.message);
}

console.log('[2] 关键修复标记');
const mainJs = read('main.js');
const pkg = read('package.json');
const preload = read('preload.js');

const markers = [
  ['npm 缓存重定向', mainJs.includes('npm_config_cache')],
  ['dsh 版本固定', mainJs.includes('@deepseek-ai/dsh@0.1.0-rc.7')],
  ['npmmirror 镜像 fallback', mainJs.includes('registry.npmmirror.com')],
  ['单实例锁', mainJs.includes('requestSingleInstanceLock')],
  ['安装进程跟踪/kill', mainJs.includes('installProc') && mainJs.includes("kill('SIGKILL')")],
  ['安装超时', mainJs.includes('INSTALL_TIMEOUT_MS')],
  ['空闲端口探测', mainJs.includes('findFreePort')],
  ['shell 探测 dsh', mainJs.includes('findDshViaShell')],
  ['Node 版本校验', mainJs.includes('nodeMeetsRequirement')],
  ['导航/弹窗限制', mainJs.includes('setWindowOpenHandler') && mainJs.includes('will-navigate')],
  ['preload contextBridge', preload.includes('contextBridge')],
  ['预检窗口关闭 nodeIntegration', mainJs.includes('nodeIntegration: false')],
  ['ad-hoc 签名', pkg.includes('"identity": "-"')],
  ['日志落盘', mainJs.includes("app.getPath('logs')")],
];
for (const [name, ok] of markers) check(name, ok);

console.log('');
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项：' + failures.join(', '));
  process.exit(1);
}
console.log('smoke test 通过');
