package main

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const maxLogSizeBytes int64 = 2 * 1024 * 1024

var (
	appLogPath  string
	appLogPaths []string
	appLogFiles []*os.File
	appLogMu    sync.Mutex
)

type LogService struct{}

func setupLogging() {
	// 日志优先写到可执行文件所在目录。用户从 bin/TimeNotes.exe 启动时，
	// 主日志就是 D:\TimeNotes\TimeNotes\bin\timenotes.log；失败时才退到其他目录。
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	files, paths := openLogFiles()
	appLogFiles = files
	appLogPaths = paths
	if len(paths) > 0 {
		appLogPath = paths[0]
	}

	// GUI 子系统下 stdout/stderr 可能不可写。fanoutLogWriter 会让文件先写入，
	// 并隔离无效 stdout 的错误，避免“日志文件创建了但内容为空”。
	writers := make([]io.Writer, 0, len(files)+2)
	for _, file := range files {
		writers = append(writers, file)
	}
	writers = append(writers, os.Stdout, os.Stderr)
	log.SetOutput(fanoutLogWriter{writers: writers})

	logEvent("info", "logging_ready", map[string]interface{}{
		"primaryPath": appLogPath,
		"paths":       appLogPaths,
		"exe":         executablePath(),
		"cwd":         workingDirectory(),
		"goos":        runtime.GOOS,
	})
}

func closeLogging() {
	appLogMu.Lock()
	defer appLogMu.Unlock()
	for _, file := range appLogFiles {
		// 退出前主动刷盘，避免 Windows 下用户立刻打开日志时看到旧内容。
		_ = file.Sync()
		_ = file.Close()
	}
	appLogFiles = nil
}

func logEvent(level string, message string, fields map[string]interface{}) {
	appLogMu.Lock()
	defer appLogMu.Unlock()
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
	for _, file := range appLogFiles {
		// 每条日志写入后立即 Sync，牺牲很小的性能换取调试时可立即看到内容。
		_ = file.Sync()
	}
}

func (s *LogService) Path() string {
	// 前端可通过这个方法向用户展示真实日志路径，避免不同启动目录造成误会。
	return appLogPath
}

func (s *LogService) Paths() []string {
	// 保留数组返回值是为了兼容前端绑定；当前策略只打开一个主日志文件，避免重复写盘。
	return append([]string(nil), appLogPaths...)
}

func (s *LogService) Frontend(level string, message string, fields map[string]interface{}) {
	// 前端错误和关键操作也写进同一个文件，排查 WebView 行为时不用同时看浏览器控制台。
	if fields == nil {
		fields = map[string]interface{}{}
	}
	fields["source"] = "frontend"
	logEvent(level, message, fields)
}

type fanoutLogWriter struct {
	writers []io.Writer
}

func (writer fanoutLogWriter) Write(payload []byte) (int, error) {
	wrote := false
	for _, target := range writer.writers {
		if target == nil {
			continue
		}
		if _, err := target.Write(payload); err == nil {
			wrote = true
		}
	}
	if wrote {
		return len(payload), nil
	}
	return 0, os.ErrInvalid
}

func openLogFiles() ([]*os.File, []string) {
	candidates := []string{}
	if override := strings.TrimSpace(os.Getenv("TIMENOTES_LOG_DIR")); override != "" {
		// 测试或临时排障可以显式指定日志目录，避免污染真实运行目录。
		candidates = append(candidates, override)
	}
	if exePath := executablePath(); exePath != "" {
		candidates = append(candidates, filepath.Dir(exePath))
	}
	if cwd := workingDirectory(); cwd != "" {
		candidates = append(candidates, cwd)
	}
	if configDir, err := os.UserConfigDir(); err == nil {
		candidates = append(candidates, filepath.Join(configDir, "TimeNotes"))
	}

	seen := map[string]bool{}
	files := []*os.File{}
	paths := []string{}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		cleanedDir := filepath.Clean(dir)
		key := filepath.ToSlash(strings.ToLower(cleanedDir))
		if seen[key] {
			continue
		}
		seen[key] = true
		if err := os.MkdirAll(cleanedDir, 0o755); err != nil {
			continue
		}
		path := filepath.Join(cleanedDir, "timenotes.log")
		if err := rotateLogIfNeeded(path); err != nil {
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			continue
		}
		// 只返回第一个可写文件。之前同时写 exe 目录和 AppData，会让日志体积翻倍且难以判断主文件。
		return []*os.File{file}, []string{path}
	}
	return files, paths
}

func rotateLogIfNeeded(path string) error {
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxLogSizeBytes {
		return nil
	}
	rotated := path + ".1"
	_ = os.Remove(rotated)
	if err := os.Rename(path, rotated); err != nil {
		// 如果文件被杀毒软件或查看器短暂占用，退而求其次直接截断当前日志，避免无限增长。
		return os.Truncate(path, 0)
	}
	return nil
}

func executablePath() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Clean(path)
}

func workingDirectory() string {
	path, err := os.Getwd()
	if err != nil {
		return ""
	}
	return filepath.Clean(path)
}
