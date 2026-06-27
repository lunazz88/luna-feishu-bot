# Luna Feishu Bot

用于飞书/Lark 日常广告数据文件接收、处理、人工确认和结果回传的双机器人自动化项目。

## 机器人分工

- `robot1`：接收原始广告文件，生成 AI 修正、抓取失败、投手不一致、未匹配结果表。
- `robot2`：接收“更新几月几号数据”命令，汇总人工确认结果并生成最终修正表。

## 策略文档

- [Viklik XMP 晨报机器人策略](docs/VIKLIK_BOT_STRATEGY.md)

## 快速开始

```bash
cp .env.robot1.example .env.robot1
cp .env.robot2.example .env.robot2
chmod +x install_mac.sh start_all_mac.sh start_robot1_mac.sh start_robot2_mac.sh stop_bots_mac.sh
./install_mac.sh
./start_all_mac.sh
```

查看日志：

```bash
tail -f outputs/robot1.out.log outputs/robot1.err.log
tail -f outputs/robot2.out.log outputs/robot2.err.log
```

停止机器人：

```bash
./stop_bots_mac.sh
```

更多 Mac 安装、配置和排查说明见 [README_MAC.md](README_MAC.md)。
