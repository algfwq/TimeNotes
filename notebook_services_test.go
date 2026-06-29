package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNotebooksRootUsesUserConfigDir(t *testing.T) {
	temp := t.TempDir()
	oldConfigDir := notebooksConfigDirOverride
	oldExeDir := notebooksExeDirOverride
	oldMigrated := notebooksMigrationChecked
	notebooksConfigDirOverride = temp
	notebooksExeDirOverride = filepath.Join(t.TempDir(), "InstallDir")
	notebooksMigrationChecked = false
	t.Cleanup(func() {
		notebooksConfigDirOverride = oldConfigDir
		notebooksExeDirOverride = oldExeDir
		notebooksMigrationChecked = oldMigrated
	})

	got := notebooksRoot()
	want := filepath.Join(temp, "notebooks")
	if got != want {
		t.Fatalf("notebooksRoot() = %q, want %q", got, want)
	}
	if got == filepath.Join(notebooksExeDirOverride, "notebooks") {
		t.Fatalf("notebooksRoot() used executable directory")
	}
}

func TestNotebookStoreMigratesFromOldExecutableDirectory(t *testing.T) {
	configDir := t.TempDir()
	exeDir := t.TempDir()
	oldConfigDir := notebooksConfigDirOverride
	oldExeDir := notebooksExeDirOverride
	oldMigrated := notebooksMigrationChecked
	notebooksConfigDirOverride = configDir
	notebooksExeDirOverride = exeDir
	notebooksMigrationChecked = false
	t.Cleanup(func() {
		notebooksConfigDirOverride = oldConfigDir
		notebooksExeDirOverride = oldExeDir
		notebooksMigrationChecked = oldMigrated
	})

	oldRoot := filepath.Join(exeDir, "notebooks")
	if err := os.MkdirAll(oldRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	oldNotePath := filepath.Join(oldRoot, "Old.tnote")
	if err := os.WriteFile(oldNotePath, []byte("not a real note for migration path test"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := NotebookStore{Version: 1, Notebooks: []NotebookMeta{{
		ID:        "1",
		Name:      "Old",
		Path:      oldNotePath,
		IsManaged: true,
		CoverType: "default",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}}}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(exeDir, "notebooks.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	migrated, err := readNotebookStore()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated.Notebooks) != 1 {
		t.Fatalf("len(migrated.Notebooks) = %d, want 1", len(migrated.Notebooks))
	}
	wantPath := filepath.Join(configDir, "notebooks", "Old.tnote")
	if migrated.Notebooks[0].Path != wantPath {
		t.Fatalf("migrated path = %q, want %q", migrated.Notebooks[0].Path, wantPath)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("migrated note missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(configDir, "notebooks.json")); err != nil {
		t.Fatalf("migrated store missing: %v", err)
	}
}

func TestImportNotebookRestoresThumbnailAsCustomCover(t *testing.T) {
	configDir := t.TempDir()
	oldConfigDir := notebooksConfigDirOverride
	oldExeDir := notebooksExeDirOverride
	oldMigrated := notebooksMigrationChecked
	notebooksConfigDirOverride = configDir
	notebooksExeDirOverride = t.TempDir()
	notebooksMigrationChecked = false
	t.Cleanup(func() {
		notebooksConfigDirOverride = oldConfigDir
		notebooksExeDirOverride = oldExeDir
		notebooksMigrationChecked = oldMigrated
	})

	src := filepath.Join(t.TempDir(), "source.tnote")
	note := (&DocumentService{}).NewDocument()
	note.Document.Title = "With Cover"
	note.Thumbnail = "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte{137, 80, 78, 71})
	if err := (&DocumentService{}).SaveNote(src, note); err != nil {
		t.Fatal(err)
	}
	meta, err := (&NotebookService{}).ImportNotebook(src)
	if err != nil {
		t.Fatal(err)
	}
	if meta.CoverType != "custom" {
		t.Fatalf("CoverType = %q, want custom", meta.CoverType)
	}
	if meta.CoverData == "" {
		t.Fatal("CoverData is empty")
	}
}

func TestImportNotebookWithoutThumbnailUsesDefaultEmptyCover(t *testing.T) {
	configDir := t.TempDir()
	oldConfigDir := notebooksConfigDirOverride
	oldExeDir := notebooksExeDirOverride
	oldMigrated := notebooksMigrationChecked
	notebooksConfigDirOverride = configDir
	notebooksExeDirOverride = t.TempDir()
	notebooksMigrationChecked = false
	t.Cleanup(func() {
		notebooksConfigDirOverride = oldConfigDir
		notebooksExeDirOverride = oldExeDir
		notebooksMigrationChecked = oldMigrated
	})

	src := filepath.Join(t.TempDir(), "source.tnote")
	note := (&DocumentService{}).NewDocument()
	note.Document.Title = "Without Cover"
	if err := (&DocumentService{}).SaveNote(src, note); err != nil {
		t.Fatal(err)
	}
	meta, err := (&NotebookService{}).ImportNotebook(src)
	if err != nil {
		t.Fatal(err)
	}
	if meta.CoverType != "default" {
		t.Fatalf("CoverType = %q, want default", meta.CoverType)
	}
	if meta.CoverData != "" {
		t.Fatalf("CoverData = %q, want empty", meta.CoverData)
	}
}
