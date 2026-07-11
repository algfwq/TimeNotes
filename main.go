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

// setupMenu 构建完整的 macOS 原生菜单栏。
// 注意：Wails3 在 macOS 上会通过 AppMenu 角色自动添加标准应用菜单（About / Hide / Quit 等）。
// 文件、编辑、显示、窗口、帮助菜单为自定义实现，发射事件到前端供 DocumentProvider 处理。
func setupMenu() *application.Menu {
	menu := application.NewMenu()

	// 标准 macOS 应用菜单 (About / Services / Hide / Quit)
	menu.AddRole(application.AppMenu)

	// ── 文件 ──
	fileMenu := application.NewMenu()
	fileMenu.Add("新建手账本").SetAccelerator("CmdOrCtrl+n").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:new-notebook")
		}
	})
	fileMenu.Add("打开手账本…").SetAccelerator("CmdOrCtrl+o").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:open-notebook")
		}
	})
	fileMenu.AddSeparator()
	fileMenu.Add("保存").SetAccelerator("CmdOrCtrl+s").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:save")
		}
	})
	fileMenu.Add("另存为…").SetAccelerator("CmdOrCtrl+Shift+s").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:save-as")
		}
	})
	fileMenu.AddSeparator()
	fileMenu.Add("导出为 HTML…").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:export-html")
		}
	})
	fileMenu.AddSeparator()
	fileMenu.AddRole(application.CloseWindow)
	menu.AddSubmenu("文件").Append(fileMenu)

	// ── 编辑 ──
	editMenu := application.NewMenu()
	editMenu.AddRole(application.Undo)
	editMenu.AddRole(application.Redo)
	editMenu.AddSeparator()
	editMenu.AddRole(application.Cut)
	editMenu.AddRole(application.Copy)
	editMenu.AddRole(application.Paste)
	editMenu.AddRole(application.PasteAndMatchStyle)
	editMenu.AddRole(application.Delete)
	editMenu.AddSeparator()
	editMenu.AddRole(application.SelectAll)
	editMenu.AddSeparator()
	editMenu.AddRole(application.SpeechMenu)
	menu.AddSubmenu("编辑").Append(editMenu)

	// ── 显示 ──
	viewMenu := application.NewMenu()
	viewMenu.AddRole(application.Reload)
	viewMenu.AddRole(application.ForceReload)
	viewMenu.AddRole(application.OpenDevTools)
	viewMenu.AddSeparator()
	viewMenu.AddRole(application.ResetZoom)
	viewMenu.AddRole(application.ZoomIn)
	viewMenu.AddRole(application.ZoomOut)
	viewMenu.AddSeparator()
	viewMenu.Add("缩放到适配").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:zoom-fit")
		}
	})
	viewMenu.AddSeparator()
	viewMenu.Add("切换深色模式").SetAccelerator("CmdOrCtrl+Shift+d").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:toggle-dark-mode")
		}
	})
	viewMenu.AddSeparator()
	viewMenu.AddRole(application.ToggleFullscreen)
	menu.AddSubmenu("显示").Append(viewMenu)

	// ── 窗口 ──
	windowMenu := application.NewMenu()
	windowMenu.AddRole(application.Minimise)
	windowMenu.AddRole(application.Zoom)
	windowMenu.AddSeparator()
	windowMenu.AddRole(application.BringAllToFront)
	menu.AddSubmenu("窗口").Append(windowMenu)

	// ── 帮助 ──
	helpMenu := application.NewMenu()
	helpMenu.Add("TimeNotes 帮助").OnClick(func(ctx *application.Context) {
		if mainWindow != nil {
			mainWindow.EmitEvent("menu:help")
		}
	})
	helpMenu.AddSeparator()
	helpMenu.AddRole(application.About)
	menu.AddSubmenu("帮助").Append(helpMenu)

	return menu
}

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
		Name:        "TimeNotes",
		Description: "A canvas based hand-journal note editor",
		FileAssociations: []string{".tnote"},
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
			logEvent("error", "wails_error", map[string]interface{}{"error": err.Error()})
		},
		ShouldQuit: func() bool {
			if !pendingQuit {
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

	// 设置原生 macOS 菜单栏
	menu := setupMenu()
	app.Menu.SetApplicationMenu(menu)

	// 主窗口只加载根路径，开发模式由 Wails 代理到 Vite，打包后由上面的 embed 文件系统提供资源。
	mainApp = app
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "TimeNotes",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
			Appearance:              application.DefaultAppearance,
			DisableEscapeExitsFullscreen: true,
			CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
				application.MacWindowCollectionBehaviorFullScreenPrimary |
				application.MacWindowCollectionBehaviorFullScreenAllowsTiling,
			WebviewPreferences: application.MacWebviewPreferences{
				AllowsBackForwardNavigationGestures: application.Enabled,
				AllowsMagnification:                 application.Enabled,
				TabFocusesLinks:                     application.Disabled,
				TextInteractionEnabled:              application.Enabled,
				FullscreenEnabled:                   application.Enabled,
				JavaScriptCanOpenWindowsAutomatically: application.Disabled,
			},
		},
		BackgroundColour: application.NewRGB(238, 234, 224),
		URL:              "/",
		EnableFileDrop:   true,
	})

	// WindowClosing 钩子在 Windows 上用于拦截关闭并触发前端保存确认。
	if wv, ok := mainWindow.(*application.WebviewWindow); ok {
		wv.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
			if !pendingQuit {
				pendingQuit = true
				logEvent("info", "app_quit_requested", nil)
				mainWindow.EmitEvent("app:exit-requested")
				event.Cancel()
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

	err := app.Run()

	if err != nil {
		logEvent("error", "app_run_failed", map[string]interface{}{"error": err.Error()})
		closeLogging()
		os.Exit(1)
	}
}
