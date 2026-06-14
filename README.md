# Luna Feishu Bot

用于飞书/Lark 日常广告数据文件接收、处理和结果回传的自动化机器人。

## 快速开始

```bash
cp .env.example .env
chmod +x install_mac.sh start_bot.sh stop_bot.sh
./install_mac.sh
./start_bot.sh
```

查看日志：

```bash
tail -f outputs/bot.out.log
tail -f outputs/bot.err.log
```

停止机器人：

```bash
./stop_bot.sh
```

更多 Mac 安装、配置和排查说明见 [README_MAC.md](README_MAC.md)。
