package main

import (
	"embed"
	_ "embed"
	"os"
	"runtime/debug"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails 使用 embed 把 frontend/dist 打进最终二进制；生产包不会再依赖外部静态文件目录。

//go:embed all:frontend/dist
var assets embed.FS

// main 是桌面应用入口：初始化日志、注册后端服务、创建 WebView 窗口并启动 Wails 事件循环。
func main() {
	setupLogging()
	defer func() {
		if recovered := recover(); recovered != nil {
			logEvent("error", "panic_recovered", map[string]interface{}{
				"panic": recovered,
				"stack": string(debug.Stack()),
			})
		}
		closeLogging()
	}()

	// Services 中注册的结构体方法会生成 TypeScript 绑定，前端通过这些绑定访问本地文件和素材能力。
	app := application.New(application.Options{
		Name:        "TimeNotes",
		Description: "A canvas based hand-journal note editor",
		PanicHandler: func(details *application.PanicDetails) {
			// Wails 内部 panic 也写入同一个日志文件，方便定位启动和窗口生命周期问题。
			fields := map[string]interface{}{}
			if details != nil {
				if details.Error != nil {
					fields["error"] = details.Error.Error()
				}
				fields["time"] = details.Time
				fields["stack"] = details.StackTrace
				fields["fullStack"] = details.FullStackTrace
			}
			logEvent("error", "wails_panic", fields)
		},
		ErrorHandler: func(err error) {
			// Wails 系统级错误不一定会传到前端，这里在后端直接记录。
			logEvent("error", "wails_error", map[string]interface{}{"error": err.Error()})
		},
		Services: []application.Service{
			application.NewService(&DocumentService{}),
			application.NewService(&AssetService{}),
			application.NewService(&ExportService{}),
			application.NewService(&LogService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 主窗口只加载根路径，开发模式由 Wails 代理到 Vite，打包后由上面的 embed 文件系统提供资源。
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "TimeNotes",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(238, 234, 224),
		URL:              "/",
	})

	// app.Run 会阻塞到窗口退出；这里统一记录无法启动或运行时崩溃的错误。
	err := app.Run()

	if err != nil {
		logEvent("error", "app_run_failed", map[string]interface{}{"error": err.Error()})
		closeLogging()
		os.Exit(1)
	}
}
