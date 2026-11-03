// Package handler tests exercise the HTTP API end to end with a fake yt-dlp
// binary, so no network access is required.
package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aichan-webmusic/internal/config"
	"aichan-webmusic/internal/music"
	"aichan-webmusic/internal/streaming"
)

const fakeSearch = `{
  "entries": [
    {"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","channel":"Rick Astley","duration":213,"thumbnails":[{"url":"https://img/cover.jpg","width":480}]},
    {"id":"aaaaaaaaaaa","title":"Second","channel":"Someone","duration":100,"thumbnails":[]}
  ]
}`

func newTestAPI(t *testing.T) *API {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "yt-dlp")
	content := "#!/bin/sh\n" +
		"for a in \"$@\"; do\n" +
		"  [ \"$a\" = \"--version\" ] && { echo 2026.10.26; exit 0; }\n" +
		"  [ \"$a\" = \"-f\" ] && { echo 'm4a|mp4a.40.2|https://example.com/audio.m4a'; exit 0; }\n" +
		"done\n" +
		"cat <<'EOF'\n" + fakeSearch + "\nEOF\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Addr:             ":0",
		YTDLPPath:        script,
		FFmpegPath:       "ffmpeg",
		SearchLimit:      8,
		MaxSearchLimit:   20,
		MaxConcurrent:    2,
		SearchTimeout:    5 * time.Second,
		InfoTimeout:      5 * time.Second,
		ResolveTimeout:   5 * time.Second,
		MetadataCacheTTL: time.Minute,
		StreamCacheTTL:   time.Minute,
		DiscoverCacheTTL: time.Minute,
	}
	logger := newTestLogger()
	svc := music.New(cfg)
	proxy := streaming.New(svc, logger)
	return New(cfg, svc, proxy, logger, "test")
}

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	newTestAPI(t).Register(mux)
	srv := httptest.NewServer(Middleware(newTestLogger(), mux))
	t.Cleanup(srv.Close)
	return srv
}

func TestHealthEndpoint(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["status"] != "ok" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestSearchEndpoint(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/search?q=rick+astley")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var payload struct {
		Query  string        `json:"query"`
		Count  int           `json:"count"`
		Tracks []music.Track `json:"tracks"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Count != 2 || len(payload.Tracks) != 2 {
		t.Fatalf("unexpected tracks: %+v", payload)
	}
	if payload.Tracks[0].ID != "dQw4w9WgXcQ" {
		t.Fatalf("unexpected first track: %+v", payload.Tracks[0])
	}
}

func TestSearchValidation(t *testing.T) {
	srv := newServer(t)
	cases := []string{
		"/api/search",
		"/api/search?q=",
		"/api/search?q=" + strings.Repeat("a", 121),
		"/api/search?q=ok&limit=0",
		"/api/search?q=ok&limit=999",
	}
	for _, path := range cases {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", path, res.StatusCode)
		}
	}
}

func TestInfoValidation(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/info?id=not-an-id")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", res.StatusCode)
	}
}

func TestStreamValidation(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/stream?id=bad$id")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", res.StatusCode)
	}
}

func TestResolveEndpoint(t *testing.T) {
	srv := newServer(t)

	res, err := http.Get(srv.URL + "/api/resolve?id=dQw4w9WgXcQ")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var payload struct {
		ID       string `json:"id"`
		Ready    bool   `json:"ready"`
		MimeType string `json:"mimeType"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.ID != "dQw4w9WgXcQ" || !payload.Ready || payload.MimeType != "audio/mp4" {
		t.Fatalf("unexpected payload: %+v", payload)
	}

	bad, err := http.Get(srv.URL + "/api/resolve?id=nope")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid id, got %d", bad.StatusCode)
	}
}

func TestSecurityHeaders(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff header")
	}
	if res.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("missing CSP header")
	}
}

func TestNotFoundRoute(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/nope")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", res.StatusCode)
	}
}
