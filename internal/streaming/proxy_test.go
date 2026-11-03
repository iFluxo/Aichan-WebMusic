package streaming

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"aichan-webmusic/internal/music"
)

type fakeResolver struct {
	url         string
	invalidated int32
}

func (f *fakeResolver) StreamSource(context.Context, string) (music.Source, error) {
	return music.Source{URL: f.url, MimeType: "audio/mp4", Ext: "m4a"}, nil
}

func (f *fakeResolver) InvalidateSource(string) {
	atomic.AddInt32(&f.invalidated, 1)
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newProxy(t *testing.T, resolver Resolver) *Proxy {
	t.Helper()
	return New(resolver, testLogger())
}

func TestProxyRangePassthrough(t *testing.T) {
	payload := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "audio.m4a", time.Unix(0, 0), bytes.NewReader(payload))
	}))
	defer upstream.Close()

	proxy := newProxy(t, &fakeResolver{url: upstream.URL})

	req := httptest.NewRequest(http.MethodGet, "/api/stream?id=dQw4w9WgXcQ", nil)
	req.Header.Set("Range", "bytes=5-14")
	rec := httptest.NewRecorder()

	if err := proxy.Serve(rec, req, "dQw4w9WgXcQ"); err != nil {
		t.Fatalf("serve failed: %v", err)
	}

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("expected 206, got %d", res.StatusCode)
	}
	if got := res.Header.Get("Content-Range"); got != "bytes 5-14/36" {
		t.Fatalf("unexpected content-range: %q", got)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "56789abcde" {
		t.Fatalf("unexpected body: %q", body)
	}
}

func TestProxyRetriesForbidden(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "audio/mp4")
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	resolver := &fakeResolver{url: upstream.URL}
	proxy := newProxy(t, resolver)

	req := httptest.NewRequest(http.MethodGet, "/api/stream?id=dQw4w9WgXcQ", nil)
	rec := httptest.NewRecorder()
	if err := proxy.Serve(rec, req, "dQw4w9WgXcQ"); err != nil {
		t.Fatalf("serve failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 after retry, got %d", rec.Code)
	}
	if atomic.LoadInt32(&resolver.invalidated) != 1 {
		t.Fatalf("expected one invalidation, got %d", resolver.invalidated)
	}
	if rec.Header().Get("Content-Type") != "audio/mp4" {
		t.Fatalf("unexpected content type: %q", rec.Header().Get("Content-Type"))
	}
}

func TestProxyHead(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mp4")
		w.Header().Set("Content-Length", "10")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxy := newProxy(t, &fakeResolver{url: upstream.URL})
	req := httptest.NewRequest(http.MethodHead, "/api/stream?id=dQw4w9WgXcQ", nil)
	rec := httptest.NewRecorder()
	if err := proxy.Serve(rec, req, "dQw4w9WgXcQ"); err != nil {
		t.Fatalf("serve failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body, got %d bytes", rec.Body.Len())
	}
}

func TestProxyUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	proxy := newProxy(t, &fakeResolver{url: upstream.URL})
	req := httptest.NewRequest(http.MethodGet, "/api/stream?id=dQw4w9WgXcQ", nil)
	rec := httptest.NewRecorder()
	err := proxy.Serve(rec, req, "dQw4w9WgXcQ")
	if err == nil || !errors.Is(err, ErrUpstreamStatus) {
		t.Fatalf("expected upstream error, got %v", err)
	}
}

func TestProxyResolverError(t *testing.T) {
	proxy := newProxy(t, errorResolver{})
	req := httptest.NewRequest(http.MethodGet, "/api/stream?id=dQw4w9WgXcQ", nil)
	rec := httptest.NewRecorder()
	if err := proxy.Serve(rec, req, "dQw4w9WgXcQ"); !errors.Is(err, music.ErrInvalidID) {
		t.Fatalf("expected resolver error, got %v", err)
	}
}

type errorResolver struct{}

func (errorResolver) StreamSource(context.Context, string) (music.Source, error) {
	return music.Source{}, music.ErrInvalidID
}
func (errorResolver) InvalidateSource(string) {}
