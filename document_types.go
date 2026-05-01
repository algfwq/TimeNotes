package main

type NotePackage struct {
	// Manifest 是 .tnote 包的索引，前端和后端都先读它来判断版本与资源位置。
	Manifest  NoteManifest  `json:"manifest"`
	Document  NoteDocument  `json:"document"`
	YjsState  string        `json:"yjsState"`
	Assets    []AssetBlob   `json:"assets"`
	Stickers  []AssetBlob   `json:"stickers"`
	Fonts     []AssetBlob   `json:"fonts"`
	Thumbnail string        `json:"thumbnail"`
	Warnings  []ServiceNote `json:"warnings,omitempty"`
}

type NoteManifest struct {
	// FormatVersion 是文件格式版本，不等同于应用版本；结构升级必须靠它触发迁移。
	FormatVersion int         `json:"formatVersion"`
	AppVersion    string      `json:"appVersion"`
	Title         string      `json:"title"`
	CreatedAt     string      `json:"createdAt"`
	UpdatedAt     string      `json:"updatedAt"`
	DocumentPath  string      `json:"documentPath"`
	YjsStatePath  string      `json:"yjsStatePath"`
	Assets        []AssetMeta `json:"assets"`
	Stickers      []AssetMeta `json:"stickers"`
	Fonts         []AssetMeta `json:"fonts"`
}

type NoteDocument struct {
	// Document 是可编辑状态的完整快照；协同时仍以 Yjs update 为事实源。
	FormatVersion int           `json:"formatVersion"`
	Title         string        `json:"title"`
	CreatedAt     string        `json:"createdAt"`
	UpdatedAt     string        `json:"updatedAt"`
	Pages         []NotePage    `json:"pages"`
	Elements      []NoteElement `json:"elements"`
	Assets        []AssetMeta   `json:"assets"`
	// Stickers 独立于 Assets，避免左侧图片素材栏和右侧贴纸控制面板互相污染。
	Stickers  []AssetMeta   `json:"stickers"`
	Fonts     []AssetMeta   `json:"fonts"`
	Templates []TemplateDef `json:"templates"`
}

type NotePage struct {
	// 页面是画布坐标系的边界，元素坐标都相对这个页面左上角。
	ID         string `json:"id"`
	Title      string `json:"title"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Background string `json:"background"`
	// 背景图字段从 v2 开始使用；图片本体在 assets 目录中，页面只保留引用和裁剪参数。
	BackgroundAssetID string   `json:"backgroundAssetId,omitempty"`
	BackgroundFit     string   `json:"backgroundFit,omitempty"`
	BackgroundCropX   *float64 `json:"backgroundCropX,omitempty"`
	BackgroundCropY   *float64 `json:"backgroundCropY,omitempty"`
}

type NoteElement struct {
	// 坐标始终使用页面坐标，不能写入屏幕缩放后的像素值。
	ID       string                 `json:"id"`
	PageID   string                 `json:"pageId"`
	Type     string                 `json:"type"`
	X        float64                `json:"x"`
	Y        float64                `json:"y"`
	Width    float64                `json:"width"`
	Height   float64                `json:"height"`
	Rotation float64                `json:"rotation"`
	ZIndex   int                    `json:"zIndex"`
	Content  string                 `json:"content,omitempty"`
	AssetID  string                 `json:"assetId,omitempty"`
	Style    map[string]interface{} `json:"style,omitempty"`
	Points   []float64              `json:"points,omitempty"`
}

type AssetMeta struct {
	// Path 是 ZIP 包内部相对路径，打开外部 .tnote 时必须经过安全校验后才能读取。
	ID       string `json:"id"`
	Name     string `json:"name"`
	Hash     string `json:"hash"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	Path     string `json:"path"`
}

type AssetBlob struct {
	AssetMeta
	// DataBase64 是跨 Wails 边界传输素材内容的承载字段，保存时会重新写回 ZIP。
	DataBase64 string `json:"dataBase64"`
	DataURL    string `json:"dataUrl,omitempty"`
}

type SystemFont struct {
	// Name 是文件名，Family 是供下拉框展示的名称；真正使用时会通过 Path 再导入字体文件。
	Name   string `json:"name"`
	Family string `json:"family"`
	Path   string `json:"path"`
}

type TemplateDef struct {
	// 模板字段目前保留为空，避免旧计划中的模板能力影响首版编辑器。
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Page        NotePage      `json:"page"`
	Elements    []NoteElement `json:"elements"`
}

type ServiceNote struct {
	// ServiceNote 是非致命问题的提示，例如某个素材在包内丢失。
	Code    string `json:"code"`
	Message string `json:"message"`
}
