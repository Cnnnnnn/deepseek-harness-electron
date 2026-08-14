# DeepSeek Harness（Electron 封装）

[DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的桌面封装，用 Electron 打包，双击即可启动本地 dsh Web 界面（默认 http://127.0.0.1:3080）。

## 功能

- 首次启动自动检测环境（Node ≥ 22.12 + @deepseek-ai/dsh），缺失时弹窗提供「一键安装」
- 一键安装内置：npm 缓存重定向（规避 root 缓存 EACCES）、官方 registry → npmmirror 镜像降级、固定 dsh 版本
- 单实例锁、空闲端口探测、安装超时 + 进程组清理、日志落盘、导航/弹窗限制
- 跨平台：macOS（bash）与 Windows（PowerShell）各自安装脚本

## 开发

```bash
npm install
npm start            # 本地运行
npm test             # smoke test
npm run dist         # 打包 macOS universal
npm run dist:x64     # 打包 macOS Intel
npm run dist:win     # 打包 Windows NSIS
```

## 下载

- **macOS**（Intel + Apple Silicon 通用）：[DeepSeek.Harness-universal-mac.zip](https://github.com/Cnnnnnn/deepseek-harness-electron/releases/latest/download/DeepSeek.Harness-universal-mac.zip)
- **Windows**：[DeepSeek.Harness-Setup-x64.exe](https://github.com/Cnnnnnn/deepseek-harness-electron/releases/latest/download/DeepSeek.Harness-Setup-x64.exe)

历史版本见 [Releases](https://github.com/Cnnnnnn/deepseek-harness-electron/releases)。
