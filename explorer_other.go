//go:build !windows || android

package main

import "fmt"

// openInExplorer is a desktop convenience. On Android/macOS/Linux mobile builds
// there is no file-manager select flow comparable to Windows Explorer.
func openInExplorer(path string) error {
	return fmt.Errorf("open file directory is not supported on this platform (%s)", path)
}
