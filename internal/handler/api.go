// Package handler wires HTTP endpoints to the music and streaming services.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"aichan-webmusic/internal/config"
	"aichan-webmusic/internal/music"
	"aichan-webmusic/internal/streaming"
)

// API exposes the JSON HTTP API.
type API struct {
	cfg     config.Config
	music   *music.Service
	proxy   *streaming.Proxy
	logger  *slog.Logger
	version string
	started time.Time
}

// New creates an API handler set.
func New(cfg config.Config, m *music.Service, p *streaming.Proxy, logger *slog.Logger, version string) *API {
	return &API{
		cfg:     cfg,
		music:   m,
		proxy:   p,
		logger:  logger,
		version: version,
		started: time.Now(),
	}
}

// Register mounts API routes on mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("GET /api/search", a.search)
	mux.HandleFunc("GET /api/info", a.info)
	mux.HandleFunc("GET /api/discover", a.discover)
	mux.HandleFunc("GET /api/resolve", a.resolve)
	mux.HandleFunc("GET /api/stream", a.stream)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	h := a.music.Health(ctx)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": a.version,
		"uptime":  time.Since(a.started).Round(time.Second).String(),
		"ytdlp":   map[string]any{"available": h.YTDLPAvailable, "version": h.YTDLPVersion},
		"ffmpeg":  map[string]any{"available": h.FFmpegAvailable},
	})
}

func (a *API) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if err := music.ValidateQuery(q); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", "Enter a search query between 1 and 120 characters.")
		return
	}

	limit := a.cfg.SearchLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > a.cfg.MaxSearchLimit {
			writeError(w, http.StatusBadRequest, "invalid_limit", "Limit must be a number within the allowed range.")
			return
		}
		limit = n
	}

	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.SearchTimeout+5*time.Second)
	defer cancel()

	tracks, err := a.music.Search(ctx, q, limit)
	if err != nil {
		a.upstreamError(w, r, "search", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"query":  q,
		"count":  len(tracks),
		"tracks": tracks,
	})
}

func (a *API) info(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if err := music.ValidateID(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "A valid video id is required.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.InfoTimeout+5*time.Second)
	defer cancel()

	track, err := a.music.Info(ctx, id)
	if err != nil {
		a.upstreamError(w, r, "info", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"track": track})
}

func (a *API) discover(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.SearchTimeout+10*time.Second)
	defer cancel()

	sections, err := a.music.Discover(ctx)
	if err != nil {
		a.upstreamError(w, r, "discover", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sections": sections})
}

func (a *API) stream(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if err := music.ValidateID(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "A valid video id is required.")
		return
	}
	if err := a.proxy.Serve(w, r, id); err != nil {
		a.upstreamError(w, r, "stream", err)
	}
}

// resolve prepares (and caches) a playable audio source without exposing the
// signed upstream URL. The client calls this before attaching the audio
// element, so slow extraction never trips browser media timeouts.
func (a *API) resolve(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if err := music.ValidateID(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "A valid video id is required.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.ResolveTimeout+5*time.Second)
	defer cancel()

	src, err := a.music.StreamSource(ctx, id)
	if err != nil {
		a.upstreamError(w, r, "resolve", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":        id,
		"ready":     true,
		"mimeType":  src.MimeType,
		"expiresAt": src.Expires.UTC().Format(time.RFC3339),
	})
}

func (a *API) upstreamError(w http.ResponseWriter, r *http.Request, op string, err error) {
	switch {
	case errors.Is(err, music.ErrInvalidID), errors.Is(err, music.ErrInvalidQuery):
		writeError(w, http.StatusBadRequest, "invalid_request", "The request is not valid.")
	case errors.Is(err, music.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "That track could not be found or is unavailable.")
	case errors.Is(err, music.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		a.logger.Warn("upstream timeout", "op", op, "error", err)
		writeError(w, http.StatusGatewayTimeout, "timeout", "The music engine took too long to respond. Please try again.")
	case errors.Is(err, context.Canceled):
		// Client went away; nothing useful to write.
		a.logger.Debug("request canceled", "op", op)
	default:
		a.logger.Error("upstream failure", "op", op, "error", err)
		writeError(w, http.StatusBadGateway, "upstream_error", "The music engine could not complete this request. Please try again.")
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		// Response is already committed; nothing further can be done.
		_ = err
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// Middleware adds logging, panic recovery and security headers.
func Middleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		defer func() {
			if v := recover(); v != nil {
				logger.Error("panic recovered", "panic", v, "stack", string(debug.Stack()))
				if !rec.wrote {
					writeError(rec, http.StatusInternalServerError, "internal_error", "Something went wrong.")
				}
			}
		}()

		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src 'self' https://fonts.gstatic.com; "+
				"img-src 'self' data: https://i.ytimg.com https://*.ytimg.com; "+
				"media-src 'self'; "+
				"connect-src 'self'; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'")

		next.ServeHTTP(rec, r)

		// Skip noisy per-chunk streaming logs only for successful streams.
		level := slog.LevelInfo
		if rec.status >= 500 {
			level = slog.LevelWarn
		}
		logger.Log(r.Context(), level, "http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration", time.Since(start).Round(time.Millisecond).String(),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wrote {
		s.wrote = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush lets the streaming proxy flush chunks if a wrapper adds buffering.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
