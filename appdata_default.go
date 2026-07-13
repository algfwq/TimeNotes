//go:build !android

package main

import (
	"os"
	"path/filepath"
)

// platformDataRoot is the desktop app data directory (config dir / TimeNotes).
func platformDataRoot() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		if home, homeErr := os.UserHomeDir(); homeErr == nil && home != "" {
			// Prefer Windows Roaming AppData when present; otherwise XDG-style.
			if _, statErr := os.Stat(filepath.Join(home, "AppData")); statErr == nil {
				return filepath.Join(home, "AppData", "Roaming", "TimeNotes")
			}
			return filepath.Join(home, ".config", "TimeNotes")
		}
		return filepath.Join(".", "TimeNotes")
	}
	return filepath.Join(dir, "TimeNotes")
}
