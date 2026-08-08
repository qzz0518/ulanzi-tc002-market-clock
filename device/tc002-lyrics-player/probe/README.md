# Sideload probe bundle

`player` 是一个纯 shell 探针入口，用来在没有 FlyThings 编译产物之前，就在真机上
验证整条非持久化会话链路：ADB 逐文件推送 → `ctl.stop zkswe` 暂停官方
界面 → 后台运行 → 结束会话 / 断电自动恢复。同时它会把设备侧关键事实（音频
设备、可用命令、进程表、分区目录）写入 `/tmp/tc002-music/probe.log`，为
FlyThings 播放器移植收集情报。

放入发布位（在仓库根目录执行；`music-release` 只接受目录，不接受压缩包）：

```bash
bun run music-release -- device/tc002-lyrics-player/probe 0.0.1-probe player
```

之后打开音乐页 → 设备与固件 → 检测 TC002 → 勾选确认 → 侧载固件。注意：面板的
会话存活检测以 `/tmp/EasyUI.cfg` 是否存在为准，纯 shell 探针不部署它，因此网页会
显示「未在运行」——以探针日志为准。会话运行时读取探针日志：

```bash
adb connect <TC002_IP>:5555
adb -s <TC002_IP>:5555 shell cat /tmp/tc002-music/probe.log
```

预期现象：会话开始后官方界面暂停（LED 可能定格或熄灭——这正是要采集的事实
之一）；点击「恢复官方固件」或断电重启后官方固件完整回归。探针不发声、不写 flash。
当前 `release/bundle/` 默认是音乐固件；要跑探针，用「发布产物」命令把本目录重新
打包即可。
