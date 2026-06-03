# MelodyBox - 无损音乐播放器

安卓手机端音乐播放器，支持 FLAC/WAV/APE 无损解码、联网搜索下载歌词、网络歌曲下载、插件扩展。

## 功能

- **无损音频解码** — FLAC、WAV、APE、OGG、MP3、AAC、M4A
- **歌词系统** — 联网搜索 LRC 歌词，逐行滚动同步显示
- **歌曲下载** — 多源搜索下载框架（已内置 Jamendo 免费 API + JSON API 扩展接口）
- **插件系统** — 可注册生命周期钩子、事件总线，支持热插拔
- **播放控制** — 循环模式、随机播放、变速播放、可视化频谱
- **本地文件** — 拖拽或选择本地音频文件，自动解析内嵌封面
- **PWA 支持** — 可安装到安卓桌面，离线使用

## 获取 APK（3 种方式）

### 方式一：GitHub 云端编译（推荐 ⭐ 无需 JDK/Android SDK）

你只需要 Node.js + Git（你电脑上已有），在 GitHub 上云端编译：

1. 在 GitHub 新建一个仓库（不要勾选 README）
2. 双击运行 `setup-github.bat`，输入你的仓库地址
3. 推送后自动触发编译，打开 `https://github.com/你的用户名/仓库名/actions` 查看进度
4. 几分钟后编译完成，在 Actions 页面底部下载 APK

### 方式二：本地编译（需要 JDK 17 + Android SDK）

**Windows：**
```bat
双击运行 build-apk.bat
```

### 方式三：PWA 网页安装（无需任何工具）

1. 用手机 Chrome 打开 `www/index.html`
2. 菜单 → "添加到主屏幕"
3. 桌面出现 MelodyBox 图标，点击即用

## 项目结构

```
music-player/
├── www/                      ← Web 应用源码（VS Code 编辑这里）
│   ├── index.html            ← 主页面
│   ├── css/app.css           ← 暗色主题样式
│   ├── js/app.js             ← 核心引擎（播放/歌词/下载/插件）
│   ├── manifest.json         ← PWA 配置
│   └── sw.js                 ← Service Worker
├── .github/workflows/        ← GitHub Actions 云端编译
│   └── build-apk.yml
├── capacitor.config.json     ← APK 打包配置
├── package.json              ← 项目依赖
├── setup-github.bat          ← 推送到 GitHub（推荐）
├── build-apk.bat             ← 本地一键编译
├── build-apk.sh              ← Mac/Linux 编译
└── README.md
```

## 在 VS Code 中编辑

所有可编辑代码在 `www/` 目录下，用 VS Code 打开 `music-player/` 文件夹即可：

```
code music-player/
```

核心模块说明（`www/js/app.js`）：

| 类 | 功能 |
|---|---|
| `AudioEngine` | Web Audio API 播放引擎，支持 FLAC 等格式 |
| `LyricsEngine` | 歌词搜索（lrclib.net）、LRC 解析、同步显示 |
| `DownloadManager` | 下载队列、多源搜索、进度回调 |
| `PluginSystem` | 插件注册/卸载、生命周期钩子、事件总线 |
| `StorageManager` | IndexedDB 存储曲库、播放列表、设置 |
| `UI` | 界面渲染、频谱可视化、歌词滚动 |
| `AppController` | 主控制器，串联所有模块 |

## 插件开发

插件通过 `App.installPlugin(manifest, setupFn)` 安装：

```js
App.installPlugin({
  id: 'my-plugin',
  name: '我的插件',
  version: '1.0.0',
  description: '自定义功能'
}, async (api, manifest) => {
  // api.registerHook('player:stateChange', (ctx) => { ... });
  // api.getPlaylist()
  // api.showToast('插件已加载')
});
```

可用钩子：`player:beforeLoad`、`player:afterLoad`、`player:stateChange`、`lyrics:beforeSearch`、`download:complete`、`app:init`

## 自定义音乐源

在设置页填写 JSON API 地址，接口需返回格式：

```json
{
  "songs": [{
    "title": "歌曲名",
    "artist": "歌手",
    "duration": 240,
    "cover": "封面图URL",
    "url": "下载URL"
  }]
}
```

## 构建 APK 的详细步骤（手动）

```bash
# 1. 安装依赖
npm install

# 2. 初始化 Android 项目（仅首次）
npx cap add android

# 3. 同步 Web 资源
npx cap sync android

# 4. 编译 APK
cd android && ./gradlew assembleDebug

# APK 在: android/app/build/outputs/apk/debug/app-debug.apk
```

## 技术栈

- Web Audio API（FLAC 解码）
- IndexedDB（本地存储）
- Capacitor（WebView 封装）
- LRC 歌词标准
- PWA Service Worker
