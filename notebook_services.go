package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// NotebookService 暴露给前端用于手账本文件管理和首页卡片展示。
type NotebookService struct{}

var startupFilePath string

func init() {
	for _, arg := range os.Args[1:] {
		if path, ok := normalizeStartupNotePath(arg); ok {
			startupFilePath = path
			break
		}
	}
}

func normalizeStartupNotePath(arg string) (string, bool) {
	trimmed := strings.Trim(strings.TrimSpace(arg), "\"")
	if strings.HasPrefix(strings.ToLower(trimmed), "file://") {
		trimmed = strings.TrimPrefix(trimmed, "file:///")
		trimmed = strings.TrimPrefix(trimmed, "file://")
		trimmed = strings.ReplaceAll(trimmed, "/", string(filepath.Separator))
	}
	if !strings.HasSuffix(strings.ToLower(trimmed), ".tnote") {
		return "", false
	}
	return filepath.Clean(trimmed), true
}

var (
	notebooksConfigDirOverride string
	notebooksExeDirOverride    string
	notebooksMigrationChecked  bool
)

func notebooksConfigDir() string {
	if notebooksConfigDirOverride != "" {
		return notebooksConfigDirOverride
	}
	return platformDataRoot()
}

func notebooksExecutableDir() string {
	if notebooksExeDirOverride != "" {
		return notebooksExeDirOverride
	}
	exe, err := os.Executable()
	if err != nil || exe == "" {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			return wd
		}
		return "."
	}
	return filepath.Dir(exe)
}

func notebooksRoot() string {
	return filepath.Join(notebooksConfigDir(), "notebooks")
}

func oldNotebooksRoot() string {
	return filepath.Join(notebooksExecutableDir(), "notebooks")
}

func notebooksStorePath() string {
	return filepath.Join(notebooksConfigDir(), "notebooks.json")
}

func oldNotebooksStorePath() string {
	return filepath.Join(notebooksExecutableDir(), "notebooks.json")
}

func ensureNotebookStoreMigrated() error {
	if notebooksMigrationChecked {
		return nil
	}
	notebooksMigrationChecked = true

	newStore := notebooksStorePath()
	if fileExists(newStore) {
		return nil
	}
	oldStore := oldNotebooksStorePath()
	if !fileExists(oldStore) {
		return nil
	}
	raw, err := os.ReadFile(oldStore)
	if err != nil {
		return err
	}
	var store NotebookStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return fmt.Errorf("parse old notebooks.json: %w", err)
	}
	if store.Notebooks == nil {
		store.Notebooks = []NotebookMeta{}
	}
	if store.Version == 0 {
		store.Version = 1
	}
	newRoot := notebooksRoot()
	oldRoot := oldNotebooksRoot()
	if err := os.MkdirAll(newRoot, 0o755); err != nil {
		return err
	}
	for i := range store.Notebooks {
		notebook := &store.Notebooks[i]
		if !notebook.IsManaged {
			continue
		}
		oldPath := notebook.Path
		if oldPath == "" {
			oldPath = filepath.Join(oldRoot, safeFileName(notebook.Name)+".tnote")
		}
		if !sameOrChildPath(oldPath, oldRoot) {
			continue
		}
		newPath := filepath.Join(newRoot, filepath.Base(oldPath))
		newPath = uniqueFilePath(newPath)
		if err := copyFile(oldPath, newPath); err != nil {
			logEvent("warn", "notebook_migration_file_skipped", map[string]interface{}{"path": oldPath, "error": err.Error()})
			continue
		}
		notebook.Path = newPath
		notebook.IsManaged = true
	}
	if err := writeNotebookStoreWithoutMigration(store); err != nil {
		return err
	}
	logEvent("info", "notebook_store_migrated", map[string]interface{}{"from": oldStore, "to": newStore, "count": len(store.Notebooks)})
	return nil
}

func writeNotebookStoreWithoutMigration(store NotebookStore) error {
	path := notebooksStorePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func sameOrChildPath(path string, root string) bool {
	cleanPath, err := filepath.Abs(path)
	if err != nil {
		cleanPath = filepath.Clean(path)
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		cleanRoot = filepath.Clean(root)
	}
	rel, err := filepath.Rel(cleanRoot, cleanPath)
	if err != nil {
		return false
	}
	return rel == "." || (rel != "" && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

func uniqueFilePath(path string) string {
	if !fileExists(path) {
		return path
	}
	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(filepath.Base(path), ext)
	for index := 1; ; index++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, index, ext))
		if !fileExists(candidate) {
			return candidate
		}
	}
}

func readNotebookStore() (NotebookStore, error) {
	if err := ensureNotebookStoreMigrated(); err != nil {
		return NotebookStore{}, err
	}
	path := notebooksStorePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NotebookStore{Notebooks: []NotebookMeta{}, Version: 1}, nil
		}
		return NotebookStore{}, err
	}
	var store NotebookStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return NotebookStore{}, fmt.Errorf("parse notebooks.json: %w", err)
	}
	if store.Notebooks == nil {
		store.Notebooks = []NotebookMeta{}
	}
	if store.Version == 0 {
		store.Version = 1
	}
	return store, nil
}

func writeNotebookStore(store NotebookStore) error {
	if err := ensureNotebookStoreMigrated(); err != nil {
		return err
	}
	return writeNotebookStoreWithoutMigration(store)
}

func saveNotebookMeta(meta NotebookMeta) error {
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	found := false
	for i := range store.Notebooks {
		if store.Notebooks[i].ID == meta.ID {
			store.Notebooks[i] = meta
			found = true
			break
		}
	}
	if !found {
		store.Notebooks = append(store.Notebooks, meta)
	}
	return writeNotebookStore(store)
}

func deleteNotebookMeta(id string) error {
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	filtered := make([]NotebookMeta, 0, len(store.Notebooks))
	for _, notebook := range store.Notebooks {
		if notebook.ID != id {
			filtered = append(filtered, notebook)
		}
	}
	store.Notebooks = filtered
	return writeNotebookStore(store)
}

func (s *NotebookService) GetNotebooksDir() string {
	dir := notebooksRoot()
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func (s *NotebookService) ListNotebooks() ([]NotebookMeta, error) {
	store, err := readNotebookStore()
	if err != nil {
		logEvent("error", "notebook_list_failed", map[string]interface{}{"error": err.Error()})
		return nil, err
	}
	// 验证托管文件是否存在；不存在的标记为外部但保留记录。
	for i := range store.Notebooks {
		notebook := &store.Notebooks[i]
		if notebook.IsManaged {
			if _, err := os.Stat(notebook.Path); os.IsNotExist(err) {
				notebook.IsManaged = false
			}
		}
		// 默认封面由前端展示时根据第一页动态生成；这里只规范旧数据，不从 .tnote 提取默认封面。
		if notebook.CoverType == "" {
			notebook.CoverType = "default"
		}
		if notebook.CoverType == "default" {
			notebook.CoverData = ""
		}
	}
	logEvent("info", "notebooks_listed", map[string]interface{}{"count": len(store.Notebooks)})
	return store.Notebooks, nil
}

func (s *NotebookService) CreateNotebook(name string) (NotebookMeta, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return NotebookMeta{}, errors.New("手账本名称不能为空")
	}
	safeName := safeFileName(name)
	root := notebooksRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return NotebookMeta{}, err
	}
	now := time.Now().UTC()
	doc := seedDocument(now.Format(time.RFC3339))
	doc.Title = name
	note := packageFromDocument(doc, nil, nil, nil, nil, nil, nil, "")
	note.Manifest.Title = name

	id := fmt.Sprintf("%d", now.UnixNano())
	notePath := filepath.Join(root, safeName+".tnote")
	if err := writeNotePackage(notePath, note); err != nil {
		logEvent("error", "notebook_create_failed", map[string]interface{}{"name": name, "error": err.Error()})
		return NotebookMeta{}, err
	}
	meta := NotebookMeta{
		ID:        id,
		Name:      name,
		Path:      notePath,
		IsManaged: true,
		CoverType: "default",
		CoverData: "",
		CreatedAt: now.Format(time.RFC3339),
		UpdatedAt: now.Format(time.RFC3339),
	}
	if err := saveNotebookMeta(meta); err != nil {
		return NotebookMeta{}, fmt.Errorf("save metadata: %w", err)
	}
	logEvent("info", "notebook_created", map[string]interface{}{"id": id, "name": name, "path": notePath})
	return meta, nil
}

func (s *NotebookService) OpenNotebook(id string) (NotePackage, error) {
	store, err := readNotebookStore()
	if err != nil {
		return NotePackage{}, err
	}
	for _, notebook := range store.Notebooks {
		if notebook.ID == id {
			note, err := (&DocumentService{}).OpenNote(notebook.Path)
			if err != nil {
				return NotePackage{}, err
			}
			return note, nil
		}
	}
	return NotePackage{}, fmt.Errorf("notebook %s not found", id)
}

func (s *NotebookService) ImportNotebook(srcPath string) (NotebookMeta, error) {
	srcPath = strings.TrimSpace(srcPath)
	if srcPath == "" {
		return NotebookMeta{}, errors.New("源文件路径不能为空")
	}
	if !strings.HasSuffix(strings.ToLower(srcPath), ".tnote") {
		return NotebookMeta{}, errors.New("仅支持导入 .tnote 文件")
	}
	// 先打开以获取标题和验证文件合法性。
	note, err := (&DocumentService{}).OpenNote(srcPath)
	if err != nil {
		return NotebookMeta{}, fmt.Errorf("读取源文件失败: %w", err)
	}
	root := notebooksRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return NotebookMeta{}, err
	}
	baseName := safeFileName(note.Document.Title)
	destPath := filepath.Join(root, baseName+".tnote")
	// 避免同名文件覆盖：追加后缀。
	counter := 1
	for fileExists(destPath) {
		destPath = filepath.Join(root, fmt.Sprintf("%s-%d.tnote", baseName, counter))
		counter++
	}
	if err := copyFile(srcPath, destPath); err != nil {
		logEvent("error", "notebook_import_failed", map[string]interface{}{"src": srcPath, "error": err.Error()})
		return NotebookMeta{}, err
	}
	now := time.Now().UTC()
	id := fmt.Sprintf("%d", now.UnixNano())
	coverType, coverData := coverFromPackageThumbnail(note.Thumbnail)
	meta := NotebookMeta{
		ID:        id,
		Name:      note.Document.Title,
		Path:      destPath,
		IsManaged: true,
		CoverType: coverType,
		CoverData: coverData,
		CreatedAt: now.Format(time.RFC3339),
		UpdatedAt: now.Format(time.RFC3339),
	}
	if err := saveNotebookMeta(meta); err != nil {
		_ = os.Remove(destPath)
		return NotebookMeta{}, fmt.Errorf("保存元数据失败: %w", err)
	}
		logEvent("info", "notebook_imported", map[string]interface{}{"id": id, "path": destPath, "src": srcPath})
		return meta, nil
	}

	// ImportNotebookFromData 从 base64 编码的 .tnote 文件内容导入手账本——用于拖放打开等场景，
	// 此时不依赖文件系统路径（WebView2 不暴露 File.path）。
	func (s *NotebookService) ImportNotebookFromData(dataBase64 string, name string) (NotebookMeta, error) {
		if dataBase64 == "" {
			return NotebookMeta{}, errors.New("文件数据不能为空")
		}
		raw, err := base64.StdEncoding.DecodeString(dataBase64)
		if err != nil {
			return NotebookMeta{}, fmt.Errorf("解码文件数据失败: %w", err)
		}
		root := notebooksRoot()
		if err := os.MkdirAll(root, 0o755); err != nil {
			return NotebookMeta{}, err
		}
		baseName := safeFileName(name)
		destPath := filepath.Join(root, baseName+".tnote")
		counter := 1
		for fileExists(destPath) {
			destPath = filepath.Join(root, fmt.Sprintf("%s-%d.tnote", baseName, counter))
			counter++
		}
		if err := os.WriteFile(destPath, raw, 0o644); err != nil {
			return NotebookMeta{}, err
		}
		return s.ImportNotebook(destPath)
	}

	func (s *NotebookService) RegisterExternalNotebook(srcPath string) (NotebookMeta, error) {
	srcPath = strings.TrimSpace(srcPath)
	if srcPath == "" {
		return NotebookMeta{}, errors.New("文件路径不能为空")
	}
	// 检查是否已经注册过相同路径的手账本，避免重复创建条目。
	store, err := readNotebookStore()
	if err == nil {
		for _, notebook := range store.Notebooks {
			if notebook.Path == srcPath {
				if _, statErr := os.Stat(srcPath); statErr == nil {
					notebook.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
					_ = saveNotebookMeta(notebook)
					logEvent("info", "notebook_registered_external_existing", map[string]interface{}{"id": notebook.ID, "path": srcPath})
					return notebook, nil
				}
			}
		}
	}
	note, err := (&DocumentService{}).OpenNote(srcPath)
	if err != nil {
		return NotebookMeta{}, fmt.Errorf("无法打开文件: %w", err)
	}
	now := time.Now().UTC()
	id := fmt.Sprintf("%d", now.UnixNano())
	coverType, coverData := coverFromPackageThumbnail(note.Thumbnail)
	// 位于手账库目录内的文件（含 Blog 下载落盘）视为托管，删除列表项时应清理本地文件。
	managed := sameOrChildPath(srcPath, notebooksRoot())
	meta := NotebookMeta{
		ID:        id,
		Name:      note.Document.Title,
		Path:      srcPath,
		IsManaged: managed,
		CoverType: coverType,
		CoverData: coverData,
		CreatedAt: now.Format(time.RFC3339),
		UpdatedAt: now.Format(time.RFC3339),
	}
	if err := saveNotebookMeta(meta); err != nil {
		return NotebookMeta{}, fmt.Errorf("保存元数据失败: %w", err)
	}
	logEvent("info", "notebook_registered_external", map[string]interface{}{"id": id, "path": srcPath, "managed": managed})
	return meta, nil
}

func (s *NotebookService) RenameNotebook(id string, newName string) error {
	id = strings.TrimSpace(id)
	newName = strings.TrimSpace(newName)
	if id == "" || newName == "" {
		return errors.New("id 和名称不能为空")
	}
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	index := -1
	for i := range store.Notebooks {
		if store.Notebooks[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("notebook %s not found", id)
	}
	notebook := &store.Notebooks[index]
	oldPath := notebook.Path
	if notebook.IsManaged {
		// 同时重命名磁盘文件。
		newFileName := safeFileName(newName) + ".tnote"
		newPath := filepath.Join(filepath.Dir(oldPath), newFileName)
		if newPath != oldPath {
			if fileExists(newPath) {
				return fmt.Errorf("目标文件 %s 已存在", newFileName)
			}
			if err := os.Rename(oldPath, newPath); err != nil {
				return fmt.Errorf("重命名文件失败: %w", err)
			}
			notebook.Path = newPath
		}
	}
	notebook.Name = newName
	notebook.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := writeNotebookStore(store); err != nil {
		return err
	}
	// 同步更新 .tnote 内的标题。
	note, err := (&DocumentService{}).OpenNote(notebook.Path)
	if err == nil {
		note.Document.Title = newName
		note.normalize()
		_ = writeNotePackage(notebook.Path, note)
	}
	logEvent("info", "notebook_renamed", map[string]interface{}{"id": id, "name": newName})
	return nil
}

func (s *NotebookService) DeleteNotebook(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("id 不能为空")
	}
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	var target NotebookMeta
	found := false
	for _, notebook := range store.Notebooks {
		if notebook.ID == id {
			target = notebook
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("notebook %s not found", id)
	}
	// 删除列表项时清理本地 .tnote：托管本始终删；落在 notebooks 目录内的也删
	//（Blog「编辑」打开时可能 IsManaged=false，但文件仍在本地手账库）。
	// 不触碰 Blog 服务端文件——此处只做本地磁盘操作。
	if path := strings.TrimSpace(target.Path); path != "" {
		underLibrary := sameOrChildPath(path, notebooksRoot())
		if target.IsManaged || underLibrary {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("删除文件失败: %w", err)
			}
		}
	}
	if err := deleteNotebookMeta(id); err != nil {
		return err
	}
	logEvent("info", "notebook_deleted", map[string]interface{}{"id": id, "path": target.Path, "managed": target.IsManaged})
	return nil
}

func (s *NotebookService) BackupNotebook(id string, destPath string) error {
	id = strings.TrimSpace(id)
	destPath = strings.TrimSpace(destPath)
	if id == "" || destPath == "" {
		return errors.New("id 和目标路径不能为空")
	}
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	for _, notebook := range store.Notebooks {
		if notebook.ID == id {
			if !strings.HasSuffix(strings.ToLower(destPath), ".tnote") {
				destPath += ".tnote"
			}
			if err := copyFile(notebook.Path, destPath); err != nil {
				return fmt.Errorf("备份失败: %w", err)
			}
			logEvent("info", "notebook_backed_up", map[string]interface{}{"id": id, "dest": destPath})
			return nil
		}
	}
	return fmt.Errorf("notebook %s not found", id)
}

func (s *NotebookService) UpdateNotebookCover(id string, coverData string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("id 不能为空")
	}
	store, err := readNotebookStore()
	if err != nil {
		return err
	}
	index := -1
	for i := range store.Notebooks {
		if store.Notebooks[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("notebook %s not found", id)
	}
	notebook := &store.Notebooks[index]
	if coverData == "" {
		notebook.CoverType = "default"
		notebook.CoverData = ""
		_ = writeThumbnailToNote(notebook.Path, "")
	} else {
		notebook.CoverType = "custom"
		notebook.CoverData = coverData
		_ = writeThumbnailToNote(notebook.Path, coverData)
	}
	notebook.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	logEvent("info", "notebook_cover_updated", map[string]interface{}{"id": id, "coverType": notebook.CoverType})
	return writeNotebookStore(store)
}

func (s *NotebookService) GetStartupFilePath() string {
	path := startupFilePath
	startupFilePath = ""
	return path
}

func (s *NotebookService) UpdateNotebookThumbnail(id string, coverData string) {
	// 默认封面预览生成后调用：仅在尚未自定义封面时写回元数据与 .tnote thumbnail.png。
	id = strings.TrimSpace(id)
	if id == "" || coverData == "" {
		return
	}
	store, err := readNotebookStore()
	if err != nil {
		return
	}
	for i := range store.Notebooks {
		if store.Notebooks[i].ID != id {
			continue
		}
		// 用户已显式设置的有效封面永不被默认预览覆盖。
		if store.Notebooks[i].CoverType == "custom" && strings.TrimSpace(store.Notebooks[i].CoverData) != "" {
			return
		}
		pngURL := coverData
		if _, normalized, err := thumbnailPNGBytes(coverData); err == nil {
			pngURL = normalized
		}
		store.Notebooks[i].CoverType = "custom"
		store.Notebooks[i].CoverData = pngURL
		store.Notebooks[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		_ = writeNotebookStore(store)
		_ = writeThumbnailToNote(store.Notebooks[i].Path, pngURL)
		return
	}
}

func coverFromPackageThumbnail(thumbnail string) (string, string) {
	if strings.TrimSpace(thumbnail) == "" {
		return "default", ""
	}
	return "custom", thumbnail
}

// writeThumbnailToNote 将自定义封面 data URL 写入 .tnote 包；空字符串会移除包内缩略图。
// 非 PNG 封面在 writeNotePackage 内统一转换为真实 thumbnail.png。
func writeThumbnailToNote(path string, coverData string) error {
	if path == "" {
		return nil
	}
	note, err := (&DocumentService{}).OpenNote(path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(coverData) == "" {
		note.Thumbnail = ""
	} else if pngRaw, pngURL, err := thumbnailPNGBytes(coverData); err == nil && len(pngRaw) > 0 {
		// 先规范化为 PNG data URL，保证元数据 CoverData 与包内 thumbnail.png 一致。
		note.Thumbnail = pngURL
	} else {
		note.Thumbnail = coverData
	}
	note.normalize()
	return writeNotePackage(path, note)
}

// ensureNotebookPackageThumbnail 保证 .tnote 内含 thumbnail.*。
// 若包内缺失但元数据已有自定义封面，则把 CoverData 回写进包，避免 Blog 上传因 thumbnail_required 失败。
func ensureNotebookPackageThumbnail(meta NotebookMeta) error {
	path := strings.TrimSpace(meta.Path)
	if path == "" {
		return errors.New("notebook path is empty")
	}
	lock := noteSaveLock(path)
	lock.Lock()
	defer lock.Unlock()

	note, err := readNotePackage(path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(note.Thumbnail) != "" {
		return nil
	}
	coverData := strings.TrimSpace(meta.CoverData)
	if coverData == "" || meta.CoverType != "custom" {
		return errors.New("thumbnail_required")
	}
	pngRaw, pngURL, err := thumbnailPNGBytes(coverData)
	if err != nil || len(pngRaw) == 0 {
		return fmt.Errorf("invalid cover data: %w", err)
	}
	note.Thumbnail = pngURL
	note.normalize()
	return writeNotePackage(path, note)
}

// safeFileName 将名称清理为合法的文件名。
func safeFileName(name string) string {
	// 替换 Windows 文件名非法字符。
	replacer := strings.NewReplacer(
		"\\", "-", "/", "-", ":", "-", "*", "-",
		"?", "-", "\"", "-", "<", "-", ">", "-", "|", "-",
	)
	cleaned := replacer.Replace(name)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		cleaned = "untitled"
	}
	// 避免以空格或点结尾。
	cleaned = strings.TrimRight(cleaned, " .")
	if len(cleaned) > 120 {
		cleaned = cleaned[:120]
	}
	return cleaned
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ConfirmAppQuit 由前端保存完所有手账本后调用，确认可以退出应用。
func (s *NotebookService) ConfirmAppQuit() {
	quitConfirmed = true
	logEvent("info", "app_quit_confirmed", nil)
	if mainApp != nil {
		mainApp.Quit()
	}
	}

	// OpenFileDirectory 在资源管理器中打开文件所在目录并选中该文件。
	func (s *NotebookService) OpenFileDirectory(path string) error {
		abs, err := filepath.Abs(filepath.Clean(path))
		if err != nil {
			return err
		}
		return openInExplorer(abs)
	}

	// ReadImageAsDataURL 读取本地图片文件，返回 data URL 供前端直接使用。
func (s *NotebookService) ReadImageAsDataURL(path string) (string, error) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(path))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		switch ext {
		case ".png":
			mimeType = "image/png"
		case ".jpg", ".jpeg":
			mimeType = "image/jpeg"
		case ".webp":
			mimeType = "image/webp"
		case ".gif":
			mimeType = "image/gif"
		case ".svg":
			mimeType = "image/svg+xml"
		default:
			mimeType = "image/png"
		}
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	removeTmp := true
	defer func() {
		if removeTmp {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := io.Copy(tmp, srcFile); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return err
	}
	removeTmp = false
	return nil
}

// writeThumbnailDataURL 将 base64 字符串包装为 PNG data URL。
func writeThumbnailDataURL(base64Data string) string {
	if base64Data == "" {
		return ""
	}
	if strings.HasPrefix(base64Data, "data:") {
		return base64Data
	}
	// 尝试解码验证是否为有效 base64。
	if _, err := base64.StdEncoding.DecodeString(base64Data); err != nil {
		// 可能已经是 data URL 但缺失前缀。
		if strings.Contains(base64Data, ";base64,") {
			return base64Data
		}
		return ""
	}
	return "data:image/png;base64," + base64Data
}

