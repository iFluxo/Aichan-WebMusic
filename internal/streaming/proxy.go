// Package streaming proxies resolved audio with HTTP Range support so the
// HTML audio element can seek without downloading the full track first.
package streaming

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"aichan-webmusic/internal/music"
)

// ErrUpstreamStatus indicates the audio host returned an unusable status.
var ErrUpstreamStatus = errors.New("audio host returned an error")

// Resolver provides and invalidates direct audio sources.
type Resolver interface {
	StreamSource(ctx context.Context, id string) (music.Source, error)
	InvalidateSource(id string)
}

// Proxy streams remote audio through the backend.
type Proxy struct {
	resolver Resolver
	client   *http.Client
	logger   *slog.Logger
}

// New creates a streaming proxy.
func New(resolver Resolver, logger *slog.Logger) *Proxy {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          24,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second,
		DisableCompression:    true,
	}
	return &Proxy{
		resolver: resolver,
		client:   &http.Client{Transport: transport},
		logger:   logger,
	}
}

// Serve resolves and proxies the stream. The returned error is only for the
// resolve/first-response phase; once bytes are flowing errors are logged.
func (p *Proxy) Serve(w http.ResponseWriter, r *http.Request, id string) error {
	resolveCtx, cancel := context.WithTimeout(r.Context(), 50*time.Second)
	defer cancel()

	src, err := p.resolver.StreamSource(resolveCtx, id)
	if err != nil {
		return err
	}

	upstream, status, err := p.fetch(r, src, true)
	if err != nil {
		return err
	}

	// Expired or rejected URL: refresh once and retry.
	if status == http.StatusForbidden || status == http.StatusGone || status == http.StatusUnauthorized {
		if upstream != nil {
			upstream.Body.Close()
		}
		p.resolver.InvalidateSource(id)
		src, err = p.resolver.StreamSource(resolveCtx, id)
		if err != nil {
			return err
		}
		upstream, status, err = p.fetch(r, src, false)
		if err != nil {
			return err
		}
	}
	if upstream == nil {
		return fmt.Errorf("%w: status %d", ErrUpstreamStatus, status)
	}
	defer upstream.Body.Close()

	if upstream.StatusCode >= 400 {
		return fmt.Errorf("%w: status %d", ErrUpstreamStatus, upstream.StatusCode)
	}

	h := w.Header()
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")

	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" || strings.HasPrefix(contentType, "application/octet-stream") {
		contentType = src.MimeType
	}
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	if cl := upstream.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	if cr := upstream.Header.Get("Content-Range"); cr != "" {
		h.Set("Content-Range", cr)
	}

	if r.Method == http.MethodHead {
		w.WriteHeader(upstream.StatusCode)
		return nil
	}

	w.WriteHeader(upstream.StatusCode)
	if _, err := io.CopyBuffer(w, upstream.Body, make([]byte, 32<<10)); err != nil {
		if r.Context().Err() == nil {
			p.logger.Debug("stream copy stopped", "id", id, "error", err)
		}
	}
	return nil
}

func (p *Proxy) fetch(r *http.Request, src music.Source, get bool) (*http.Response, int, error) {
	method := http.MethodGet
	if !get {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(r.Context(), method, src.URL, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("build upstream request: %w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
	req.Header.Set("Referer", "https://www.youtube.com/")
	req.Header.Set("Accept", "*/*")
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		if r.Context().Err() != nil {
			return nil, 0, r.Context().Err()
		}
		return nil, 0, fmt.Errorf("%w: %v", ErrUpstreamStatus, err)
	}
	return resp, resp.StatusCode, nil
}
