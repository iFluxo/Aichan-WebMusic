package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"aichan-webmusic/internal/config"
	"aichan-webmusic/internal/handler"
	"aichan-webmusic/internal/music"
	"aichan-webmusic/internal/streaming"
	"aichan-webmusic/web"
)

var version = "1.0.0"

func main() {
	cfg := config.Load()
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("aichan-webmusic", version)
		return
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	if err := cfg.Validate(); err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	ytdlpPath, ytdlpErr := exec.LookPath(cfg.YTDLPPath)
	if ytdlpErr != nil {
		logger.Warn("yt-dlp not found; search and streaming will fail", "path", cfg.YTDLPPath)
	} else {
		logger.Info("music engine ready", "yt-dlp", ytdlpPath)
	}
	ffmpegPath, ffmpegErr := exec.LookPath(cfg.FFmpegPath)
	if ffmpegErr != nil {
		logger.Warn("ffmpeg not found; it is optional but recommended", "path", cfg.FFmpegPath)
	} else {
		logger.Info("audio tooling ready", "ffmpeg", ffmpegPath)
	}

	svc := music.New(cfg)
	proxy := streaming.New(svc, logger)
	api := handler.New(cfg, svc, proxy, logger, version)

	mux := http.NewServeMux()
	api.Register(mux)
	mux.Handle("/", staticHandler())

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler.Middleware(logger, mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0, // streams can stay open indefinitely
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		logger.Error("could not bind address", "addr", cfg.Addr, "error", err)
		os.Exit(1)
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("aichan music is live", "url", "http://"+displayAddr(ln.Addr().String()), "version", version)
		errCh <- httpServer.Serve(ln)
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		// Give in-flight requests a short window, then force-close long-lived
		// audio streams so the process (and any yt-dlp children) exits promptly.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Warn("graceful shutdown timed out; closing active connections", "error", err)
			if closeErr := httpServer.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
				logger.Error("could not close server", "error", closeErr)
			}
		}
	}
}

func staticHandler() http.Handler {
	fileServer := http.FileServerFS(web.Assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean(r.URL.Path)
		if strings.HasPrefix(p, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=86400")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func displayAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "" || host == "::" || host == "0.0.0.0" {
		host = "localhost"
	}
	return net.JoinHostPort(host, port)
}
