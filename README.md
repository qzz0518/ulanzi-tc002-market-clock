# Ulanzi TC002 Pixel Studio

[English](README.en.md) | 简体中文

把 Ulanzi TC002 像素时钟（52×16 LED）变成一个多频道内容工作台：行情、通知、计时器、
像素动画、画板创作、官方社区素材，再加一个完整的音乐歌词播放器。所有内容都在浏览器里
编排，由本机 Bun 服务渲染成像素帧并推送到时钟。

![Ulanzi TC002 多频道内容工作室控制台](docs/images/tc002-control-panel.png)

## 能做什么

**频道 = 时钟上的一个 Custom App**，用 TC002 旋钮直接切换；一个频道里放多项内容时，
自动合成按序播放的轮播。

| 分类 | 内容 |
| --- | --- |
| 市场 | 内置 BTC、黄金、AAPL 等 10 个资产；可免 API key 搜索添加任意数字货币、股票 / ETF、汇率和贵金属 |
| 工具 | 通知板、计时柱 |
| 视觉 | 兰顿蚂蚁、鱼缸、火焰、翻页钟、数字雨时钟、走迷宫、像素宠物、落沙、星空穿梭 |
| 创作 | 52×16 画板（画笔、像素文字、图片像素化）；从素材库导入 Ulanzi 官方社区像素素材（PNG / GIF） |

控制台右上角可直接读写时钟的亮度、音量、时区等常规设置；手机浏览器打开有专门的触控
布局，支持添加到主屏幕。

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio 手机端频道编排界面">
</p>

## 音乐歌词播放器

![音乐工作台：网易云 / Spotify 双音源切换、带封面的曲目列表、播放控制台与 52×16 实时像素预览](docs/images/tc002-music-studio.png)

顶部「音乐」是一个完整的音乐工作台：**网易云音乐**与 **Spotify** 两个音源随时切换，
搜索、歌单、专辑封面、逐行歌词（含翻译）和 52×16 像素歌词实时预览是共用的，四种显示
形式 × 四套配色随意组合。

- **网易云**：扫码登录，TC002 自己下载音频并用扬声器播放。
- **Spotify**：走官方 Spotify Connect——播放发生在你选中的设备（手机、桌面客户端、
  音箱）上，工作台和时钟都是遥控器加歌词屏；在手机上换一首歌，两秒内自动跟随。需要
  你在开发者后台自建一个免费应用，步骤见[技术参考](docs/reference.md#音乐)。

歌词上屏有两条路径：

- **设备同屏**：不刷机，把歌词帧推到官方固件显示，声音由浏览器播放。
- **原生音乐固件**：网页一键侧载仓库自带的 C++ 播放器——真机扬声器出声、歌词直驱
  LED、与网页双向实时同步。侧载只进设备内存，断电或一键恢复即回到官方固件，flash
  从不被写入。

<p align="center">
  <img src="docs/images/tc002-music-firmware-preview.png" width="720" alt="52×16 像素歌词屏——预览与音乐固件使用同一套渲染算法">
</p>

## 快速安装

需要 [Bun](https://bun.sh)（`mise.toml` 已固定 1.3.14，用 mise 则 `mise install` 即可）：

```bash
bun install
CLOCK_HOST=TC002_IP bun start        # TC002_IP 换成时钟的局域网 IP 或主机名
```

然后打开 `http://127.0.0.1:43820/`。安装为常驻服务（二选一）：

```bash
bash scripts/install.sh --host TC002_IP          # macOS LaunchAgent
bash scripts/install-docker.sh --host TC002_IP   # Docker Compose
```

## 更多文档

- [技术参考](docs/reference.md)：环境变量、市场数据来源、素材库与音乐细节、架构与本地 API
- [音乐固件](device/tc002-lyrics-player/README.md)：固件源码、协议、构建与侧载安全
- [ADR](docs/adr/)：关键架构决策

## 许可

本项目因迁移和修改 GPL‑3.0 的 PixDeck 内容而采用 **GPL‑3.0-only**。分发源码或二进制前请
阅读 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
