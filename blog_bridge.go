package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const blogBridgeAddr = "127.0.0.1:54088"

type blogBridgeServer struct {
	server *http.Server
	mu     sync.Mutex
	pairToken string
	capabilities map[string]bridgeCapability
}

type bridgeCapability struct {
	ID          string
	NoteID      string
	DownloadURL string
	Filename    string
	ExpiresAt   time.Time
}

type blogConnectionConfig struct {
	URL              string `json:"url"`
	Username         string `json:"username"`
	Token            string `json:"token"`
	ExpiresAt        int64  `json:"expiresAt"`
	RememberPassword bool   `json:"rememberPassword"`
	Password         string `json:"password,omitempty"`
	UpdatedAt        string `json:"updatedAt"`
}

type blogSyncEntry struct {
	RemoteID  string `json:"remoteId"`
	Filename  string `json:"filename"`
	UpdatedAt string `json:"updatedAt"`
}

type blogSyncStore struct {
	Entries map[string]blogSyncEntry `json:"entries"`
}

func blogConnectionPath() string {
	return filepath.Join(notebooksConfigDir(), "blog-connection.json")
}

func blogSyncPath() string {
	return filepath.Join(notebooksConfigDir(), "blog-sync.json")
}

func loadBlogConnection() (blogConnectionConfig, error) {
	var cfg blogConnectionConfig
	raw, err := os.ReadFile(blogConnectionPath())
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func saveBlogConnection(cfg blogConnectionConfig) error {
	if err := os.MkdirAll(notebooksConfigDir(), 0o755); err != nil {
		return err
	}
	cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(blogConnectionPath(), raw, 0o600)
}

func loadBlogSync() (blogSyncStore, error) {
	store := blogSyncStore{Entries: map[string]blogSyncEntry{}}
	raw, err := os.ReadFile(blogSyncPath())
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return store, err
	}
	if err := json.Unmarshal(raw, &store); err != nil {
		return store, err
	}
	if store.Entries == nil {
		store.Entries = map[string]blogSyncEntry{}
	}
	return store, nil
}

func saveBlogSync(store blogSyncStore) error {
	if err := os.MkdirAll(notebooksConfigDir(), 0o755); err != nil {
		return err
	}
	if store.Entries == nil {
		store.Entries = map[string]blogSyncEntry{}
	}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(blogSyncPath(), raw, 0o644)
}

func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		// Only allow local desktop/dev origins; never reflect arbitrary website origins.
		if origin == "" || isAllowedBridgeOrigin(origin) {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		} else {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-TimeNotes-Pair-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func isAllowedBridgeOrigin(origin string) bool {
	o := strings.ToLower(strings.TrimSpace(origin))
	if o == "" {
		return true
	}
	if strings.HasPrefix(o, "wails://") || strings.HasPrefix(o, "file://") {
		return true
	}
	if strings.HasPrefix(o, "http://127.0.0.1:") || strings.HasPrefix(o, "http://localhost:") ||
		strings.HasPrefix(o, "https://127.0.0.1:") || strings.HasPrefix(o, "https://localhost:") {
		return true
	}
	return false
}

func startBlogBridge() (*blogBridgeServer, error) {
	mux := http.NewServeMux()
	b := &blogBridgeServer{
		pairToken:    randomBridgeToken(),
		capabilities: map[string]bridgeCapability{},
	}

	mux.HandleFunc("/api/blog-bridge/health", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		writeJSONResponse(w, map[string]any{"ok": true, "pairRequired": true})
	}))

	mux.HandleFunc("/api/blog-bridge/pair-token", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Local TimeNotes UI can read the pairing token; arbitrary websites cannot due to origin checks.
		writeJSONResponse(w, map[string]any{"token": b.pairToken})
	}))

	mux.HandleFunc("/api/blog-bridge/connection", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch r.Method {
		case http.MethodGet:
			cfg, err := loadBlogConnection()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONResponse(w, cfg)
		case http.MethodPost:
			var cfg blogConnectionConfig
			if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if !cfg.RememberPassword {
				cfg.Password = ""
			}
			if err := saveBlogConnection(cfg); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONResponse(w, map[string]any{"ok": true})
		case http.MethodDelete:
			_ = os.Remove(blogConnectionPath())
			writeJSONResponse(w, map[string]any{"ok": true})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}))

	mux.HandleFunc("/api/blog-bridge/sync", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch r.Method {
		case http.MethodGet:
			store, err := loadBlogSync()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONResponse(w, store)
		case http.MethodPost:
			var body struct {
				NotebookID string `json:"notebookId"`
				RemoteID   string `json:"remoteId"`
				Filename   string `json:"filename"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.NotebookID == "" || body.RemoteID == "" {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			store, err := loadBlogSync()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			store.Entries[body.NotebookID] = blogSyncEntry{
				RemoteID:  body.RemoteID,
				Filename:  body.Filename,
				UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}
			if err := saveBlogSync(store); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONResponse(w, map[string]any{"ok": true})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}))

	mux.HandleFunc("/api/blog-bridge/notebook-bytes", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
			http.Error(w, "id required", http.StatusBadRequest)
			return
		}
		svc := &NotebookService{}
		list, err := svc.ListNotebooks()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var meta *NotebookMeta
		for i := range list {
			if list[i].ID == body.ID {
				meta = &list[i]
				break
			}
		}
		if meta == nil {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		raw, err := os.ReadFile(meta.Path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONResponse(w, map[string]any{
			"id":       meta.ID,
			"name":     meta.Name,
			"path":     meta.Path,
			"filename": filepath.Base(meta.Path),
			"size":     len(raw),
			"dataBase64": encodeBase64(raw),
		})
	}))

	mux.HandleFunc("/api/blog-bridge/capabilities", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !b.authorized(r) {
			http.Error(w, "pair token required", http.StatusUnauthorized)
			return
		}
		var body struct {
			NoteID      string `json:"noteId"`
			DownloadURL string `json:"downloadUrl"`
			Filename    string `json:"filename"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		downloadURL := strings.TrimSpace(body.DownloadURL)
		if downloadURL == "" || strings.TrimSpace(body.NoteID) == "" {
			http.Error(w, "noteId and downloadUrl required", http.StatusBadRequest)
			return
		}
		if !isAllowedDownloadURL(downloadURL) {
			http.Error(w, "downloadUrl not allowed", http.StatusBadRequest)
			return
		}
		filename := filepath.Base(strings.TrimSpace(body.Filename))
		if filename == "" || filename == "." || strings.Contains(filename, "..") || !strings.HasSuffix(strings.ToLower(filename), ".tnote") {
			filename = fmt.Sprintf("blog-%s.tnote", body.NoteID)
		}
		capID := randomBridgeToken()
		b.mu.Lock()
		b.cleanupCapabilitiesLocked()
		b.capabilities[capID] = bridgeCapability{
			ID:          capID,
			NoteID:      body.NoteID,
			DownloadURL: downloadURL,
			Filename:    filename,
			ExpiresAt:   time.Now().Add(2 * time.Minute),
		}
		b.mu.Unlock()
		writeJSONResponse(w, map[string]any{"capabilityId": capID, "expiresInSec": 120})
	}))

	mux.HandleFunc("/api/blog-bridge/open", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !b.authorized(r) {
			http.Error(w, "pair token required", http.StatusUnauthorized)
			return
		}
		var body struct {
			CapabilityID string `json:"capabilityId"`
			// legacy fields rejected on purpose
			DownloadURL string `json:"downloadUrl"`
			Filename    string `json:"filename"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(body.DownloadURL) != "" && strings.TrimSpace(body.CapabilityID) == "" {
			http.Error(w, "raw downloadUrl is no longer accepted; create a capability first", http.StatusBadRequest)
			return
		}
		b.mu.Lock()
		b.cleanupCapabilitiesLocked()
		cap, ok := b.capabilities[strings.TrimSpace(body.CapabilityID)]
		if ok {
			delete(b.capabilities, cap.ID)
		}
		b.mu.Unlock()
		if !ok {
			http.Error(w, "capability_expired", http.StatusBadRequest)
			return
		}
		if time.Now().After(cap.ExpiresAt) {
			http.Error(w, "capability_expired", http.StatusBadRequest)
			return
		}
		filename := filepath.Base(cap.Filename)
		if filename == "" || filename == "." || strings.Contains(filename, "..") || !strings.HasSuffix(strings.ToLower(filename), ".tnote") {
			filename = fmt.Sprintf("blog-%s.tnote", cap.NoteID)
		}
		client := &http.Client{Timeout: 5 * time.Minute}
		resp, err := client.Get(cap.DownloadURL)
		if err != nil {
			http.Error(w, "download failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			http.Error(w, fmt.Sprintf("download status %d", resp.StatusCode), http.StatusBadGateway)
			return
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 500*1024*1024))
		if err != nil {
			http.Error(w, "read body failed", http.StatusBadGateway)
			return
		}
		root := notebooksRoot()
		if err := os.MkdirAll(root, 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		dest := filepath.Join(root, filename)
		// avoid overwrite collision
		if _, err := os.Stat(dest); err == nil {
			dest = filepath.Join(root, fmt.Sprintf("%s-%d.tnote", strings.TrimSuffix(filename, filepath.Ext(filename)), time.Now().Unix()))
		}
		// Ensure destination stays under notebooks root.
		cleanRoot, _ := filepath.Abs(root)
		cleanDest, _ := filepath.Abs(dest)
		if !strings.HasPrefix(cleanDest, cleanRoot+string(os.PathSeparator)) {
			http.Error(w, "invalid destination", http.StatusBadRequest)
			return
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		svc := &NotebookService{}
		meta, err := svc.ImportNotebook(dest)
		if err != nil {
			// file already in notebooks dir; register if needed
			meta, err = svc.RegisterExternalNotebook(dest)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
		// Keep remote note association so later updates target the same Blog note.
		store, _ := loadBlogSync()
		store.Entries[meta.ID] = blogSyncEntry{
			RemoteID:  cap.NoteID,
			Filename:  filepath.Base(meta.Path),
			UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}
		_ = saveBlogSync(store)
		if mainWindow != nil {
			mainWindow.EmitEvent("app:file-open-requested", map[string]any{
				"Args": []string{meta.Path},
			})
		}
		writeJSONResponse(w, map[string]any{"ok": true, "path": meta.Path, "id": meta.ID, "remoteId": cap.NoteID})
	}))

	ln, err := net.Listen("tcp", blogBridgeAddr)
	if err != nil {
		return nil, err
	}
	b.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		logEvent("info", "blog_bridge_started", map[string]interface{}{"addr": blogBridgeAddr})
		if err := b.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			logEvent("error", "blog_bridge_failed", map[string]interface{}{"error": err.Error()})
		}
	}()
	return b, nil
}

func (b *blogBridgeServer) Close() {
	if b == nil || b.server == nil {
		return
	}
	_ = b.server.Close()
}

func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (b *blogBridgeServer) authorized(r *http.Request) bool {
	token := strings.TrimSpace(r.Header.Get("X-TimeNotes-Pair-Token"))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("pairToken"))
	}
	return token != "" && subtleConstantTimeEq(token, b.pairToken)
}

func (b *blogBridgeServer) cleanupCapabilitiesLocked() {
	now := time.Now()
	for id, cap := range b.capabilities {
		if now.After(cap.ExpiresAt) {
			delete(b.capabilities, id)
		}
	}
}

func isAllowedDownloadURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	if !strings.HasPrefix(u.Path, "/files/") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	// allow same-host public blog downloads that still use short-lived /files tokens
	return host != "" && !strings.Contains(host, "/")
}

func randomBridgeToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func subtleConstantTimeEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func writeJSONResponse(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func encodeBase64(raw []byte) string {
	return base64.StdEncoding.EncodeToString(raw)
}
