package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveNoteWritesValidZipPackage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "valid.tnote")
	note := (&DocumentService{}).NewDocument()
	if err := (&DocumentService{}).SaveNote(path, note); err != nil {
		t.Fatal(err)
	}
	if _, err := readNotePackage(path); err != nil {
		t.Fatalf("saved package did not reopen: %v", err)
	}
}

func TestSaveNoteFailureKeepsExistingPackage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keep-old.tnote")
	service := &DocumentService{}
	original := service.NewDocument()
	original.Document.Title = "original"
	if err := service.SaveNote(path, original); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	broken := service.NewDocument()
	broken.Document.Title = "broken"
	broken.Thumbnail = "data:image/png;base64,not-valid-base64"
	if err := service.SaveNote(path, broken); err == nil {
		t.Fatal("SaveNote succeeded with invalid thumbnail, want error")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("failed save changed existing package")
	}
	reopened, err := service.OpenNote(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Document.Title != "original" {
		t.Fatalf("title = %q, want original", reopened.Document.Title)
	}
}

func TestSaveNotePreservesExistingThumbnailWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keep-thumb.tnote")
	service := &DocumentService{}

	// 1x1 PNG
	pngRaw := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
		0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00,
		0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
	}
	withThumb := service.NewDocument()
	withThumb.Document.Title = "with-thumb"
	withThumb.Thumbnail = "data:image/png;base64," + encodeBase64ForTest(pngRaw)
	if err := service.SaveNote(path, withThumb); err != nil {
		t.Fatal(err)
	}

	// Simulate frontend createPackage: empty thumbnail on subsequent saves.
	withoutThumb := service.NewDocument()
	withoutThumb.Document.Title = "updated-title"
	withoutThumb.Thumbnail = ""
	if err := service.SaveNote(path, withoutThumb); err != nil {
		t.Fatal(err)
	}

	reopened, err := service.OpenNote(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Document.Title != "updated-title" {
		t.Fatalf("title = %q, want updated-title", reopened.Document.Title)
	}
	if strings.TrimSpace(reopened.Thumbnail) == "" {
		t.Fatal("thumbnail was cleared by SaveNote with empty thumbnail")
	}
	if !strings.Contains(reopened.Thumbnail, "image/png") {
		t.Fatalf("thumbnail mime unexpected: %q", reopened.Thumbnail)
	}
}

func encodeBase64ForTest(raw []byte) string {
	return base64.StdEncoding.EncodeToString(raw)
}

func TestSaveNoteConvertsJPEGThumbnailToPNG(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "jpeg-thumb.tnote")
	service := &DocumentService{}

	var jpegBuf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	img.Set(1, 0, color.RGBA{G: 255, A: 255})
	img.Set(0, 1, color.RGBA{B: 255, A: 255})
	img.Set(1, 1, color.RGBA{R: 255, G: 255, A: 255})
	if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	jpegRaw := jpegBuf.Bytes()

	note := service.NewDocument()
	note.Document.Title = "jpeg-cover"
	note.Thumbnail = "data:image/jpeg;base64," + encodeBase64ForTest(jpegRaw)
	if err := service.SaveNote(path, note); err != nil {
		t.Fatalf("SaveNote: %v", err)
	}
	reopened, err := service.OpenNote(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reopened.Thumbnail, "image/png") {
		t.Fatalf("thumbnail mime unexpected: %q", reopened.Thumbnail)
	}
	raw, err := decodeDataURL(reopened.Thumbnail)
	if err != nil {
		t.Fatal(err)
	}
	if detectImageMIME(raw) != "image/png" {
		t.Fatalf("expected PNG bytes, got %q", detectImageMIME(raw))
	}

	// Direct helper: already-PNG input stays PNG.
	pngRaw := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
		0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00,
		0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
	}
	out, dataURL, err := thumbnailPNGBytes("data:image/png;base64," + encodeBase64ForTest(pngRaw))
	if err != nil {
		t.Fatal(err)
	}
	if detectImageMIME(out) != "image/png" || !strings.Contains(dataURL, "image/png") {
		t.Fatalf("png passthrough failed: mime=%q url=%q", detectImageMIME(out), dataURL)
	}
}

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
	if opened.Document.Audios == nil {
		t.Fatalf("expected audios slice to be initialized")
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

func TestSaveAndOpenNotePackageKeepsAudioAssetAndMetadata(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "audio.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()
	duration := 12.5
	audio := AssetBlob{
		AssetMeta: AssetMeta{
			ID:              "audio-1",
			Name:            "theme.mp3",
			Hash:            "audio-hash",
			MimeType:        "audio/mpeg",
			Size:            9,
			Path:            "audios/audio-hash.mp3",
			AudioTitle:      "Theme",
			AudioArtist:     "TimeNotes",
			AudioAlbum:      "Sketches",
			Duration:        &duration,
			CoverMimeType:   "image/png",
			CoverDataBase64: "iVBORw0KGgo=",
		},
		DataBase64: "SUQzBAAAAA==",
	}
	note.Document.Audios = []AssetMeta{audio.AssetMeta}
	note.Audios = []AssetBlob{audio}
	note.Document.Elements = []NoteElement{
		{
			ID:       "audio-el",
			PageID:   note.Document.Pages[0].ID,
			Type:     "audio",
			X:        32,
			Y:        48,
			Width:    360,
			Height:   96,
			Rotation: -8,
			ZIndex:   40,
			AssetID:  audio.ID,
			Style: map[string]interface{}{
				"audioTheme": "dark",
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
	foundAudioEntry := false
	for _, file := range reader.File {
		if file.Name == audio.Path {
			foundAudioEntry = true
			break
		}
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	if !foundAudioEntry {
		t.Fatalf("expected audio entry %q in package", audio.Path)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if len(opened.Audios) != 1 {
		t.Fatalf("audios = %d, want 1", len(opened.Audios))
	}
	if opened.Audios[0].DataBase64 != audio.DataBase64 {
		t.Fatalf("audio dataBase64 was not preserved")
	}
	if !strings.HasPrefix(opened.Audios[0].DataURL, "data:audio/mpeg;base64,") {
		t.Fatalf("audio data URL = %q", opened.Audios[0].DataURL)
	}
	if opened.Document.Audios[0].AudioTitle != "Theme" || opened.Document.Audios[0].AudioArtist != "TimeNotes" {
		t.Fatalf("audio metadata was not preserved: %#v", opened.Document.Audios[0])
	}
	if opened.Document.Audios[0].Duration == nil || *opened.Document.Audios[0].Duration != duration {
		t.Fatalf("audio duration = %#v", opened.Document.Audios[0].Duration)
	}
	if len(opened.Document.Elements) != 1 {
		t.Fatalf("elements = %d, want 1", len(opened.Document.Elements))
	}
	element := opened.Document.Elements[0]
	if element.Type != "audio" || element.AssetID != audio.ID {
		t.Fatalf("audio element mismatch: %#v", element)
	}
	if element.X != 32 || element.Y != 48 || element.Width != 360 || element.Height != 96 || element.Rotation != -8 || element.ZIndex != 40 {
		t.Fatalf("audio geometry was not preserved: %#v", element)
	}
}

func TestSaveAndOpenNotePackageKeepsVideoAssetAndMetadata(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "video.tnote")
	docService := &DocumentService{}
	note := docService.NewDocument()
	duration := 15.0
	videoWidth := 1280.0
	videoHeight := 720.0
	video := AssetBlob{
		AssetMeta: AssetMeta{
			ID:              "video-1",
			Name:            "demo.mp4",
			Hash:            "video-hash",
			MimeType:        "video/mp4",
			Size:            1024,
			Path:            "videos/video-hash.mp4",
			Duration:        &duration,
			VideoWidth:      &videoWidth,
			VideoHeight:     &videoHeight,
			CoverMimeType:   "image/jpeg",
			CoverDataBase64: "/9j/4AAQ=",
		},
		DataBase64: "AAAAIGZ0",
	}
	note.Document.Videos = []AssetMeta{video.AssetMeta}
	note.Videos = []AssetBlob{video}
	note.Document.Elements = []NoteElement{
		{
			ID:       "video-el",
			PageID:   note.Document.Pages[0].ID,
			Type:     "video",
			X:        64,
			Y:        96,
			Width:    640,
			Height:   360,
			Rotation: 0,
			ZIndex:   20,
			AssetID:  video.ID,
			Style: map[string]interface{}{
				"videoTheme": "dark",
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
	foundVideoEntry := false
	for _, file := range reader.File {
		if file.Name == video.Path {
			foundVideoEntry = true
			break
		}
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	if !foundVideoEntry {
		t.Fatalf("expected video entry %q in package", video.Path)
	}

	opened, err := docService.OpenNote(path)
	if err != nil {
		t.Fatalf("OpenNote failed: %v", err)
	}
	if len(opened.Videos) != 1 {
		t.Fatalf("videos = %d, want 1", len(opened.Videos))
	}
	if opened.Videos[0].DataBase64 != video.DataBase64 {
		t.Fatalf("video dataBase64 was not preserved")
	}
	if !strings.HasPrefix(opened.Videos[0].DataURL, "data:video/mp4;base64,") {
		t.Fatalf("video data URL = %q", opened.Videos[0].DataURL)
	}
	if opened.Document.Videos[0].Duration == nil || *opened.Document.Videos[0].Duration != duration {
		t.Fatalf("video duration = %#v", opened.Document.Videos[0].Duration)
	}
	if opened.Document.Videos[0].VideoWidth == nil || *opened.Document.Videos[0].VideoWidth != videoWidth {
		t.Fatalf("video width = %#v", opened.Document.Videos[0].VideoWidth)
	}
	if opened.Document.Videos[0].VideoHeight == nil || *opened.Document.Videos[0].VideoHeight != videoHeight {
		t.Fatalf("video height = %#v", opened.Document.Videos[0].VideoHeight)
	}
	if len(opened.Document.Elements) != 1 {
		t.Fatalf("elements = %d, want 1", len(opened.Document.Elements))
	}
	element := opened.Document.Elements[0]
	if element.Type != "video" || element.AssetID != video.ID {
		t.Fatalf("video element mismatch: %#v", element)
	}
	if element.X != 64 || element.Y != 96 || element.Width != 640 || element.Height != 360 {
		t.Fatalf("video geometry was not preserved: %#v", element)
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

func TestPortableHTMLIncludesAudioPlayer(t *testing.T) {
	duration := 3.25
	note := (&DocumentService{}).NewDocument()
	audio := AssetBlob{
		AssetMeta: AssetMeta{
			ID:              "audio-1",
			Name:            "demo.ogg",
			Hash:            "audio-hash",
			MimeType:        "audio/ogg",
			Size:            7,
			Path:            "audios/audio-hash.ogg",
			AudioTitle:      "Demo Tune",
			AudioArtist:     "TimeNotes",
			Duration:        &duration,
			CoverMimeType:   "image/jpeg",
			CoverDataBase64: "/9j/2w==",
		},
		DataBase64: "T2dnUw==",
		DataURL:    "data:audio/ogg;base64,T2dnUw==",
	}
	note.Document.Audios = []AssetMeta{audio.AssetMeta}
	note.Audios = []AssetBlob{audio}
	note.Document.Elements = []NoteElement{
		{
			ID:      "audio-el",
			PageID:  note.Document.Pages[0].ID,
			Type:    "audio",
			X:       10,
			Y:       20,
			Width:   320,
			Height:  92,
			ZIndex:  10,
			AssetID: audio.ID,
		},
	}

	html := renderPortableHTML(note)
	if !strings.Contains(html, `class="note-element audio-player"`) {
		t.Fatalf("expected audio player in portable HTML:\n%s", html)
	}
	if !strings.Contains(html, `<audio controls preload="metadata" src="data:audio/ogg;base64,T2dnUw=="></audio>`) {
		t.Fatalf("expected audio tag with data URL")
	}
	if !strings.Contains(html, `Demo Tune`) || !strings.Contains(html, `data:image/jpeg;base64,/9j/2w==`) {
		t.Fatalf("expected audio title and cover in portable HTML")
	}
}
