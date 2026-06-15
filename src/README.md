# 飞书数据修正命令行工具

这是把当前手动流程整理后的第一版稳定入口。后续飞书机器人收到消息后，只需要调用这个入口即可。

## Dry-run 预览

只读取飞书数据并生成本地报告，不复制、不写入：

```powershell
& 'E:\uresnew\node.exe' src\processDailyData.js `
  --rawUrl="原始广告数据 wiki/sheet 链接" `
  --shooterUrl="投手填写多维表格链接" `
  --name="六月八号数据修正"
```

## 正式执行

复制投手填写多维表格，写入复制后的新表，并开放租户内编辑链接：

```powershell
& 'E:\uresnew\node.exe' src\processDailyData.js `
  --rawUrl="原始广告数据 wiki/sheet 链接" `
  --shooterUrl="投手填写多维表格链接" `
  --name="六月八号数据修正" `
  --execute
```

## 输出

每次运行会在 `outputs/<name>/` 下生成：

- `处理结果摘要.json`
- `未匹配清单.csv`
- `待人工确认清单.csv`

## 安全规则

- 默认 dry-run，不会写入飞书。
- 只有加 `--execute` 才会复制并写入。
- 写入目标始终是复制后的新多维表格，不写原始广告表，也不写原投手填写表。
