# AGENTS.md

## 项目定位
TimeNotes 是一款 Wails3 桌面手账式笔记软件。每份笔记由纸张画布组成，文本、图片、贴纸、胶带、绘画和形状都是可编辑元素，支持位置、尺寸、旋转、层级和样式调整。

## 架构
- 后端：Go + Wails3，负责本地文件、素材、导出和桌面能力。
- 前端：React + TypeScript + Vite。
- UI：Semi Design 和 Semi Icons 用于应用框架；TailwindCSS 用于布局工具类和编辑器定制样式。
- 画布：混合编辑器。DOM 负责富文本、图片、贴纸、胶带、选择框和属性面板；Konva 负责自由绘画、形状和栅格导出辅助。
- 协同：Yjs 文档状态通过自托管 Hocuspocus WebSocket 服务同步，服务端使用 SQLite 持久化，并通过房间密钥鉴权。

## 文件格式
- `.tnote` 是可编辑、可传播的源文件格式。
- 文件包内必须包含所需素材、图片、字体、元数据、缩略图和 Yjs 二进制状态。
- 保存后的文档不得依赖本机绝对路径。
- 便携 HTML 导出默认为只读查看，除非后续任务明确要求浏览器侧编辑和回写。

## 前端规则
- `App.tsx` 只做组合入口，编辑器子系统拆成明确组件和 hooks。
- Semi 组件用于导航、按钮、上传、弹窗、下拉、标签页、表单和通知。
- Tailwind 必须在配置 Semi 兼容 CSS Layer 后使用。
- 不允许把所有逻辑塞进单个巨大画布组件。
- 持久化元素坐标使用页面坐标，不使用屏幕像素。
- hover、菜单打开状态、本地选择框、缩放渲染缓存等临时 UI 状态不得写入文档模型。

## 协同规则
- Yjs 是协同文档状态的唯一事实源。
- 持久化 Yjs 二进制 update/state，不要从 JSON 重建为 Yjs 状态。
- Awareness 仅用于在线状态，不持久化。
- 房间密钥视为敏感信息，不得写入日志。
- 文档结构变更必须更新 `formatVersion` 并提供迁移逻辑。

## 后端规则
- Wails 服务保持小而明确。
- 导入素材和字体使用内容哈希去重。
- 打开 `.tnote` 时必须校验 ZIP 内路径，不能信任压缩包条目路径。
- 返回适合前端 toast/modal 展示的结构化错误。
- 修改导出的 Go 服务方法后运行 `wails3 generate bindings -clean=true -ts`。

## 常用命令
- 前端构建：`cd frontend; npm run build`
- Go 测试：`go test ./...`
- Go 构建：`go build .`
- Wails 打包：`wails3 package`

## 开发服务器与端口
- 默认前端开发端口为 `127.0.0.1:9245`。
- 启动 `npm run dev`、`wails3 dev` 或其他长期运行服务前，先检查端口占用：`Get-NetTCPConnection -LocalPort 9245 -ErrorAction SilentlyContinue`。
- 如果 `Get-NetTCPConnection` 没查到但仍报端口占用，必须用 `netstat -ano | Select-String ':9245'` 兜底；以 `LISTENING` 行里的 PID 为准。
- 如果 `9245` 被本项目此前启动的 Vite/Wails/Node 进程占用，应先停止该进程再重新启动，避免 `bind: Only one usage of each socket address`。
- Windows 清理命令示例：确认 PID 属于本项目 Node/Vite/Wails 后执行 `Stop-Process -Id <PID> -Force`，再用 `netstat -ano | Select-String ':9245'` 确认没有 `LISTENING`。
- 任务结束前必须清理由本任务启动的开发服务器进程，不能把隐藏后台 Vite/Wails 进程遗留给用户。
- 只清理确认属于本项目、本任务启动的进程；不要停止无关应用或用户手动启动且仍在使用的服务。

## WebView2 与日志
- WebView2 运行时会创建 user-data/profile 目录；这是运行时缓存，不属于 `.tnote`、素材或项目业务数据。
- Windows 端默认交给 Wails/WebView2 管理 user-data/profile 路径；不要为了“无缓存”强行改成项目 `bin/webview-data`。
- 日志只保留一个主文件并设置体积上限；不要为同一条日志同时写入多个长期目录。
- 前端日志只记录启动、错误、退出快照和关键业务事件，不要添加固定频率心跳日志。

## 质量要求
- 编辑器行为必须用真实浏览器或 WebView 验证，不能只读代码。
- 视觉和编辑器变更需要检查桌面和窄屏宽度。
- 导出功能变更后必须重新打开导出产物验证素材和字体。
- 不得回退用户已有的无关改动。
