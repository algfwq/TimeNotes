//go:build android

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func init() {
	// c-shared Android builds do not invoke main() automatically.
	// Register the shared main so the Java host can start the app.
	application.RegisterAndroidMain(main)
}
