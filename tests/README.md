# Electron 隔离验收

这套测试在带桌面环境的 Windows 上启动真实 Electron 应用，覆盖 18 项行为检查：空相册启动、创建、导入、导航、自动播放、色调与编辑保存、3D 卷片与声音、连续点击防重入、末张循环、完整照片与窗口适配、大图、全屏、重启恢复、文件夹迁移和移除登记。

## 运行

在仓库根目录执行：

```powershell
npm ci
npm run build
npm run smoke
```

测试会启动应用窗口、短暂进入全屏并播放本地机械音效。需要可用的桌面会话。修改源码后应先重新构建。

若验收已打包的程序，可将可执行文件路径传入：

```powershell
$env:PHOTOBOOK_EXE = (Resolve-Path '.\release\win-unpacked\拾光胶片.exe').Path
npm run smoke
Remove-Item Env:PHOTOBOOK_EXE
```

## 测试数据与报告

- 每次运行在仓库内的 `.test-data/camera-smoke-<时间戳>/` 创建独立应用资料与测试相册。
- 两张测试图片由 Canvas 绘制渐变、方块和字母，完全合成；不读取用户照片。
- 测试通过 `PHOTOBOOK_SMOKE_ROOT` 隔离应用资料，通过专用导入列表与打开目录绕过人工选择，只处理本次生成的文件。
- 页面在测试过程中设置为离线，并检查网页异常、控制台错误与外部网络请求。
- 报告写入 `test-output/camera/test-report.json`，截图保存在同一目录；失败时尽可能保存 `camera-failure.png`。
- `.test-data/` 与 `test-output/` 已加入忽略规则。报告和合成相册保留以便诊断；测试结束后可自行清理这两个目录。

## 数据保护检查

测试对生成图片与相册副本计算哈希，确认导入不改变图片内容。相册迁移操作先验证源路径和目标路径都位于本次隔离目录。移除照片只删除相册登记，并检查复制文件与导入源文件仍然存在。

这套测试验证本地相册流程及真实界面行为。RAW 格式支持范围和安装后的系统兼容性仍需要单独验证。