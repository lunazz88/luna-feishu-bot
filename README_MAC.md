# Lark 数据修正机器人 Mac 迁移说明

这个包用于把当前 Windows 上的 Lark 数据修正机器人迁移到 Mac。

共享项目只包含 `.env.example` 配置模板。本地运行前需要复制生成 `.env` 并填写配置。

## 1. 解压

把整个 `luna-feishu-bot-mac` 文件夹放到 Mac 上，例如：

```bash
~/luna-feishu-bot-mac
```

进入目录：

```bash
cd ~/luna-feishu-bot-mac
```

## 2. 安装依赖

Mac 需要先有 Node.js 和 Python 3。推荐用 Homebrew：

```bash
brew install node python
```

然后运行：

```bash
chmod +x install_mac.sh start_bot.sh stop_bot.sh
./install_mac.sh
```

安装脚本会做这些事：

- 安装 Node 依赖
- 创建 Python 虚拟环境 `.venv`
- 安装 `openpyxl`
- 检查机器人配置

## 3. 启动机器人

```bash
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

## 4. 飞书/Lark 后台保持一致

这个机器人使用长连接接收事件。Mac 上启动后，不需要配置公网地址。

应用后台需要保持：

- 机器人能力已启用
- 事件订阅使用长连接
- 已订阅 `im.message.receive_v1`
- 机器人已被拉进接收原始广告文件的群
- 权限已包含消息、文件下载、云文档、多维表格读写、复制云文档、管理文档权限

## 5. 当前业务配置

`.env.example` 里包含当前运行所需的配置字段模板。`.env` 仅保存在本机，不随项目共享。

如果正式企业换应用，需要修改：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_TENANT_DOMAIN`
- `FEISHU_RESULT_CHAT_ID`
- `FEISHU_SHOOTER_BASE_URL`
- `FEISHU_AI_CORRECTION_BASE_URL`
- `FEISHU_SHOOTER_MISMATCH_BASE_URL`
- `FEISHU_CRAWL_FAILURE_BASE_URL`
- `FEISHU_UNMATCHED_BASE_URL`

## 6. 当前处理逻辑

收到 `crawler广告数据报告_YYYY-MM-DD.xlsx` 后：

1. 下载原始广告 Excel 到 `outputs/incoming/日期/`
2. 根据文件名识别日期
3. 在投手多维表格中找到当天投手数据表
4. 按优先级分类：
   - 抓取失败/无数据
   - AI 修正
   - 投手不一致
   - 未匹配
5. 每个结果都复制当天投手多维表格作为底板
6. 在复制件中只保留对应分类记录
7. 写入广告原始数据指标
8. 将结果链接和数量发送到 `FEISHU_RESULT_CHAT_ID` 对应群

复制投手表作为底板的原因：这样可以保留投手表已有字段、公式、视图和分组。

## 7. 常见问题

### Bitable is copying

飞书复制多维表格后会有后台处理时间。代码已经自动等待重试，如果持续失败，一般是飞书后台复制慢或权限异常。

### 收不到消息

确认：

- Mac 上 `./start_bot.sh` 已启动
- `outputs/bot.out.log` 里出现 `ws client ready`
- 飞书后台事件订阅是长连接
- 机器人在目标群里
- 应用权限已发布/生效

### 能收到消息但无法下载文件

确认应用有消息资源/文件下载相关权限，并且机器人在发送文件的群里。

### 读取不到投手表

确认 `.env` 中 `FEISHU_SHOOTER_BASE_URL` 是正确的多维表格链接，且应用对该文档有读取/写入/复制权限。
