package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupLoggingWritesUnderCurrentDirectory(t *testing.T) {
	originalWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	if err := os.Chdir(tmp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalWD)
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
