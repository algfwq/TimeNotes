package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math/bits"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// BlogLoginResult is returned by BlogLogin (password + PoW on one WS session).
type BlogLoginResult struct {
	Token       string `json:"token"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	ExpiresAt   int64  `json:"expiresAt"`
	CanUpload   bool   `json:"canUpload"`
	UserID      string `json:"userId"`
}

// blogWSEnvelope mirrors the Blog WebSocket JSON envelope used by the frontend.
type blogWSEnvelope struct {
	V       int             `json:"v"`
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// BlogLogin performs auth.pow.challenge + PoW solve + auth.login on ONE WebSocket.
// Blog server binds PoW to the websocket session id; splitting challenge/login across
// connections always returns "proof of work failed".
func (s *NotebookService) BlogLogin(blogURL string, username string, password string, timeoutMs int) (BlogLoginResult, error) {
	blogURL = strings.TrimSpace(blogURL)
	username = strings.TrimSpace(username)
	if blogURL == "" || username == "" || password == "" {
		return BlogLoginResult{}, errors.New("blog url, username and password required")
	}
	if timeoutMs <= 0 {
		timeoutMs = 120_000
	}
	if timeoutMs > 300_000 {
		timeoutMs = 300_000
	}
	wsURL, err := blogHTTPToWS(blogURL)
	if err != nil {
		return BlogLoginResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{})
	if err != nil {
		return BlogLoginResult{}, fmt.Errorf("无法连接 Blog WebSocket %s: %w", wsURL, err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	chRaw, err := blogWSRoundTripPayload(ctx, conn, "auth.pow.challenge", map[string]any{})
	if err != nil {
		return BlogLoginResult{}, fmt.Errorf("获取 PoW 挑战失败: %w", err)
	}
	chMap, ok := chRaw.(map[string]any)
	if !ok {
		return BlogLoginResult{}, errors.New("invalid pow challenge payload")
	}
	challengeID, _ := chMap["id"].(string)
	salt, _ := chMap["salt"].(string)
	difficulty := anyToInt(chMap["difficulty"])
	if challengeID == "" || salt == "" || difficulty < 1 {
		return BlogLoginResult{}, fmt.Errorf("invalid pow challenge: id=%q salt=%q difficulty=%d", challengeID, salt, difficulty)
	}
	nonce, err := solveBlogPoW(salt, difficulty)
	if err != nil {
		return BlogLoginResult{}, err
	}

	loginRaw, err := blogWSRoundTripPayload(ctx, conn, "auth.login", map[string]any{
		"username":    username,
		"password":    password,
		"challengeId": challengeID,
		"nonce":       nonce,
	})
	if err != nil {
		return BlogLoginResult{}, err
	}
	loginMap, ok := loginRaw.(map[string]any)
	if !ok {
		return BlogLoginResult{}, errors.New("invalid login payload")
	}
	token, _ := loginMap["token"].(string)
	if token == "" {
		return BlogLoginResult{}, errors.New("login response missing token")
	}
	// Best-effort session register (same connection).
	_, _ = blogWSRoundTripPayload(ctx, conn, "auth.session", map[string]any{"token": token})
	_, _ = blogWSRoundTripPayload(ctx, conn, "auth.ping", map[string]any{})

	out := BlogLoginResult{
		Token:     token,
		Username:  anyToString(loginMap["username"]),
		Role:      anyToString(loginMap["role"]),
		UserID:    anyToString(loginMap["userId"]),
		ExpiresAt: int64(anyToInt(loginMap["expiresAt"])),
		CanUpload: anyToBool(loginMap["canUpload"]),
	}
	if out.Username == "" {
		out.Username = username
	}
	return out, nil
}

// BlogWSRequest performs one Blog WebSocket RPC from native Go.
// Used on Android because the app page is served over HTTPS (wails.localhost)
// and the WebView blocks insecure ws:// mixed-content WebSockets.
//
// If authToken is non-empty and msgType is not auth.login / auth.pow.challenge,
// the connection first authenticates with auth.login {token} on the same socket.
// Returns the response payload as a JSON string (or "null").
//
// Do NOT use this for password login with PoW: call BlogLogin instead.
func (s *NotebookService) BlogWSRequest(blogURL string, authToken string, msgType string, payloadJSON string, timeoutMs int) (string, error) {
	blogURL = strings.TrimSpace(blogURL)
	msgType = strings.TrimSpace(msgType)
	if blogURL == "" {
		return "", errors.New("blog url required")
	}
	if msgType == "" {
		return "", errors.New("message type required")
	}
	if timeoutMs <= 0 {
		timeoutMs = 60_000
	}
	if timeoutMs > 300_000 {
		timeoutMs = 300_000
	}

	wsURL, err := blogHTTPToWS(blogURL)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{},
	})
	if err != nil {
		return "", fmt.Errorf("无法连接 Blog WebSocket %s: %w", wsURL, err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Optional pre-auth so multi-step upload can reuse token without browser WS.
	if tok := strings.TrimSpace(authToken); tok != "" && msgType != "auth.login" && msgType != "auth.pow.challenge" {
		if err := blogWSRoundTrip(ctx, conn, "auth.login", map[string]any{"token": tok}); err != nil {
			return "", fmt.Errorf("Blog 鉴权失败: %w", err)
		}
	}

	var payload any
	if strings.TrimSpace(payloadJSON) != "" && payloadJSON != "null" {
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			return "", fmt.Errorf("invalid payload json: %w", err)
		}
	}

	respPayload, err := blogWSRoundTripPayload(ctx, conn, msgType, payload)
	if err != nil {
		return "", err
	}
	if respPayload == nil {
		return "null", nil
	}
	raw, err := json.Marshal(respPayload)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func blogHTTPToWS(httpURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(httpURL))
	if err != nil {
		return "", fmt.Errorf("invalid blog url: %w", err)
	}
	if u.Scheme == "" {
		u, err = url.Parse("http://" + strings.TrimSpace(httpURL))
		if err != nil {
			return "", fmt.Errorf("invalid blog url: %w", err)
		}
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
		// already websocket
	default:
		return "", fmt.Errorf("unsupported blog url scheme %q", u.Scheme)
	}
	u.Path = "/ws"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func blogWSRoundTrip(ctx context.Context, conn *websocket.Conn, msgType string, payload any) error {
	_, err := blogWSRoundTripPayload(ctx, conn, msgType, payload)
	return err
}

func blogWSRoundTripPayload(ctx context.Context, conn *websocket.Conn, msgType string, payload any) (any, error) {
	id := fmt.Sprintf("g%d", time.Now().UnixNano())
	req := map[string]any{
		"v":    1,
		"type": msgType,
		"id":   id,
	}
	if payload != nil {
		req["payload"] = payload
	}
	if err := wsjson.Write(ctx, conn, req); err != nil {
		return nil, fmt.Errorf("send %s: %w", msgType, err)
	}

	for {
		var env blogWSEnvelope
		if err := wsjson.Read(ctx, conn, &env); err != nil {
			return nil, fmt.Errorf("recv %s: %w", msgType, err)
		}
		if env.ID != "" && env.ID != id {
			// Unrelated frame; keep waiting for our id.
			continue
		}
		if env.Error != nil {
			msg := env.Error.Message
			if msg == "" {
				msg = env.Error.Code
			}
			if msg == "" {
				msg = "blog request failed"
			}
			return nil, errors.New(msg)
		}
		if len(env.Payload) == 0 || string(env.Payload) == "null" {
			return nil, nil
		}
		var out any
		if err := json.Unmarshal(env.Payload, &out); err != nil {
			return nil, fmt.Errorf("decode payload: %w", err)
		}
		return out, nil
	}
}

// solveBlogPoW matches Blog server validPoW: SHA-256(salt+nonce) leading zero bits.
func solveBlogPoW(salt string, difficulty int) (string, error) {
	if difficulty < 1 {
		return "", errors.New("invalid pow difficulty")
	}
	// Cap work to keep mobile responsive; server max is 24 bits.
	const maxIter = 50_000_000
	for i := 0; i < maxIter; i++ {
		nonce := fmt.Sprintf("%d", i)
		sum := sha256.Sum256([]byte(salt + nonce))
		if leadingZeroBitsSHA(sum[:]) >= difficulty {
			return nonce, nil
		}
	}
	return "", errors.New("PoW 计算超时")
}

func leadingZeroBitsSHA(value []byte) int {
	count := 0
	for _, b := range value {
		if b == 0 {
			count += 8
			continue
		}
		return count + bits.LeadingZeros8(b)
	}
	return count
}

func anyToInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

func anyToString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func anyToBool(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}
