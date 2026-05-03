# TimeNotes

TimeNotes 是一款基于 Wails3 的桌面手账式笔记软件。它把每一页笔记当作纸张画布，文本、图片、贴纸、胶带笔迹、画笔笔迹等内容都作为独立元素放置在画布上，支持拖拽、缩放、旋转、图层管理、多页编辑、阅读预览和 `.tnote` 单文件保存。

## 当前能力

- 画布编辑：支持页面缩放、画布移动、元素拖拽、缩放、旋转、右键菜单、显式对齐线和页面/元素吸附。
- 多页笔记：左侧页面栏可新建、切换、删除、重命名和拖拽调整页面顺序。
- 多标签页：顶部标签页可同时打开多个笔记或阅读视图，并支持切换、关闭和右键重命名。
- 图层管理：右侧图层栏可查看真实缩略图、选择、排序、重命名和删除元素。
- 元素控制：右侧控制栏独立于图层栏，提供文本、图片、贴纸、画笔和胶带笔的属性设置。
- 文本能力：支持富文本编辑、字体选择、系统字体导入打包、字号、颜色、背景和边框样式。
- 图片能力：支持图片素材导入、剪切板粘贴导入、画布放置、元素级裁剪和背景图裁剪。
- 贴纸能力：贴纸库独立于普通素材库，支持内置贴纸和用户上传贴纸；贴纸裁剪只影响当前元素，不污染贴纸库。
- 绘制能力：画笔支持自由笔迹；胶带笔支持直线笔迹、宽度、颜色和图案样式。
- 协同入口：前端已接入 Hocuspocus/Yjs Provider，可连接自托管 WebSocket 房间并同步在线状态。
- 本地日志：后端和前端关键事件写入同一个 `timenotes.log`，便于排查保存、打开、导入和 WebView 问题。

## 技术栈

- 桌面框架：Go + Wails3
- 前端框架：React + TypeScript + Vite
- UI：Semi Design、Semi Icons、TailwindCSS
- 画布：DOM 元素层 + Konva 绘制层 + Moveable 变换控制
- 文本：Tiptap
- 协同：Yjs + Hocuspocus Provider
- 文件格式：`.tnote` ZIP 单文件包

## 项目结构

```text
.
├── main.go                         # Wails 应用入口和服务注册
├── document_services.go            # .tnote 新建、打开、保存、资源导入和导出服务
├── document_types.go               # .tnote 文档、页面、元素、素材等 Go 数据结构
├── logger.go                       # 后端日志和前端日志桥接
├── frontend/
│   ├── src/
│   │   ├── components/             # 顶栏、画布、图层、素材、阅读器等组件
│   │   ├── providers/              # 文档状态和协同状态
│   │   ├── lib/                    # 文件、字体、日志、ID 等工具
│   │   ├── data/                   # 内置贴纸等静态数据
│   │   └── assets/                 # Logo 和内置图片资源
│   ├── bindings/                   # Wails 生成的 TypeScript 绑定
│   └── package.json                # 前端依赖和构建脚本
├── build/                          # Wails 平台构建配置
├── AGENTS.md                       # Codex/工程协作规则
└── README.md
```

## 开发环境

需要本机已安装：

- Go
- Node.js / npm
- Wails3 CLI
- WebView2 Runtime，Windows 通常已自带或由系统安装

安装依赖时手动执行：

```powershell
npm install
cd frontend
npm install
```

## 常用命令

前端构建：

```powershell
cd frontend
npm run build
```

Go 测试：

```powershell
go test ./...
```

Go 构建：

```powershell
go build .
```

Wails 开发模式：

```powershell
wails3 dev
```

Wails 打包：

```powershell
wails3 package
```

修改导出的 Go 服务方法或类型后，需要重新生成前端绑定：

```powershell
wails3 generate bindings -clean=true -ts
```

## 开发服务器端口

前端开发服务器固定使用：

```text
127.0.0.1:9245
```

如果启动 `wails3 dev` 时出现端口占用：

```text
listen tcp 127.0.0.1:9245: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.
```

先检查端口：

```powershell
Get-NetTCPConnection -LocalPort 9245 -ErrorAction SilentlyContinue
netstat -ano | Select-String ':9245'
```

确认 PID 属于本项目此前启动的 Vite/Wails/Node 进程后再停止：

```powershell
Stop-Process -Id <PID> -Force
```

不要停止不属于本项目或用户仍在使用的进程。

## `.tnote` 文件格式

`.tnote` 是 TimeNotes 的可编辑源文件格式，本质是 ZIP 包。保存后的文件不依赖本机绝对路径，适合复制到其他设备继续打开编辑。

包内主要内容：

- `manifest.json`：格式版本、应用版本、资源索引和内部路径。
- `document.json`：页面、元素、素材引用、字体引用和样式快照。
- `yjs/update.bin`：Yjs 二进制状态。
- `assets/`：普通图片素材和背景图。
- `stickers/`：贴纸资源，独立于普通素材。
- `fonts/`：用户导入或系统字体打包后的字体文件。

当前格式版本由后端和前端共同维护，结构变化需要显式迁移逻辑。

## 日志

应用启动时会创建 `timenotes.log`。优先写到可执行文件所在目录，例如：

```text
D:\TimeNotes\TimeNotes\bin\timenotes.log
```

日志写入时机包括：

- 应用启动和日志系统就绪。
- 新建、打开、保存 `.tnote`。
- 导入素材、导入字体、枚举系统字体。
- 导出页面或 HTML 的后端事件。
- 前端关键业务事件和捕获到的错误。
- Wails 或 Go panic/error。

日志只保留一个主文件，超过 2MB 会轮转为 `timenotes.log.1`。临时排障可用环境变量指定日志目录：

```powershell
$env:TIMENOTES_LOG_DIR = "D:\TimeNotes\logs"
```

## 协同编辑

当前前端提供 Hocuspocus/Yjs 协同入口，可填写：

- WebSocket 地址
- 房间 ID
- 房间密钥
- 用户名

房间密钥只用于连接鉴权，不应写入日志。生产可用的协同服务需要单独部署 Hocuspocus 服务端，并配置持久化与鉴权策略。

## 质量检查

提交或交付前建议至少执行：

```powershell
go test ./...
go build .
cd frontend
npm run build
```

涉及画布、裁剪、拖拽、对齐线、贴纸或阅读视图的改动，需要用真实浏览器或 Wails WebView 验证，而不是只通过静态构建判断。

## 开发约定

- `App.tsx` 只做应用组合入口，编辑器逻辑拆到组件和 hooks。
- 页面坐标使用画布坐标，不保存屏幕缩放后的像素。
- 选择框、hover、右键菜单、缩放缓存等 UI 临时状态不写入文档模型。
- 贴纸库和普通素材库保持独立。
- 字体必须打包进 `.tnote` 后才能保证其他设备正常展示。
- 打开 `.tnote` 时后端必须校验 ZIP 内路径，不能信任压缩包条目路径。
- 不要把 WebView2 profile/cache 当作项目业务数据保存到仓库。
