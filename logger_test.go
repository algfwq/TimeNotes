package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupLoggingWritesUnderCurrentDirectory(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TIMENOTES_LOG_DIR", tmp)
	t.Cleanup(func() {
		log.SetOutput(os.Stdout)
	})

	setupLogging()
	logEvent("info", "logger_test_event", map[string]interface{}{"case": "current_directory"})
	closeLogging()
	log.SetOutput(os.Stdout)

	logPath := filepath.Join(tmp, "timenotes.log")
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if !strings.Contains(string(raw), "logger_test_event") {
		t.Fatalf("expected logger_test_event in %s", logPath)
	}
}

func TestSetupLoggingRotatesLargeLog(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TIMENOTES_LOG_DIR", tmp)
	t.Cleanup(func() {
		log.SetOutput(os.Stdout)
	})

	logPath := filepath.Join(tmp, "timenotes.log")
	if err := os.WriteFile(logPath, []byte(strings.Repeat("x", int(maxLogSizeBytes)+1)), 0o644); err != nil {
		t.Fatalf("seed large log: %v", err)
	}

	setupLogging()
	logEvent("info", "logger_after_rotate", map[string]interface{}{"case": "rotate"})
	closeLogging()
	log.SetOutput(os.Stdout)

	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected rotated log: %v", err)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read new log: %v", err)
	}
	if !strings.Contains(string(raw), "logger_after_rotate") {
		t.Fatalf("expected logger_after_rotate in new log")
	}
}
