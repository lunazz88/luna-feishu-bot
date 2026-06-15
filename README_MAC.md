# Luna Feishu Bot Mac 使用说明

这个项目用于在 Mac 上运行 Luna 飞书/Lark 两机器人流程。共享仓库只包含配置模板，本地运行前需要创建并填写：

- `.env.robot1`：robot1，处理原始广告文件。
- `.env.robot2`：robot2，接收“更新几月几号数据”命令。

## 1. 安装

把项目下载到 Mac，例如：

```bash
git clone git@github.com:lunazz88/luna-feishu-bot.git
cd luna-feishu-bot
cp .env.robot1.example .env.robot1
cp .env.robot2.example .env.robot2
chmod +x install_mac.sh
./install_mac.sh
```

如果 Mac 没有 Node.js / Python，可以先安装：

```bash
brew install node python
```

## 2. 启动

同时启动 robot1 和 robot2：

```bash
./start_all_mac.sh
```

单独启动：

```bash
./start_robot1_mac.sh
./start_robot2_mac.sh
```

停止：

```bash
./stop_bots_mac.sh
```

查看日志：

```bash
tail -f outputs/robot1.out.log outputs/robot1.err.log
tail -f outputs/robot2.out.log outputs/robot2.err.log
```

## 3. 当前流程

robot1：

1. 群里收到 `crawler广告数据报告_YYYY-MM-DD.xlsx`。
2. 下载原始广告 Excel。
3. 找投手固定表里的当天投手数据表页。
4. 在四个固定大表格下面生成当天表页：
   - ai修正表人工未确认
   - 抓取失败
   - 投手不一致
   - 未匹配

robot2：

1. 群里收到 `更新六月八号数据` 这类文字。
2. 去四个固定大表格下面找当天表页。
3. 合并写入 `ai修正表（人工确认）` 下面的新表页，例如 `六月八号最终修正表`。

robot2 收消息用 `.env.robot2`，写文档时通过 `FEISHU_DOC_ENV_PATH=.env.robot1` 使用 robot1 的文档权限。

## 4. Lark 后台要求

两个应用都要启用机器人能力和长连接事件。

robot1 至少需要：

- 接收消息
- 发送消息
- 下载消息文件
- 读取云文档
- 读取/写入多维表格
- 复制/管理云文档权限

robot2 至少需要：

- 接收消息
- 发送消息

文档写入现在使用 robot1 凭证，因此 robot2 不需要被添加到所有多维表格文档里。

## 5. 重要链接配置

固定表链接在代码默认值和 env 中已经配置。若迁移到正式企业，需要改：

- `.env.robot1`
- `.env.robot2`

重点变量：

```env
FEISHU_SHOOTER_BASE_URL=
FEISHU_AI_CORRECTION_BASE_URL=
FEISHU_AI_CONFIRMED_BASE_URL=
FEISHU_SHOOTER_MISMATCH_BASE_URL=
FEISHU_CRAWL_FAILURE_BASE_URL=
FEISHU_UNMATCHED_BASE_URL=
FEISHU_RESULT_CHAT_ID=
```

## 6. 测试命令

检查语法：

```bash
npm run check
```

测试 robot2 日期解析：

```bash
FEISHU_AUTOMATION_DIR="$PWD" FEISHU_ENV_PATH="$PWD/.env.robot2" FEISHU_DOC_ENV_PATH="$PWD/.env.robot1" node -e "const f=require('./src/finalizeDailyCorrection'); console.log(f.parseBusinessDate('更新六月八号数据'))"
```
