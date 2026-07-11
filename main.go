package main

import (
	"embed"
	_ "embed"
	"os"
	"runtime/debug"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails 使用 embed 把 frontend/dist 打进最终二进制；生产包不会再依赖外部静态文件目录。

//go:embed all:frontend/dist
var assets embed.FS

var (
	pendingQuit   bool
	quitConfirmed bool
	mainWindow    application.Window
	mainApp       *application.App
)

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

// 本地 Blog 桥：供 Blog 后台「编辑手账」与前端连接配置读写使用（仅 loopback:54088）。
		blogBridge, blogBridgeErr := startBlogBridge()
		if blogBridgeErr != nil {
			logEvent("warn", "blog_bridge_start_failed", map[string]interface{}{"error": blogBridgeErr.Error()})
		} else if blogBridge != nil {
			defer blogBridge.Close()
		}

		// Services 中注册的结构体方法会生成 TypeScript 绑定，前端通过这些绑定访问本地文件和素材能力。
		app := application.New(application.Options{
		Name:                  "TimeNotes",
		Description:           "A canvas based hand-journal note editor",
			FileAssociations:      []string{".tnote"},
			SingleInstance: &application.SingleInstanceOptions{
				UniqueID: "com.timenotes.app",
				OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
					if mainWindow != nil {
						mainWindow.EmitEvent("app:file-open-requested", data)
						mainWindow.Restore()
						mainWindow.Focus()
					}
				},
			},
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
			ShouldQuit: func() bool {
				if !pendingQuit {
					// WindowClosing 钩子在 Windows 上先拦截；此回调主要用于
					// macOS / Linux，以及前端 ConfirmAppQuit 后的二次确认。
					pendingQuit = true
					logEvent("info", "app_quit_requested", nil)
					if mainWindow != nil {
						mainWindow.EmitEvent("app:exit-requested")
					}
					go func() {
						time.Sleep(5 * time.Second)
						if pendingQuit && !quitConfirmed {
							logEvent("warn", "app_quit_timeout_force", nil)
							quitConfirmed = true
							if mainApp != nil {
								mainApp.Quit()
							}
						}
					}()
					return false
				}
				return quitConfirmed
			},
		Services: []application.Service{
			application.NewService(&DocumentService{}),
			application.NewService(&AssetService{}),
			application.NewService(&ExportService{}),
			application.NewService(&LogService{}),
			application.NewService(&NotebookService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

		// 主窗口只加载根路径，开发模式由 Wails 代理到 Vite，打包后由上面的 embed 文件系统提供资源。
		mainApp = app
		mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
			Title: "TimeNotes",
			Mac: application.MacWindow{
				InvisibleTitleBarHeight: 50,
				Backdrop:                application.MacBackdropTranslucent,
				TitleBar:                application.MacTitleBarHiddenInset,
			},
			BackgroundColour: application.NewRGB(238, 234, 224),
			URL:              "/",
			EnableFileDrop:   true,
		})

		// 在 Windows 上 ShouldQuit 只在 destroy() 中调用（窗口已销毁后），
		// 无法用于阻止关闭。改用 WindowClosing 钩子，在窗口关闭前拦截。
		if wv, ok := mainWindow.(*application.WebviewWindow); ok {
			wv.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
				if !pendingQuit {
					pendingQuit = true
					logEvent("info", "app_quit_requested", nil)
					mainWindow.EmitEvent("app:exit-requested")
					// 取消本次关闭，等前端保存完成后通过 ConfirmAppQuit 重新触发。
					event.Cancel()
					// 兜底：5 秒后如果前端未响应，取消 pending 并强制放行。
					go func() {
						time.Sleep(5 * time.Second)
						if pendingQuit && !quitConfirmed {
							logEvent("warn", "app_quit_timeout_force", nil)
							pendingQuit = false
							quitConfirmed = true
							if mainApp != nil {
								mainApp.Quit()
							}
						}
					}()
				}
			})
		}

		// app.Run 会阻塞到窗口退出；这里统一记录无法启动或运行时崩溃的错误。
		err := app.Run()

	if err != nil {
		logEvent("error", "app_run_failed", map[string]interface{}{"error": err.Error()})
		closeLogging()
		os.Exit(1)
	}
}

