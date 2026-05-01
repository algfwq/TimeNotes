package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndOpenNotePackage(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "sample.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()

	if err := docService.SaveNote(path, note); err != nil {
		t.Fatalf("SaveNote failed: %v", err)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if opened.Manifest.FormatVersion != currentFormatVersion {
		t.Fatalf("format version = %d", opened.Manifest.FormatVersion)
	}
	if opened.Document.Title != note.Document.Title {
		t.Fatalf("title = %q, want %q", opened.Document.Title, note.Document.Title)
	}
	if len(opened.Document.Elements) != 0 {
		t.Fatalf("new document should be blank, got %d elements", len(opened.Document.Elements))
	}
	if opened.Document.Stickers == nil {
		t.Fatalf("expected stickers slice to be initialized")
	}
}

func TestSaveAndOpenNotePackageKeepsAssetBlobs(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "asset.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()
	asset := AssetBlob{
		AssetMeta: AssetMeta{
			ID:       "asset-1",
			Name:     "sticker.svg",
			Hash:     "hash-1",
			MimeType: "image/svg+xml",
			Size:     11,
			Path:     "assets/hash-1.svg",
		},
		DataBase64: "PHN2Zz48L3N2Zz4=",
	}
	note.Document.Assets = []AssetMeta{asset.AssetMeta}
	note.Assets = []AssetBlob{asset}
	cropX, cropY := 35.0, 65.0
	note.Document.Pages[0].BackgroundAssetID = asset.ID
	note.Document.Pages[0].BackgroundFit = "cover"
	note.Document.Pages[0].BackgroundCropX = &cropX
	note.Document.Pages[0].BackgroundCropY = &cropY

	if err := docService.SaveNote(path, note); err != nil {
		t.Fatalf("SaveNote failed: %v", err)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if len(opened.Assets) != 1 {
		t.Fatalf("assets = %d, want 1", len(opened.Assets))
	}
	if opened.Assets[0].DataBase64 != asset.DataBase64 {
		t.Fatalf("asset dataBase64 = %q", opened.Assets[0].DataBase64)
	}
	if opened.Assets[0].DataURL == "" {
		t.Fatalf("expected asset data URL")
	}
	if opened.Document.Pages[0].BackgroundAssetID != asset.ID {
		t.Fatalf("background asset id = %q", opened.Document.Pages[0].BackgroundAssetID)
	}
	if opened.Document.Pages[0].BackgroundCropX == nil || *opened.Document.Pages[0].BackgroundCropX != cropX {
		t.Fatalf("background crop x = %#v", opened.Document.Pages[0].BackgroundCropX)
	}
}

func TestOpenVersionOneNoteMigratesToCurrentFormat(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "v1.tnote")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(file)
	manifest := NoteManifest{
		FormatVersion: 1,
		AppVersion:    "0.1.0",
		Title:         "旧版文件",
		CreatedAt:     "2026-05-01T00:00:00Z",
		UpdatedAt:     "2026-05-01T00:00:00Z",
		DocumentPath:  "document.json",
		YjsStatePath:  "yjs/update.bin",
	}
	doc := seedDocument("2026-05-01T00:00:00Z")
	doc.FormatVersion = 1
	if err := writeJSON(zw, "manifest.json", manifest); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(zw, "document.json", doc); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	opened, err := (&DocumentService{}).OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if opened.Document.FormatVersion != currentFormatVersion {
		t.Fatalf("format version = %d", opened.Document.FormatVersion)
	}
	if opened.Document.Pages[0].Background == "" {
		t.Fatalf("expected migrated page background")
	}
}

func TestOpenNoteRejectsUnsafeArchiveEntry(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "bad.tnote")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(file)
	if _, err := zw.Create("../escape.txt"); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := (&DocumentService{}).OpenNote(path); err == nil {
		t.Fatalf("expected unsafe archive error")
	}
}
