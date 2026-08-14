#!/usr/bin/env node
// 打包入口：本地自动走 npmmirror 镜像；CI（GitHub Actions）走官方 GitHub 源
const { spawnSync } = require('child_process');
const path = require('path');

const MIRROR = 'https://npmmirror.com/mirrors/electron/';
// GitHub Actions 会注入 CI=true 与 GITHUB_ACTIONS=true
const isCI = process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;

const env = { ...process.env };
if (isCI) {
  console.log('[build] 检测到 CI 环境，使用官方 electron 下载源');
} else {
  env.ELECTRON_MIRROR = MIRROR;
  console.log('[build] 使用 electron 镜像:', MIRROR);
}

const builder = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const args = process.argv.slice(2);

const r = spawnSync(process.execPath, [builder, ...args], { stdio: 'inherit', env });
if (r.error) {
  console.error('[build] electron-builder 启动失败:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
