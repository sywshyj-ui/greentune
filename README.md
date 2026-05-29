# 🎵 GreenTune

一个现代化的桌面音乐播放器，采用 Spotify 绿色风格 UI，基于 Electron 构建。

![style](https://img.shields.io/badge/UI-Spotify%20Green-1db954) ![electron](https://img.shields.io/badge/Electron-35-47848f) ![license](https://img.shields.io/badge/license-MIT-green)

## ✨ 功能

### 本地播放
- 支持 MP3 / WAV / FLAC / AAC / OGG / M4A / WMA
- 导入单个/多个文件，或递归扫描整个文件夹
- 读取 ID3 标签与内嵌封面（标题、艺术家、专辑、年份、流派）
- 播放 / 暂停 / 上一首 / 下一首 / 进度拖拽 / 音量调节 / 静音
- 四种播放模式：顺序、随机、单曲循环、列表循环

### 歌词
- 自动加载同名 `.lrc` 文件
- GBK / UTF-8 编码自动识别
- 与播放进度同步，逐行高亮并自动滚动

### 资料库
- 搜索：标题 / 艺术家 / 专辑 / 流派
- 我喜欢、最近播放、自建歌单
- 所有状态本地持久化

### 界面
- Spotify 绿色风格深色主题（主色 `#1db954`），可切换浅色
- 无边框窗口 + 自定义标题栏
- 可收起的歌词面板

## 🚀 运行

```bash
npm install
npm start
```

## ⌨️ 快捷键

| 按键 | 功能 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 快退 / 快进 5 秒 |
| `↑` / `↓` | 音量增减 |
| `Ctrl + F` | 搜索 |

## 📁 添加音乐

- **左键**点击「添加音乐」→ 选择文件
- **右键**点击「添加音乐」→ 选择文件夹（递归扫描）

## 🛠 技术栈

- Electron 35
- 原生 HTML / CSS / JavaScript
- [jsmediatags](https://github.com/aadsm/jsmediatags) — ID3 元数据
- [iconv-lite](https://github.com/ashtuchkin/iconv-lite) — GBK 歌词解码

## 📄 License

MIT
