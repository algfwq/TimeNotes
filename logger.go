package main

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
)

var (
	appLogPath string
	appLogFile *os.File
)

type LogService struct{}

func setupLogging() {
	// 日志直接落在当前工作目录，方便用户从项目目录启动 wails3 dev 后立刻查看。
	// 这里不再放进 logs/ 子目录，是为了避免用户看错旧文件而误判“日志为空”。
	wd, err := os.Getwd()
	if err != nil {
		wd = "."
	}
	path := filepath.Join(wd, "timenotes.log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("open log file failed: %v", err)
		return
	}
	appLogPath = path
	appLogFile = file
	log.SetOutput(io.MultiWriter(os.Stdout, file))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	logEvent("info", "logging_ready", map[string]interface{}{"path": path})
}

func closeLogging() {
	if appLogFile != nil {
		// 退出前主动刷盘，避免 Windows 下用户立刻打开日志时看到旧内容。
		_ = appLogFile.Sync()
		_ = appLogFile.Close()
	}
}

func logEvent(level string, message string, fields map[string]interface{}) {
	// 后端日志统一写 JSON 行，方便未来直接用脚本检索保存、打开、导入等事件。
	entry := map[string]interface{}{
		"time":    time.Now().UTC().Format(time.RFC3339Nano),
		"level":   level,
		"message": message,
	}
	for key, value := range fields {
		entry[key] = value
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		log.Printf(`{"level":"error","message":"log_marshal_failed","error":%q}`, err.Error())
		return
	}
	log.Print(string(raw))
	if appLogFile != nil {
		// 每条日志写入后立即 Sync，牺牲很小的性能换取调试时可立即看到内容。
		_ = appLogFile.Sync()
	}
}

func (s *LogService) Path() string {
	// 前端可通过这个方法向用户展示真实日志路径，避免不同启动目录造成误会。
	return appLogPath
}

func (s *LogService) Frontend(level string, message string, fields map[string]interface{}) {
	// 前端错误和关键操作也写进同一个文件，排查 WebView 行为时不用同时看浏览器控制台。
	if fields == nil {
		fields = map[string]interface{}{}
	}
	fields["source"] = "frontend"
	logEvent(level, message, fields)
}
