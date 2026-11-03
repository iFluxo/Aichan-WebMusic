// Package config loads application configuration from environment
// variables with safe defaults.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds runtime configuration.
type Config struct {
	Addr string

	YTDLPPath  string
	FFmpegPath string

	SearchLimit    int
	MaxSearchLimit int

	MaxConcurrent int

	SearchTimeout    time.Duration
	InfoTimeout      time.Duration
	ResolveTimeout   time.Duration
	MetadataCacheTTL time.Duration
	StreamCacheTTL   time.Duration
	DiscoverCacheTTL time.Duration
}

// Load reads configuration from the environment.
func Load() Config {
	c := Config{
		Addr:             env("ADDR", ":8080"),
		YTDLPPath:        env("YTDLP_PATH", "yt-dlp"),
		FFmpegPath:       env("FFMPEG_PATH", "ffmpeg"),
		SearchLimit:      envInt("SEARCH_LIMIT", 12, 1, 30),
		MaxSearchLimit:   envInt("SEARCH_LIMIT_MAX", 24, 1, 50),
		MaxConcurrent:    envInt("MAX_CONCURRENT_YTDLP", 4, 1, 32),
		SearchTimeout:    envDuration("SEARCH_TIMEOUT", 30*time.Second),
		InfoTimeout:      envDuration("INFO_TIMEOUT", 30*time.Second),
		ResolveTimeout:   envDuration("RESOLVE_TIMEOUT", 45*time.Second),
		MetadataCacheTTL: envDuration("METADATA_CACHE_TTL", 10*time.Minute),
		StreamCacheTTL:   envDuration("STREAM_CACHE_TTL", 20*time.Minute),
		DiscoverCacheTTL: envDuration("DISCOVER_CACHE_TTL", 20*time.Minute),
	}
	if c.SearchLimit > c.MaxSearchLimit {
		c.SearchLimit = c.MaxSearchLimit
	}
	return c
}

// Validate reports configuration problems that should stop the server.
func (c Config) Validate() error {
	if strings.TrimSpace(c.Addr) == "" {
		return fmt.Errorf("ADDR must not be empty")
	}
	if strings.TrimSpace(c.YTDLPPath) == "" {
		return fmt.Errorf("YTDLP_PATH must not be empty")
	}
	if c.MaxConcurrent < 1 {
		return fmt.Errorf("MAX_CONCURRENT_YTDLP must be at least 1")
	}
	return nil
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
}

func envInt(key string, fallback, min, max int) int {
	raw, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < min || n > max {
		return fallback
	}
	return n
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}
