//go:build windows && !android

package main

import (
	"os/exec"
)

func openInExplorer(path string) error {
	return exec.Command("explorer", "/select,", path).Start()
}
