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

func TestEnsureNotebookPackageThumbnailWritesCoverData(t *testing.T) {
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

	pngRaw := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
		0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00,
		0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
	}
	coverData := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngRaw)

	path := filepath.Join(t.TempDir(), "note.tnote")
	note := (&DocumentService{}).NewDocument()
	note.Document.Title = "needs-cover"
	if err := (&DocumentService{}).SaveNote(path, note); err != nil {
		t.Fatal(err)
	}
	opened, err := (&DocumentService{}).OpenNote(path)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Thumbnail != "" {
		t.Fatal("fixture package unexpectedly has thumbnail")
	}

	meta := NotebookMeta{
		ID:        "1",
		Name:      "needs-cover",
		Path:      path,
		IsManaged: true,
		CoverType: "custom",
		CoverData: coverData,
	}
	if err := ensureNotebookPackageThumbnail(meta); err != nil {
		t.Fatalf("ensureNotebookPackageThumbnail: %v", err)
	}
	reopened, err := (&DocumentService{}).OpenNote(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Thumbnail == "" {
		t.Fatal("expected thumbnail to be written from CoverData")
	}

	// Second call should be a no-op once package already has thumbnail.
	if err := ensureNotebookPackageThumbnail(meta); err != nil {
		t.Fatalf("second ensure failed: %v", err)
	}
}

func TestEnsureNotebookPackageThumbnailRequiresCover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.tnote")
	note := (&DocumentService{}).NewDocument()
	if err := (&DocumentService{}).SaveNote(path, note); err != nil {
		t.Fatal(err)
	}
	meta := NotebookMeta{
		ID:        "1",
		Name:      "no-cover",
		Path:      path,
		IsManaged: true,
		CoverType: "default",
		CoverData: "",
	}
	err := ensureNotebookPackageThumbnail(meta)
	if err == nil || err.Error() != "thumbnail_required" {
		t.Fatalf("error = %v, want thumbnail_required", err)
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
