package music

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aichan-webmusic/internal/config"
)

const sampleSearchJSON = `{
  "entries": [
    {"id":"aaaaaaaaaaa","title":"First Song","channel":"Artist One","duration":215.4,"thumbnails":[
      {"url":"https://img/small.jpg","width":120},{"url":"https://img/medium.jpg","width":480},{"url":"https://img/large.jpg","width":1280}]},
    {"id":"bbbbbbbbbbb","title":"Live Radio","channel":"Live","live_status":"is_live","duration":null},
    {"id":"aaaaaaaaaaa","title":"Duplicate","channel":"Dup","duration":10},
    {"id":"ccccccccccc","title":"Second Song","uploader":"Uploader Two","duration":0},
    {"id":"bad id","title":"Broken","duration":20}
  ]
}`

func testConfig(t *testing.T, script string) config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "yt-dlp")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return config.Config{
		YTDLPPath:        path,
		FFmpegPath:       "ffmpeg",
		SearchLimit:      8,
		MaxSearchLimit:   12,
		MaxConcurrent:    2,
		SearchTimeout:    2 * time.Second,
		InfoTimeout:      2 * time.Second,
		ResolveTimeout:   2 * time.Second,
		MetadataCacheTTL: time.Minute,
		StreamCacheTTL:   time.Minute,
		DiscoverCacheTTL: time.Minute,
	}
}

func TestParseSearch(t *testing.T) {
	tracks, err := parseSearch([]byte(sampleSearchJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 2 {
		t.Fatalf("expected 2 valid tracks, got %d", len(tracks))
	}
	if tracks[0].ID != "aaaaaaaaaaa" || tracks[0].Channel != "Artist One" {
		t.Fatalf("unexpected first track: %+v", tracks[0])
	}
	if tracks[0].Duration != 215 {
		t.Fatalf("duration should round: %d", tracks[0].Duration)
	}
	if tracks[0].Thumbnail != "https://img/medium.jpg" {
		t.Fatalf("expected medium thumbnail, got %q", tracks[0].Thumbnail)
	}
	if tracks[1].Channel != "Uploader Two" {
		t.Fatalf("expected uploader fallback, got %q", tracks[1].Channel)
	}
	if tracks[1].Thumbnail != fallbackThumbnail("ccccccccccc") {
		t.Fatalf("expected fallback thumbnail, got %q", tracks[1].Thumbnail)
	}
}

func TestValidate(t *testing.T) {
	if err := ValidateID("dQw4w9WgXcQ"); err != nil {
		t.Fatalf("valid id rejected: %v", err)
	}
	for _, id := range []string{"", "short", "dQw4w9WgXc!", "dQw4w9WgXcQ-extra", "aaaaaaaaaaa'"} {
		if err := ValidateID(id); !errors.Is(err, ErrInvalidID) {
			t.Fatalf("expected invalid id for %q, got %v", id, err)
		}
	}
	if err := ValidateQuery("daft punk"); err != nil {
		t.Fatalf("valid query rejected: %v", err)
	}
	if err := ValidateQuery(strings.Repeat("x", 121)); !errors.Is(err, ErrInvalidQuery) {
		t.Fatalf("expected long query rejection, got %v", err)
	}
	if err := ValidateQuery("bad\x00query"); !errors.Is(err, ErrInvalidQuery) {
		t.Fatalf("expected control character rejection, got %v", err)
	}
}

func TestMimeForExt(t *testing.T) {
	cases := map[string]string{
		"m4a": "audio/mp4", "webm": "audio/webm", "opus": "audio/ogg",
		"mp3": "audio/mpeg", "weird": "audio/mp4",
	}
	for ext, want := range cases {
		if got := mimeForExt(ext); got != want {
			t.Fatalf("%s: got %q want %q", ext, got, want)
		}
	}
}

func TestSearchWithFakeYTDLP(t *testing.T) {
	cfg := testConfig(t, "#!/bin/sh\ncat <<'EOF'\n"+sampleSearchJSON+"\nEOF\n")
	svc := New(cfg)

	tracks, err := svc.Search(context.Background(), "test query", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 2 {
		t.Fatalf("expected 2 tracks, got %d", len(tracks))
	}

	// Second call should be served from cache (the fake would still work, but
	// this asserts the same slice comes back without error).
	again, err := svc.Search(context.Background(), "test query", 8)
	if err != nil || len(again) != 2 {
		t.Fatalf("cached search failed: %v", err)
	}
}

func TestSearchTimeout(t *testing.T) {
	cfg := testConfig(t, "#!/bin/sh\nsleep 5\n")
	cfg.SearchTimeout = 120 * time.Millisecond
	svc := New(cfg)

	start := time.Now()
	_, err := svc.Search(context.Background(), "slow query", 4)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("expected timeout, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout took too long: %v", elapsed)
	}
}

func TestStreamSource(t *testing.T) {
	cfg := testConfig(t, "#!/bin/sh\nprintf 'm4a|mp4a.40.2|https://example.com/audio.m4a\\n'\n")
	svc := New(cfg)

	src, err := svc.StreamSource(context.Background(), "dQw4w9WgXcQ")
	if err != nil {
		t.Fatal(err)
	}
	if src.URL != "https://example.com/audio.m4a" || src.MimeType != "audio/mp4" {
		t.Fatalf("unexpected source: %+v", src)
	}
	svc.InvalidateSource("dQw4w9WgXcQ")
	if _, ok := svc.sourceCache.Get("dQw4w9WgXcQ"); ok {
		t.Fatal("expected source cache to be invalidated")
	}
}

func TestStreamSourceSurvivesAbortedWaiter(t *testing.T) {
	cfg := testConfig(t, "#!/bin/sh\nsleep 0.3\nprintf 'm4a|mp4a.40.2|https://example.com/audio.m4a\\n'\n")
	svc := New(cfg)
	const id = "dQw4w9WgXcQ"

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderDone := make(chan error, 1)
	go func() {
		_, err := svc.StreamSource(leaderCtx, id)
		leaderDone <- err
	}()

	type result struct {
		src Source
		err error
	}
	secondDone := make(chan result, 1)
	go func() {
		src, err := svc.StreamSource(context.Background(), id)
		secondDone <- result{src: src, err: err}
	}()

	// Wait until both requests share the same in-flight resolve.
	deadline := time.Now().Add(2 * time.Second)
	for {
		svc.sourceMu.Lock()
		call := svc.sourceCalls[id]
		waiters := 0
		if call != nil {
			waiters = call.waiters
		}
		svc.sourceMu.Unlock()
		if waiters >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("second caller did not join the shared resolve (waiters=%d)", waiters)
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The aborted leader must not cancel the work the second caller still needs.
	cancelLeader()
	if err := <-leaderDone; !errors.Is(err, ErrTimeout) {
		t.Fatalf("expected leader timeout, got %v", err)
	}

	got := <-secondDone
	if got.err != nil {
		t.Fatalf("second caller failed after leader abort: %v", got.err)
	}
	if got.src.URL != "https://example.com/audio.m4a" {
		t.Fatalf("unexpected source: %+v", got.src)
	}
}

func TestHealth(t *testing.T) {
	cfg := testConfig(t, "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = \"--version\" ] && { echo 2026.10.26; exit 0; }; done\nexit 1\n")
	svc := New(cfg)
	h := svc.Health(context.Background())
	if !h.YTDLPAvailable || h.YTDLPVersion != "2026.10.26" {
		t.Fatalf("unexpected health: %+v", h)
	}
}
