package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
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

func TestSaveAndOpenNotePackageKeepsGifAssetAndImageGeometry(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "gif.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()
	asset := AssetBlob{
		AssetMeta: AssetMeta{
			ID:       "gif-1",
			Name:     "sparkle.gif",
			Hash:     "gif-hash",
			MimeType: "image/gif",
			Size:     43,
			Path:     "assets/gif-hash.gif",
		},
		DataBase64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
	}
	note.Document.Assets = []AssetMeta{asset.AssetMeta}
	note.Assets = []AssetBlob{asset}
	note.Document.Elements = []NoteElement{
		{
			ID:       "gif-el",
			PageID:   note.Document.Pages[0].ID,
			Type:     "image",
			X:        25,
			Y:        36,
			Width:    128,
			Height:   72,
			Rotation: 15,
			ZIndex:   30,
			AssetID:  asset.ID,
			Style: map[string]interface{}{
				"fit":         "contain",
				"aspectRatio": float64(16) / 9,
			},
		},
	}

	if err := docService.SaveNote(path, note); err != nil {
		t.Fatalf("SaveNote failed: %v", err)
	}

	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	foundGIFEntry := false
	for _, file := range reader.File {
		if file.Name == asset.Path {
			foundGIFEntry = true
			break
		}
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	if !foundGIFEntry {
		t.Fatalf("expected GIF asset entry %q in package", asset.Path)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if len(opened.Assets) != 1 {
		t.Fatalf("assets = %d, want 1", len(opened.Assets))
	}
	if opened.Assets[0].MimeType != "image/gif" {
		t.Fatalf("mime type = %q, want image/gif", opened.Assets[0].MimeType)
	}
	if opened.Assets[0].DataBase64 != asset.DataBase64 {
		t.Fatalf("GIF dataBase64 was not preserved")
	}
	if !strings.HasPrefix(opened.Assets[0].DataURL, "data:image/gif;base64,") {
		t.Fatalf("GIF data URL = %q", opened.Assets[0].DataURL)
	}
	if len(opened.Document.Elements) != 1 {
		t.Fatalf("elements = %d, want 1", len(opened.Document.Elements))
	}
	element := opened.Document.Elements[0]
	if element.Type != "image" || element.AssetID != asset.ID {
		t.Fatalf("GIF element mismatch: %#v", element)
	}
	if element.X != 25 || element.Y != 36 || element.Width != 128 || element.Height != 72 || element.Rotation != 15 || element.ZIndex != 30 {
		t.Fatalf("GIF geometry was not preserved: %#v", element)
	}
}

func TestSaveAndOpenNotePackageKeepsCodeBlock(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "code.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()
	note.Document.Elements = []NoteElement{
		{
			ID:       "code-1",
			PageID:   note.Document.Pages[0].ID,
			Type:     "code",
			X:        42,
			Y:        68,
			Width:    420,
			Height:   240,
			Rotation: 12,
			ZIndex:   20,
			Content:  "const answer: number = 42;",
			Style: map[string]interface{}{
				"language":   "typescript",
				"fontSize":   float64(14),
				"color":      "#d7e2f0",
				"background": "#101828",
			},
		},
	}

	if err := docService.SaveNote(path, note); err != nil {
		t.Fatalf("SaveNote failed: %v", err)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if len(opened.Document.Elements) != 1 {
		t.Fatalf("elements = %d, want 1", len(opened.Document.Elements))
	}
	element := opened.Document.Elements[0]
	if element.Type != "code" || element.Content != "const answer: number = 42;" {
		t.Fatalf("code element mismatch: %#v", element)
	}
	if element.Width != 420 || element.Height != 240 || element.Rotation != 12 {
		t.Fatalf("geometry was not preserved: %#v", element)
	}
	if language, ok := element.Style["language"].(string); !ok || language != "typescript" {
		t.Fatalf("language style = %#v", element.Style["language"])
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
		AppVersion:    "1.0.0",
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

func TestPortableHTMLCodeBlockEscapesContent(t *testing.T) {
	note := (&DocumentService{}).NewDocument()
	note.Document.Elements = []NoteElement{
		{
			ID:       "code-1",
			PageID:   note.Document.Pages[0].ID,
			Type:     "code",
			X:        10,
			Y:        20,
			Width:    320,
			Height:   180,
			Rotation: 0,
			ZIndex:   10,
			Content:  `<script>alert("xss")</script>`,
			Style: map[string]interface{}{
				"language": "html",
			},
		},
	}

	html := renderPortableHTML(note)
	if !strings.Contains(html, `&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;`) {
		t.Fatalf("expected escaped code content in portable HTML:\n%s", html)
	}
	if strings.Contains(html, `<code><script>alert("xss")</script></code>`) {
		t.Fatalf("code content was emitted as executable HTML")
	}
	if !strings.Contains(html, `class="copy-code"`) {
		t.Fatalf("expected copy button in portable HTML")
	}
}
