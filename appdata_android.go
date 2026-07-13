//go:build android

package main

import (
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// platformDataRoot returns the app-private files directory on Android.
// Desktop UserConfigDir/HOME often resolve to /sdcard which is not writable
// without storage permissions (mkdir /sdcard/AppData: permission denied).
func platformDataRoot() string {
	if path := application.Android.StoragePath(); path != "" {
		return filepath.Join(path, "TimeNotes")
	}
	if dir, err := os.Getwd(); err == nil && dir != "" {
		return filepath.Join(dir, "TimeNotes")
	}
	return filepath.Join(".", "TimeNotes")
}
