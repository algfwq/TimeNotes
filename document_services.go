package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	currentFormatVersion = 6
	currentAppVersion    = "2.0.0"
)

// DocumentService 暴露给前端负责 .tnote 的新建、打开和保存；这里不掺入 UI 状态。
type DocumentService struct{}

// AssetService 只处理本机文件读取和系统字体枚举，前端负责决定这些资源放到哪个面板。
type AssetService struct{}

// ExportService 保留只读导出能力，后续若恢复按钮也不需要改动文档保存路径。
type ExportService struct{}

func (s *DocumentService) NewDocument() NotePackage {
	now := time.Now().UTC().Format(time.RFC3339)
	doc := seedDocument(now)
	logEvent("info", "document_new", map[string]interface{}{"title": doc.Title, "pages": len(doc.Pages), "elements": len(doc.Elements)})
	return packageFromDocument(doc, nil, nil, nil, nil, nil, "")
}

func (s *DocumentService) OpenNote(path string) (NotePackage, error) {
	// 打开文件时先经过 ZIP 安全校验，再把素材内容补成 data URL 返回给前端渲染。
	note, err := readNotePackage(path)
	if err != nil {
		logEvent("error", "document_open_failed", map[string]interface{}{"path": path, "error": err.Error()})
		return NotePackage{}, err
	}
	logEvent("info", "document_opened", map[string]interface{}{
		"path":     path,
		"title":    note.Document.Title,
		"pages":    len(note.Document.Pages),
		"elements": len(note.Document.Elements),
		"assets":   len(note.Assets),
		"stickers": len(note.Stickers),
		"audios":   len(note.Audios),
		"videos":   len(note.Videos),
	})
	return note, nil
}

func (s *DocumentService) SaveNote(path string, note NotePackage) error {
	// 前端传入的是完整包结构，后端只负责格式归一化和 ZIP 写入，不自行重建文档状态。
	if strings.TrimSpace(path) == "" {
		return errors.New("save path is required")
	}
	note.normalize()
	if err := writeNotePackage(path, note); err != nil {
		logEvent("error", "document_save_failed", map[string]interface{}{"path": path, "error": err.Error()})
		return err
	}
	logEvent("info", "document_saved", map[string]interface{}{
		"path":     path,
		"title":    note.Document.Title,
		"pages":    len(note.Document.Pages),
		"elements": len(note.Document.Elements),
		"assets":   len(note.Assets),
		"stickers": len(note.Stickers),
		"audios":   len(note.Audios),
		"videos":   len(note.Videos),
	})
	return nil
}

func (s *DocumentService) GetAppDataDir() (string, error) {
	// 这个目录用于后续保存应用级配置；当前 .tnote 文件仍由用户显式选择路径。
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "TimeNotes")
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func (s *AssetService) ImportAssets(paths []string) ([]AssetBlob, error) {
	// 普通素材默认写入 ZIP 的 assets/ 目录；字体不要走这个入口，否则会被当成图片素材。
	assets := make([]AssetBlob, 0, len(paths))
	for _, path := range paths {
		asset, err := readAsset(path, "assets")
		if err != nil {
			logEvent("error", "asset_import_failed", map[string]interface{}{"path": path, "error": err.Error()})
			return nil, err
		}
		assets = append(assets, asset)
	}
	logEvent("info", "assets_imported", map[string]interface{}{"count": len(assets)})
	return assets, nil
}

func (s *AssetService) ImportFonts(paths []string) ([]AssetBlob, error) {
	// 系统字体和手动导入字体都走 fonts/ 目录，前端会用 @font-face 让其他设备也能显示。
	fonts := make([]AssetBlob, 0, len(paths))
	for _, path := range paths {
		font, err := readAsset(path, "fonts")
		if err != nil {
			logEvent("error", "font_import_failed", map[string]interface{}{"path": path, "error": err.Error()})
			return nil, err
		}
		fonts = append(fonts, font)
	}
	logEvent("info", "fonts_imported", map[string]interface{}{"count": len(fonts)})
	return fonts, nil
}

func (s *AssetService) ImportAudios(paths []string) ([]AssetBlob, error) {
	// 音频素材使用 audios/ 目录；封面和标题等 metadata 由前端解析后写入 AssetMeta。
	audios := make([]AssetBlob, 0, len(paths))
	for _, path := range paths {
		audio, err := readAsset(path, "audios")
		if err != nil {
			logEvent("error", "audio_import_failed", map[string]interface{}{"path": path, "error": err.Error()})
			return nil, err
		}
		audios = append(audios, audio)
	}
	logEvent("info", "audios_imported", map[string]interface{}{"count": len(audios)})
	return audios, nil
}

func (s *AssetService) ImportVideos(paths []string) ([]AssetBlob, error) {
	videos := make([]AssetBlob, 0, len(paths))
	for _, path := range paths {
		video, err := readAsset(path, "videos")
		if err != nil {
			logEvent("error", "video_import_failed", map[string]interface{}{"path": path, "error": err.Error()})
			return nil, err
		}
		videos = append(videos, video)
	}
	logEvent("info", "videos_imported", map[string]interface{}{"count": len(videos)})
	return videos, nil
}

func (s *AssetService) GetSystemFonts() []SystemFont {
	// 这里只扫描常见系统字体目录并返回路径，不提前读取字体二进制，避免打开右侧面板时阻塞。
	fonts := listSystemFonts()
	logEvent("info", "system_fonts_listed", map[string]interface{}{"count": len(fonts)})
	return fonts
}

func (s *ExportService) ExportPortableHTML(path string, note NotePackage) error {
	// HTML 导出是只读浏览用，仍然把资源内联进去，保证离线打开不缺图。
	if strings.TrimSpace(path) == "" {
		return errors.New("export path is required")
	}
	note.normalize()
	if err := os.WriteFile(path, []byte(renderPortableHTML(note)), 0o644); err != nil {
		logEvent("error", "html_export_failed", map[string]interface{}{"path": path, "error": err.Error()})
		return err
	}
	logEvent("info", "html_exported", map[string]interface{}{"path": path})
	return nil
}

func (s *ExportService) ExportPageImage(path string, dataURL string) error {
	// 页面图片由前端按当前视觉结果栅格化，后端只负责安全地落盘。
	if strings.TrimSpace(path) == "" {
		return errors.New("export path is required")
	}
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 || !strings.Contains(parts[0], "base64") {
		return errors.New("page image must be a base64 data URL")
	}
	raw, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("decode image data: %w", err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		logEvent("error", "page_image_export_failed", map[string]interface{}{"path": path, "error": err.Error()})
		return err
	}
	logEvent("info", "page_image_exported", map[string]interface{}{"path": path})
	return nil
}

func (note *NotePackage) normalize() {
	now := time.Now().UTC().Format(time.RFC3339)
	// 保存入口统一写当前格式版本，避免前端从旧包打开后再次保存仍带旧版本号。
	note.Document.FormatVersion = currentFormatVersion
	if note.Document.CreatedAt == "" {
		note.Document.CreatedAt = now
	}
	note.Document.UpdatedAt = now
	if note.Document.Title == "" {
		note.Document.Title = "未命名手账"
	}
	if note.Document.Pages == nil {
		note.Document.Pages = []NotePage{}
	}
	if note.Document.Elements == nil {
		note.Document.Elements = []NoteElement{}
	}
	if note.Document.Assets == nil {
		note.Document.Assets = []AssetMeta{}
	}
	if note.Document.Fonts == nil {
		note.Document.Fonts = []AssetMeta{}
	}
	if note.Document.Audios == nil {
		note.Document.Audios = []AssetMeta{}
	}
	if note.Document.Videos == nil {
		note.Document.Videos = []AssetMeta{}
	}
	if note.Document.Stickers == nil {
		note.Document.Stickers = []AssetMeta{}
	}
	if note.Document.Templates == nil {
		note.Document.Templates = []TemplateDef{}
	}
	// Manifest 只保留资源索引和内部路径；二进制内容由包顶层 Blob 列表写入 ZIP。
	note.Manifest = NoteManifest{
		FormatVersion: currentFormatVersion,
		AppVersion:    currentAppVersion,
		Title:         note.Document.Title,
		CreatedAt:     note.Document.CreatedAt,
		UpdatedAt:     note.Document.UpdatedAt,
		DocumentPath:  "document.json",
		YjsStatePath:  "yjs/update.bin",
		Assets:        note.Document.Assets,
		Stickers:      note.Document.Stickers,
		Fonts:         note.Document.Fonts,
		Audios:        note.Document.Audios,
		Videos:        note.Document.Videos,
	}
}

func packageFromDocument(doc NoteDocument, assets []AssetBlob, stickers []AssetBlob, fonts []AssetBlob, audios []AssetBlob, videos []AssetBlob, yjsState string) NotePackage {
	// 内存里先拼成 NotePackage，再复用 normalize，避免新建和保存两条路径产生格式差异。
	note := NotePackage{
		Document: doc,
		YjsState: yjsState,
		Assets:   assets,
		Stickers: stickers,
		Fonts:    fonts,
		Audios:   audios,
		Videos:   videos,
	}
	note.normalize()
	return note
}

func readAsset(path string, group string) (AssetBlob, error) {
	// 所有导入资源按内容哈希命名，重复导入相同文件时能自然去重。
	cleaned := filepath.Clean(path)
	raw, err := os.ReadFile(cleaned)
	if err != nil {
		return AssetBlob{}, err
	}
	hash := sha256.Sum256(raw)
	hashString := hex.EncodeToString(hash[:])
	ext := strings.ToLower(filepath.Ext(cleaned))
	mimeType := detectAssetMimeType(filepath.Base(cleaned), cleaned)
	encoded := base64.StdEncoding.EncodeToString(raw)
	return AssetBlob{
		AssetMeta: AssetMeta{
			ID:       hashString[:16],
			Name:     filepath.Base(cleaned),
			Hash:     hashString,
			MimeType: mimeType,
			Size:     int64(len(raw)),
			Path:     assetArchivePath(group, hashString, ext),
		},
		DataBase64: encoded,
		DataURL:    "data:" + mimeType + ";base64," + encoded,
	}, nil
}

func listSystemFonts() []SystemFont {
	dirs := []string{}
	if windir := os.Getenv("WINDIR"); windir != "" {
		dirs = append(dirs, filepath.Join(windir, "Fonts"))
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		dirs = append(dirs, filepath.Join(localAppData, "Microsoft", "Windows", "Fonts"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs,
			filepath.Join(home, "AppData", "Local", "Microsoft", "Windows", "Fonts"),
			filepath.Join(home, ".local", "share", "fonts"),
			filepath.Join(home, "Library", "Fonts"),
		)
	}
	dirs = append(dirs, "/Library/Fonts", "/System/Library/Fonts", "/usr/share/fonts", "/usr/local/share/fonts")

	seen := map[string]bool{}
	fonts := []SystemFont{}
	for _, dir := range dirs {
		collectFontsFromDir(dir, seen, &fonts)
	}
	sort.SliceStable(fonts, func(i, j int) bool {
		if fonts[i].Family == fonts[j].Family {
			return fonts[i].Path < fonts[j].Path
		}
		return fonts[i].Family < fonts[j].Family
	})
	if len(fonts) > 500 {
		return fonts[:500]
	}
	return fonts
}

func collectFontsFromDir(dir string, seen map[string]bool, fonts *[]SystemFont) {
	// WalkDir 只记录字体文件路径，不读取字体内容；用户真正选择字体时才导入二进制。
	if dir == "" {
		return
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return
	}
	_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return nil
		}
		if len(*fonts) >= 500 {
			return filepath.SkipAll
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".ttf" && ext != ".otf" && ext != ".woff" && ext != ".woff2" {
			return nil
		}
		cleaned := filepath.Clean(path)
		key := strings.ToLower(cleaned)
		if seen[key] {
			return nil
		}
		seen[key] = true
		*fonts = append(*fonts, SystemFont{
			Name:   entry.Name(),
			Family: fontFamilyFromFileName(entry.Name()),
			Path:   cleaned,
		})
		return nil
	})
}

func fontFamilyFromFileName(name string) string {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	base = strings.NewReplacer("_", " ", "-", " ").Replace(base)
	for _, suffix := range []string{" Regular", " Bold", " Italic", " Oblique", " Medium", " Light", " Semibold", " SemiBold", " Black", " Thin"} {
		base = strings.TrimSuffix(base, suffix)
	}
	return strings.TrimSpace(base)
}

func writeNotePackage(path string, note NotePackage) error {
	// 写包使用 zip.Writer 顺序写入 Manifest、文档 JSON、Yjs 状态和资源文件。
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	zw := zip.NewWriter(file)
	defer zw.Close()

	if err := writeJSON(zw, "manifest.json", note.Manifest); err != nil {
		return err
	}
	if err := writeJSON(zw, "document.json", note.Document); err != nil {
		return err
	}
	if note.YjsState != "" {
		raw, err := base64.StdEncoding.DecodeString(note.YjsState)
		if err != nil {
			return fmt.Errorf("decode Yjs state: %w", err)
		}
		if err := writeFile(zw, "yjs/update.bin", raw); err != nil {
			return err
		}
	}
	for _, asset := range note.Assets {
		if err := writeAssetBlob(zw, "assets", asset); err != nil {
			return err
		}
	}
	for _, sticker := range note.Stickers {
		if err := writeAssetBlob(zw, "stickers", sticker); err != nil {
			return err
		}
	}
	for _, font := range note.Fonts {
		if err := writeAssetBlob(zw, "fonts", font); err != nil {
			return err
		}
	}
	for _, audio := range note.Audios {
		if err := writeAssetBlob(zw, "audios", audio); err != nil {
			return err
		}
	}
	for _, video := range note.Videos {
		if err := writeAssetBlob(zw, "videos", video); err != nil {
			return err
		}
	}
	if note.Thumbnail != "" {
		if raw, err := decodeDataURL(note.Thumbnail); err == nil {
			if err := writeFile(zw, "thumbnail.png", raw); err != nil {
				return err
			}
		}
	}
	return nil
}

func readNotePackage(path string) (NotePackage, error) {
	// 读取外部 ZIP 时任何条目名都不可信，必须先归一化并拒绝路径穿越。
	reader, err := zip.OpenReader(path)
	if err != nil {
		return NotePackage{}, err
	}
	defer reader.Close()

	files := map[string]*zip.File{}
	for _, file := range reader.File {
		name, err := safeArchiveName(file.Name)
		if err != nil {
			return NotePackage{}, err
		}
		files[name] = file
	}

	var manifest NoteManifest
	if err := readJSON(files, "manifest.json", &manifest); err != nil {
		return NotePackage{}, err
	}
	if manifest.FormatVersion < 1 || manifest.FormatVersion > currentFormatVersion {
		return NotePackage{}, fmt.Errorf("unsupported .tnote format version %d", manifest.FormatVersion)
	}

	var doc NoteDocument
	documentPath := manifest.DocumentPath
	if documentPath == "" {
		documentPath = "document.json"
	}
	if err := readJSON(files, documentPath, &doc); err != nil {
		return NotePackage{}, err
	}
	// 旧版文件读入后升级到当前内存模型，保存时会写回当前格式版本。
	migrateDocument(&doc, manifest.FormatVersion)
	if len(doc.Assets) == 0 && len(manifest.Assets) > 0 {
		doc.Assets = manifest.Assets
	}
	if len(doc.Stickers) == 0 && len(manifest.Stickers) > 0 {
		doc.Stickers = manifest.Stickers
	}
	if len(doc.Fonts) == 0 && len(manifest.Fonts) > 0 {
		doc.Fonts = manifest.Fonts
	}
	if len(doc.Audios) == 0 && len(manifest.Audios) > 0 {
		doc.Audios = manifest.Audios
	}
	if len(doc.Videos) == 0 && len(manifest.Videos) > 0 {
		doc.Videos = manifest.Videos
	}

	var yjsState string
	if manifest.YjsStatePath != "" {
		if raw, err := readFile(files, manifest.YjsStatePath); err == nil {
			yjsState = base64.StdEncoding.EncodeToString(raw)
		}
	}

	assets, warnings := readAssetBlobs(files, manifest.Assets)
	stickers, stickerWarnings := readAssetBlobs(files, manifest.Stickers)
	fonts, fontWarnings := readAssetBlobs(files, manifest.Fonts)
	audios, audioWarnings := readAssetBlobs(files, manifest.Audios)
	videos, videoWarnings := readAssetBlobs(files, manifest.Videos)
	warnings = append(warnings, stickerWarnings...)
	warnings = append(warnings, fontWarnings...)
	warnings = append(warnings, audioWarnings...)
	warnings = append(warnings, videoWarnings...)
	thumbnail := ""
	if raw, err := readFile(files, "thumbnail.png"); err == nil {
		thumbnail = "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	}

	note := NotePackage{
		Manifest:  manifest,
		Document:  doc,
		YjsState:  yjsState,
		Assets:    assets,
		Stickers:  stickers,
		Fonts:     fonts,
		Audios:    audios,
		Videos:    videos,
		Thumbnail: thumbnail,
		Warnings:  warnings,
	}
	note.normalize()
	return note, nil
}

func writeJSON(zw *zip.Writer, name string, value interface{}) error {
	// JSON 使用缩进格式，方便排查用户提供的 .tnote 包内部结构。
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(zw, name, raw)
}

func writeFile(zw *zip.Writer, name string, raw []byte) error {
	// ZIP 内部统一使用正斜杠路径，保证 Windows/macOS/Linux 都能读取。
	header := &zip.FileHeader{Name: filepath.ToSlash(name), Method: zip.Deflate}
	header.SetModTime(time.Now())
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = writer.Write(raw)
	return err
}

func writeAssetBlob(zw *zip.Writer, group string, asset AssetBlob) error {
	// 所有图片、贴纸、字体和背景图都按内容写入 ZIP，文档内不得保留本机绝对路径。
	raw, err := base64.StdEncoding.DecodeString(asset.DataBase64)
	if err != nil {
		return fmt.Errorf("decode asset %s: %w", asset.Name, err)
	}
	ext := strings.ToLower(filepath.Ext(asset.Name))
	if ext == "" {
		ext = extensionForMimeType(asset.MimeType)
	}
	path := asset.Path
	if path == "" {
		path = assetArchivePath(group, asset.Hash, ext)
	}
	return writeFile(zw, path, raw)
}

func readJSON(files map[string]*zip.File, name string, value interface{}) error {
	// readJSON 复用 readFile，因此同样会经过安全路径校验。
	raw, err := readFile(files, name)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, value)
}

func readFile(files map[string]*zip.File, name string) ([]byte, error) {
	// 先把传入路径转换成安全归档名，再从预先校验过的文件表读取。
	safeName, err := safeArchiveName(name)
	if err != nil {
		return nil, err
	}
	file, ok := files[safeName]
	if !ok {
		return nil, fmt.Errorf("missing archive entry %s", safeName)
	}
	rc, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var buffer bytes.Buffer
	if _, err := io.Copy(&buffer, rc); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func readAssetBlobs(files map[string]*zip.File, metas []AssetMeta) ([]AssetBlob, []ServiceNote) {
	// 资源缺失不直接让文档打不开，而是通过 warnings 告诉前端哪些素材丢失。
	assets := make([]AssetBlob, 0, len(metas))
	warnings := []ServiceNote{}
	for _, meta := range metas {
		raw, err := readFile(files, meta.Path)
		if err != nil {
			warnings = append(warnings, ServiceNote{Code: "asset_missing", Message: meta.Name + " was not found in the package"})
			continue
		}
		mimeType := meta.MimeType
		if mimeType == "" {
			mimeType = detectAssetMimeType(meta.Name, meta.Path)
			meta.MimeType = mimeType
		}
		encoded := base64.StdEncoding.EncodeToString(raw)
		assets = append(assets, AssetBlob{
			AssetMeta:  meta,
			DataBase64: encoded,
			DataURL:    "data:" + mimeType + ";base64," + encoded,
		})
	}
	return assets, warnings
}

func migrateDocument(doc *NoteDocument, fromVersion int) {
	// 迁移只补结构字段，不猜测用户意图，也不重排已有元素。
	if fromVersion < 2 {
		for index := range doc.Pages {
			if doc.Pages[index].Background == "" {
				doc.Pages[index].Background = "#fffaf0"
			}
		}
	}
	if fromVersion < 3 && doc.Stickers == nil {
		// v3 才有独立贴纸资源池；旧文档保持原有元素不动，只补一个空列表。
		doc.Stickers = []AssetMeta{}
	}
	if fromVersion < 5 && doc.Audios == nil {
		// v5 增加独立音频素材池；旧文档只补空列表。
		doc.Audios = []AssetMeta{}
	}
	if fromVersion < 6 && doc.Videos == nil {
		// v6 增加独立视频素材池和视频元素类型。
		doc.Videos = []AssetMeta{}
	}
	doc.FormatVersion = currentFormatVersion
}

func safeArchiveName(name string) (string, error) {
	// 这里同时拦截绝对路径和 ../，防止恶意 .tnote 写出应用目录。
	name = filepath.ToSlash(strings.TrimSpace(name))
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "../") || strings.Contains(name, "..\\") || name == ".." {
		return "", fmt.Errorf("unsafe archive entry %q", name)
	}
	cleaned := filepath.ToSlash(filepath.Clean(name))
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", fmt.Errorf("unsafe archive entry %q", name)
	}
	return cleaned, nil
}

func assetArchivePath(group string, hash string, ext string) string {
	// group 决定资源所在目录：assets、stickers、fonts 或 audios；hash 决定文件名稳定性。
	if hash == "" {
		hash = "asset"
	}
	if ext == "" {
		ext = ".bin"
	}
	return filepath.ToSlash(filepath.Join(group, hash+ext))
}

func detectAssetMimeType(name string, path string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = strings.ToLower(filepath.Ext(path))
	}
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return mimeType
	}
	switch ext {
	case ".gif":
		return "image/gif"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".wav":
		return "audio/wav"
	case ".ogg", ".oga", ".opus":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".webm":
		return "audio/webm"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".avi":
		return "video/x-msvideo"
	case ".mkv":
		return "video/x-matroska"
	case ".wmv":
		return "video/x-ms-wmv"
	default:
		return "application/octet-stream"
	}
}

func extensionForMimeType(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/gif":
		return ".gif"
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/mp4", "audio/x-m4a":
		return ".m4a"
	case "audio/aac":
		return ".aac"
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	case "audio/ogg", "application/ogg":
		return ".ogg"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/webm":
		return ".webm"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/ogg":
		return ".ogg"
	case "video/quicktime":
		return ".mov"
	case "video/x-msvideo":
		return ".avi"
	case "video/x-matroska":
		return ".mkv"
	case "video/x-ms-wmv":
		return ".wmv"
	default:
		return ".bin"
	}
}

func decodeDataURL(value string) ([]byte, error) {
	// 前端导出的图片通常是 data URL，这里只取逗号后的 base64 部分。
	parts := strings.SplitN(value, ",", 2)
	if len(parts) != 2 {
		return nil, errors.New("invalid data URL")
	}
	return base64.StdEncoding.DecodeString(parts[1])
}

func cropValue(value *float64) float64 {
	// 背景裁剪坐标缺省时居中显示。
	if value == nil {
		return 50
	}
	return *value
}

func portableTextStyle(style map[string]interface{}) string {
	var builder strings.Builder
	appendCSSString(&builder, "background", styleStringValue(style, "background"))
	appendCSSString(&builder, "color", styleStringValue(style, "color"))
	appendCSSString(&builder, "font-family", styleStringValue(style, "fontFamily"))
	appendCSSString(&builder, "--timenotes-text-font-family", styleStringValue(style, "fontFamily"))
	appendCSSString(&builder, "--timenotes-inline-code-color", styleStringValue(style, "inlineCodeColor"))
	appendCSSString(&builder, "--timenotes-inline-code-font-family", styleStringValue(style, "inlineCodeFontFamily"))
	appendCSSString(&builder, "--timenotes-blockquote-color", styleStringValue(style, "blockquoteColor"))
	appendCSSString(&builder, "--timenotes-blockquote-font-family", styleStringValue(style, "blockquoteFontFamily"))
	appendCSSString(&builder, "border-color", styleStringValue(style, "borderColor"))
	appendCSSString(&builder, "border-style", styleStringValue(style, "borderStyle"))
	if value, ok := styleNumberValue(style, "fontSize"); ok {
		appendCSSNumber(&builder, "font-size", value, "px")
	}
	if value, ok := styleNumberValue(style, "borderWidth"); ok {
		appendCSSNumber(&builder, "border-width", value, "px")
	}
	if value, ok := styleNumberValue(style, "borderRadius"); ok {
		appendCSSNumber(&builder, "border-radius", value, "px")
	}
	return builder.String()
}

func styleStringValue(style map[string]interface{}, key string) string {
	if style == nil {
		return ""
	}
	value, ok := style[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func styleNumberValue(style map[string]interface{}, key string) (float64, bool) {
	if style == nil {
		return 0, false
	}
	switch value := style[key].(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case json.Number:
		number, err := value.Float64()
		return number, err == nil
	default:
		return 0, false
	}
}

func appendCSSString(builder *strings.Builder, property string, value string) {
	if value == "" {
		return
	}
	value = strings.ReplaceAll(value, ";", "")
	builder.WriteString(property)
	builder.WriteByte(':')
	builder.WriteString(html.EscapeString(value))
	builder.WriteByte(';')
}

func appendCSSNumber(builder *strings.Builder, property string, value float64, unit string) {
	builder.WriteString(property)
	builder.WriteByte(':')
	builder.WriteString(fmt.Sprintf("%g", value))
	builder.WriteString(unit)
	builder.WriteByte(';')
}

func renderPortableHTML(note NotePackage) string {
	// 便携 HTML 把文档和资源都内联到单文件，定位为只读查看而不是编辑回写。
	documentJSON, _ := json.Marshal(note.Document)
	assetMap := map[string]string{}
	for _, asset := range note.Assets {
		if asset.DataURL != "" {
			assetMap[asset.ID] = asset.DataURL
		}
	}
	for _, sticker := range note.Stickers {
		if sticker.DataURL != "" {
			assetMap[sticker.ID] = sticker.DataURL
		}
	}
	for _, audio := range note.Audios {
		if audio.DataURL != "" {
			assetMap[audio.ID] = audio.DataURL
		}
	}
	for _, video := range note.Videos {
		if video.DataURL != "" {
			assetMap[video.ID] = video.DataURL
		}
	}
	assetJSON, _ := json.Marshal(assetMap)
	page := NotePage{Width: 794, Height: 1123, Background: "#fffdf7"}
	if len(note.Document.Pages) > 0 {
		page = note.Document.Pages[0]
	}
	backgroundHTML := ""
	if page.BackgroundAssetID != "" {
		if src := assetMap[page.BackgroundAssetID]; src != "" {
			backgroundHTML = `<img class="page-bg" src="` + html.EscapeString(src) + `" alt="">`
		}
	}
	var body strings.Builder
	elements := append([]NoteElement(nil), note.Document.Elements...)
	sort.SliceStable(elements, func(i, j int) bool { return elements[i].ZIndex < elements[j].ZIndex })
	for _, el := range elements {
		if el.PageID != page.ID {
			continue
		}
		style := fmt.Sprintf("left:%gpx;top:%gpx;width:%gpx;height:%gpx;transform:rotate(%gdeg);z-index:%d;", el.X, el.Y, el.Width, el.Height, el.Rotation, el.ZIndex)
		switch el.Type {
		case "text":
			style += portableTextStyle(el.Style)
			body.WriteString(`<div class="note-element text" style="` + style + `">` + el.Content + `</div>`)
		case "code":
			language := "plaintext"
			if v, ok := el.Style["language"].(string); ok && strings.TrimSpace(v) != "" {
				language = strings.TrimSpace(v)
			}
			body.WriteString(`<section class="note-element codeblock" style="` + style + `"><div class="codebar"><span>` +
				html.EscapeString(language) +
				`</span><button type="button" class="copy-code">复制</button></div><pre><code>` +
				html.EscapeString(el.Content) +
				`</code></pre></section>`)
		case "image", "sticker":
			src := assetMap[el.AssetID]
			body.WriteString(`<img class="note-element media" style="` + style + `" src="` + html.EscapeString(src) + `" alt="">`)
		case "audio":
			audio := findAssetMeta(note.Document.Audios, el.AssetID)
			src := assetMap[el.AssetID]
			title := audio.AudioTitle
			if strings.TrimSpace(title) == "" {
				title = audio.Name
			}
			artist := audio.AudioArtist
			cover := audio.CoverDataURL
			if cover == "" && audio.CoverDataBase64 != "" {
				cover = "data:" + firstNonEmpty(audio.CoverMimeType, "image/jpeg") + ";base64," + audio.CoverDataBase64
			}
			coverHTML := `<div class="audio-cover"><span>♪</span></div>`
			if cover != "" {
				coverHTML = `<img class="audio-cover" src="` + html.EscapeString(cover) + `" alt="">`
			}
			body.WriteString(`<section class="note-element audio-player" style="` + style + `">` +
				coverHTML +
				`<div class="audio-body"><div class="audio-title">` + html.EscapeString(title) + `</div>` +
				`<div class="audio-artist">` + html.EscapeString(artist) + `</div>` +
				`<audio controls preload="metadata" src="` + html.EscapeString(src) + `"></audio></div></section>`)
		case "video":
			src := assetMap[el.AssetID]
			poster := ""
			for _, videoAsset := range note.Document.Videos {
				if videoAsset.ID == el.AssetID {
					if videoAsset.CoverDataURL != "" {
						poster = videoAsset.CoverDataURL
					} else if videoAsset.CoverDataBase64 != "" {
						poster = "data:" + firstNonEmpty(videoAsset.CoverMimeType, "image/jpeg") + ";base64," + videoAsset.CoverDataBase64
					} else if videoAsset.PosterDataURL != "" {
						poster = videoAsset.PosterDataURL
					} else if videoAsset.PosterDataBase64 != "" {
						poster = "data:image/jpeg;base64," + videoAsset.PosterDataBase64
					}
					break
				}
			}
			posterAttr := ""
			if poster != "" {
				posterAttr = ` poster="` + html.EscapeString(poster) + `"`
			}
			body.WriteString(`<section class="note-element video-player" style="` + style + `">` +
				`<video controls preload="metadata" src="` + html.EscapeString(src) + `"` + posterAttr + `></video></section>`)
		case "tape":
			color := "#f7d974"
			if v, ok := el.Style["background"].(string); ok {
				color = v
			}
			body.WriteString(`<div class="note-element tape" style="` + style + `background:` + html.EscapeString(color) + `"></div>`)
		default:
			body.WriteString(`<div class="note-element shape" style="` + style + `"></div>`)
		}
	}
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` +
		html.EscapeString(note.Document.Title) +
		`</title><style>body{margin:0;background:#ece8df;font-family:Inter,"Segoe UI",sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:32px}.page{position:relative;overflow:hidden;box-shadow:0 30px 80px rgba(80,64,44,.22);background:` +
		html.EscapeString(page.Background) +
		`;width:` + fmt.Sprint(page.Width) + `px;height:` + fmt.Sprint(page.Height) + `px}.page-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:` +
		fmt.Sprint(cropValue(page.BackgroundCropX)) + `% ` + fmt.Sprint(cropValue(page.BackgroundCropY)) +
		`%;}.note-element{position:absolute;box-sizing:border-box}.text{overflow:auto;scrollbar-gutter:stable;font-size:26px;line-height:1.45;color:#2c2a26;font-synthesis:style weight}.text::-webkit-scrollbar{width:8px;height:8px}.text::-webkit-scrollbar-thumb{border-radius:999px;background:rgba(47,42,36,.24)}.text::-webkit-scrollbar-track{background:rgba(255,255,255,.18)}.text h1,.text h2,.text h3,.text p,.text ul,.text ol,.text blockquote{margin-top:0;margin-bottom:.42em}.text h1,.text h2,.text h3{font-weight:750;line-height:1.15}.text h1{font-size:1.42em}.text h2{font-size:1.24em}.text h3{font-size:1.1em}.text ul,.text ol{padding-left:1.25em}.text blockquote{border-left:3px solid rgba(47,111,237,.45);border-left-color:color-mix(in srgb,var(--timenotes-blockquote-color,#5f5650) 45%,transparent);padding-left:.72em;color:var(--timenotes-blockquote-color,rgba(47,42,36,.72));font-family:var(--timenotes-blockquote-font-family,var(--timenotes-text-font-family,inherit))!important}.text blockquote :not(code){font-family:inherit!important}.text hr{height:1px;margin:.65em 0;border:0;background:rgba(47,42,36,.22)}.text a{color:#1f5fd2;cursor:pointer;text-decoration:underline;text-underline-offset:2px}.text em,.text i{font-synthesis:style;font-style:italic!important}.text code{border-radius:4px;background:rgba(47,111,237,.1);color:var(--timenotes-inline-code-color,#8a3f58);font-family:var(--timenotes-inline-code-font-family,"Cascadia Code","Fira Code",Consolas,"SFMono-Regular",monospace);font-size:.88em;padding:.06em .28em}.media{object-fit:cover;border-radius:14px}.tape{opacity:.78;border-radius:3px}.shape{border:2px solid #2c2a26;border-radius:16px}.audio-player{display:flex;align-items:center;gap:12px;overflow:hidden;border-radius:8px;border:1px solid rgba(20,24,31,.12);background:#f8fafc;color:#1f2937;padding:10px;box-shadow:0 14px 32px rgba(15,23,42,.13)}.audio-cover{width:68px;height:68px;flex:0 0 auto;border-radius:6px;object-fit:cover;background:#111827;color:#fff;display:grid;place-items:center;font-size:28px}.audio-body{min-width:0;flex:1}.audio-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}.audio-artist{margin-top:2px;min-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(31,41,55,.56);font-size:12px}.audio-player audio{margin-top:8px;width:100%}.codeblock{display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:#101828;color:#d7e2f0;box-shadow:0 14px 32px rgba(15,23,42,.18)}.codebar{display:flex;height:32px;flex-shrink:0;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);padding:0 8px 0 12px;font:11px Inter,"Segoe UI",sans-serif;color:rgba(255,255,255,.72)}.copy-code{cursor:pointer;border:0;border-radius:6px;background:rgba(255,255,255,.1);color:#fff;padding:4px 8px}.codeblock pre{flex:1;min-height:0;margin:0;overflow:auto;padding:12px 14px 16px;font:14px/1.55 "Cascadia Code",Consolas,monospace;white-space:pre}</style></head><body><div class="wrap"><main class="page">` +
		backgroundHTML +
		body.String() +
		`</main></div><script type="application/json" id="timenotes-document">` +
		html.EscapeString(string(documentJSON)) +
		`</script><script type="application/json" id="timenotes-assets">` +
		html.EscapeString(string(assetJSON)) +
		`</script><script>document.querySelectorAll(".copy-code").forEach(function(button){button.addEventListener("click",function(){var code=button.closest(".codeblock").querySelector("code").textContent||"";if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(code)}else{var textarea=document.createElement("textarea");textarea.value=code;document.body.appendChild(textarea);textarea.select();document.execCommand("copy");textarea.remove()}})})</script></body></html>`
}

func findAssetMeta(assets []AssetMeta, id string) AssetMeta {
	for _, asset := range assets {
		if asset.ID == id {
			return asset
		}
	}
	return AssetMeta{}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func seedDocument(now string) NoteDocument {
	// 新建文档只提供一张空白纸；示例元素会干扰真实编辑和保存/打开回归。
	page := NotePage{ID: "page-1", Title: "第 1 页", Width: 794, Height: 1123, Background: "#fffaf0"}
	return NoteDocument{
		FormatVersion: currentFormatVersion,
		Title:         "TimeNotes 手账",
		CreatedAt:     now,
		UpdatedAt:     now,
		Pages:         []NotePage{page},
		Elements:      []NoteElement{},
		Assets:        []AssetMeta{},
		Stickers:      []AssetMeta{},
		Fonts:         []AssetMeta{},
		Audios:        []AssetMeta{},
		Videos:        []AssetMeta{},
		Templates:     []TemplateDef{},
	}
}
