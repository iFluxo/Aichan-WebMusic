// Package music integrates with yt-dlp for search, metadata and resolving
// browser-compatible audio streams.
package music

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"aichan-webmusic/internal/cache"
	"aichan-webmusic/internal/config"
)

var (
	// ErrInvalidID is returned for malformed video identifiers.
	ErrInvalidID = errors.New("invalid video id")
	// ErrInvalidQuery is returned for empty or oversized search queries.
	ErrInvalidQuery = errors.New("invalid search query")
	// ErrNotFound is returned when yt-dlp reports unavailable media.
	ErrNotFound = errors.New("track not found or unavailable")
	// ErrTimeout is returned when a yt-dlp invocation exceeds its deadline.
	ErrTimeout = errors.New("upstream request timed out")
	// ErrUpstream is returned for any other yt-dlp failure.
	ErrUpstream = errors.New("upstream request failed")
)

var videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// Track is the public metadata shape shared with the frontend.
type Track struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Channel   string `json:"channel"`
	Duration  int    `json:"duration"`
	Thumbnail string `json:"thumbnail"`
	Live      bool   `json:"live,omitempty"`
}

// Section is a group of tracks shown on the home screen.
type Section struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Subtitle string  `json:"subtitle"`
	Tracks   []Track `json:"tracks"`
}

// Source describes a resolved, browser-playable audio stream.
type Source struct {
	URL      string    `json:"-"`
	Ext      string    `json:"-"`
	MimeType string    `json:"-"`
	Expires  time.Time `json:"-"`
}

// Health describes the availability of external tools.
type Health struct {
	YTDLPAvailable  bool   `json:"ytdlpAvailable"`
	YTDLPVersion    string `json:"ytdlpVersion,omitempty"`
	FFmpegAvailable bool   `json:"ffmpegAvailable"`
}

// Service runs yt-dlp safely with concurrency limits, timeouts and caching.
type Service struct {
	cfg config.Config

	sem chan struct{}

	searchCache   *cache.TTL[[]Track]
	infoCache     *cache.TTL[Track]
	sourceCache   *cache.TTL[Source]
	discoverCache *cache.TTL[[]Section]
	healthCache   *cache.TTL[Health]

	sourceMu    sync.Mutex
	sourceCalls map[string]*sourceCall
}

type sourceCall struct {
	id      string
	done    chan struct{}
	src     Source
	err     error
	waiters int
	cancel  context.CancelFunc
}

// New creates a music service.
func New(cfg config.Config) *Service {
	return &Service{
		cfg:           cfg,
		sem:           make(chan struct{}, cfg.MaxConcurrent),
		searchCache:   cache.New[[]Track](cfg.MetadataCacheTTL, 256),
		infoCache:     cache.New[Track](cfg.MetadataCacheTTL, 256),
		sourceCache:   cache.New[Source](cfg.StreamCacheTTL, 128),
		discoverCache: cache.New[[]Section](cfg.DiscoverCacheTTL, 4),
		healthCache:   cache.New[Health](60*time.Second, 1),
		sourceCalls:   make(map[string]*sourceCall),
	}
}

// ValidateID checks a YouTube video identifier.
func ValidateID(id string) error {
	if !videoIDPattern.MatchString(id) {
		return ErrInvalidID
	}
	return nil
}

// ValidateQuery checks a user supplied search query.
func ValidateQuery(q string) error {
	q = strings.TrimSpace(q)
	if len(q) == 0 || len(q) > 120 {
		return ErrInvalidQuery
	}
	for _, r := range q {
		if r < 0x20 || r == 0x7f {
			return ErrInvalidQuery
		}
	}
	return nil
}

// Search returns up to limit results for the query.
func (s *Service) Search(ctx context.Context, query string, limit int) ([]Track, error) {
	query = strings.TrimSpace(query)
	if err := ValidateQuery(query); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = s.cfg.SearchLimit
	}
	if limit > s.cfg.MaxSearchLimit {
		limit = s.cfg.MaxSearchLimit
	}

	key := strconv.Itoa(limit) + "|" + strings.ToLower(query)
	if cached, ok := s.searchCache.Get(key); ok {
		return cached, nil
	}

	out, err := s.run(ctx, s.cfg.SearchTimeout,
		"--no-warnings",
		"--ignore-errors",
		"--no-playlist",
		"--flat-playlist",
		"-J",
		fmt.Sprintf("ytsearch%d:%s", limit, query),
	)
	if err != nil {
		return nil, err
	}

	tracks, err := parseSearch(out)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	if len(tracks) == 0 {
		return nil, ErrNotFound
	}
	s.searchCache.Set(key, tracks)
	return tracks, nil
}

// Info fetches metadata for a single video.
func (s *Service) Info(ctx context.Context, id string) (Track, error) {
	if err := ValidateID(id); err != nil {
		return Track{}, err
	}
	if cached, ok := s.infoCache.Get(id); ok {
		return cached, nil
	}

	out, err := s.run(ctx, s.cfg.InfoTimeout,
		"--no-warnings",
		"--no-playlist",
		"--skip-download",
		"-O", `%(.{id,title,channel,duration,thumbnail,webpage_url,is_live})j`,
		watchURL(id),
	)
	if err != nil {
		return Track{}, err
	}

	var raw struct {
		ID        string  `json:"id"`
		Title     string  `json:"title"`
		Channel   string  `json:"channel"`
		Duration  float64 `json:"duration"`
		Thumbnail string  `json:"thumbnail"`
		IsLive    bool    `json:"is_live"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &raw); err != nil {
		return Track{}, fmt.Errorf("%w: malformed metadata", ErrUpstream)
	}
	if raw.ID == "" || raw.Title == "" {
		return Track{}, ErrNotFound
	}
	if err := ValidateID(raw.ID); err != nil {
		return Track{}, ErrNotFound
	}
	if raw.IsLive {
		return Track{}, ErrNotFound
	}

	t := Track{
		ID:        raw.ID,
		Title:     raw.Title,
		Channel:   raw.Channel,
		Duration:  int(raw.Duration + 0.5),
		Thumbnail: raw.Thumbnail,
	}
	if t.Thumbnail == "" {
		t.Thumbnail = fallbackThumbnail(t.ID)
	}
	s.infoCache.Set(id, t)
	return t, nil
}

// StreamSource resolves a direct audio URL that browsers can play. Concurrent
// requests for the same id share one yt-dlp invocation. The shared work runs on
// a detached context and is cancelled once every waiting request has gone away,
// so one aborted caller (for example a speculative prefetch) cannot fail the
// requests that are still waiting.
func (s *Service) StreamSource(ctx context.Context, id string) (Source, error) {
	if err := ValidateID(id); err != nil {
		return Source{}, err
	}
	if cached, ok := s.sourceCache.Get(id); ok && time.Now().Before(cached.Expires) {
		return cached, nil
	}

	s.sourceMu.Lock()
	if call, ok := s.sourceCalls[id]; ok {
		call.waiters++
		s.sourceMu.Unlock()
		return s.waitSource(ctx, call)
	}

	resolveCtx, cancel := context.WithCancel(context.Background())
	call := &sourceCall{id: id, done: make(chan struct{}), waiters: 1, cancel: cancel}
	s.sourceCalls[id] = call
	s.sourceMu.Unlock()

	go func() {
		src, err := s.resolveSource(resolveCtx, id)
		cancel()

		s.sourceMu.Lock()
		call.src, call.err = src, err
		if s.sourceCalls[id] == call {
			delete(s.sourceCalls, id)
		}
		close(call.done)
		s.sourceMu.Unlock()
	}()

	return s.waitSource(ctx, call)
}

func (s *Service) waitSource(ctx context.Context, call *sourceCall) (Source, error) {
	select {
	case <-call.done:
		return call.src, call.err
	case <-ctx.Done():
		s.sourceMu.Lock()
		call.waiters--
		if call.waiters <= 0 && call.cancel != nil {
			call.cancel()
			call.cancel = nil
			if s.sourceCalls[call.id] == call {
				delete(s.sourceCalls, call.id)
			}
		}
		s.sourceMu.Unlock()
		return Source{}, ErrTimeout
	}
}

func (s *Service) resolveSource(ctx context.Context, id string) (Source, error) {
	out, err := s.run(ctx, s.cfg.ResolveTimeout,
		"--no-warnings",
		"--no-playlist",
		"-f", "bestaudio[ext=m4a]/bestaudio",
		"-O", "%(ext)s|%(acodec)s|%(url)s",
		watchURL(id),
	)
	if err != nil {
		return Source{}, err
	}

	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	parts := strings.SplitN(line, "|", 3)
	if len(parts) != 3 || !strings.HasPrefix(parts[2], "http") {
		return Source{}, fmt.Errorf("%w: no audio stream found", ErrUpstream)
	}

	ext := strings.ToLower(strings.TrimSpace(parts[0]))
	src := Source{
		URL:      strings.TrimSpace(parts[2]),
		Ext:      ext,
		MimeType: mimeForExt(ext),
		Expires:  time.Now().Add(s.cfg.StreamCacheTTL),
	}
	s.sourceCache.Set(id, src)
	return src, nil
}

// InvalidateSource drops a cached stream URL (used after upstream 403s).
func (s *Service) InvalidateSource(id string) {
	s.sourceCache.Delete(id)
}

// Health reports external tool availability.
func (s *Service) Health(ctx context.Context) Health {
	if cached, ok := s.healthCache.Get("health"); ok {
		return cached
	}

	h := Health{}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	if out, err := s.run(ctx, 5*time.Second, "--version"); err == nil {
		h.YTDLPAvailable = true
		h.YTDLPVersion = strings.TrimSpace(string(out))
	}
	if _, err := exec.LookPath(s.cfg.FFmpegPath); err == nil {
		h.FFmpegAvailable = true
	}
	s.healthCache.Set("health", h)
	return h
}

var discoverSpecs = []struct {
	ID       string
	Title    string
	Subtitle string
	Query    string
}{
	{
		ID:       "mood",
		Title:    "Made for your mood",
		Subtitle: "Dreamy, warm tracks from a live search",
		Query:    "dreamy chill pop mix",
	},
	{
		ID:       "fresh",
		Title:    "Fresh finds",
		Subtitle: "New music surfacing right now",
		Query:    "new music this week",
	},
	{
		ID:       "focus",
		Title:    "Focus flow",
		Subtitle: "Instrumental beats to keep you in the zone",
		Query:    "lofi study beats",
	},
}

// Discover returns curated sections populated with real search results.
func (s *Service) Discover(ctx context.Context) ([]Section, error) {
	if cached, ok := s.discoverCache.Get("discover"); ok {
		return cached, nil
	}

	type result struct {
		idx    int
		tracks []Track
		err    error
	}
	results := make(chan result, len(discoverSpecs))
	var wg sync.WaitGroup
	for i, spec := range discoverSpecs {
		wg.Add(1)
		go func(i int, spec struct {
			ID       string
			Title    string
			Subtitle string
			Query    string
		}) {
			defer wg.Done()
			tracks, err := s.Search(ctx, spec.Query, 8)
			results <- result{idx: i, tracks: tracks, err: err}
		}(i, spec)
	}
	wg.Wait()
	close(results)

	collected := make([][]Track, len(discoverSpecs))
	var lastErr error
	okCount := 0
	for r := range results {
		if r.err != nil {
			lastErr = r.err
			continue
		}
		collected[r.idx] = r.tracks
		okCount++
	}
	if okCount == 0 {
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, ErrUpstream
	}

	sections := make([]Section, 0, len(discoverSpecs))
	for i, spec := range discoverSpecs {
		if len(collected[i]) == 0 {
			continue
		}
		sections = append(sections, Section{
			ID:       spec.ID,
			Title:    spec.Title,
			Subtitle: spec.Subtitle,
			Tracks:   collected[i],
		})
	}
	s.discoverCache.Set("discover", sections)
	return sections, nil
}

// run executes yt-dlp with a timeout and a hard concurrency limit.
func (s *Service) run(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ErrTimeout
	}

	cmd := exec.CommandContext(ctx, s.cfg.YTDLPPath, args...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Env = append(os.Environ(), "LC_ALL=C.UTF-8")
	setProcessGroup(cmd)

	stdout := &limitedBuffer{limit: 8 << 20}
	stderr := &limitedBuffer{limit: 64 << 10}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil || errors.Is(err, exec.ErrWaitDelay) {
			return nil, ErrTimeout
		}
		msg := strings.ToLower(stderr.String())
		if strings.Contains(msg, "not available") ||
			strings.Contains(msg, "unavailable") ||
			strings.Contains(msg, "private video") ||
			strings.Contains(msg, "video unavailable") ||
			strings.Contains(msg, "does not exist") {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("%w: %s", ErrUpstream, firstLine(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func parseSearch(data []byte) ([]Track, error) {
	var raw struct {
		Entries []struct {
			ID         string  `json:"id"`
			Title      string  `json:"title"`
			Channel    string  `json:"channel"`
			Uploader   string  `json:"uploader"`
			Duration   float64 `json:"duration"`
			LiveStatus string  `json:"live_status"`
			Thumbnails []struct {
				URL    string `json:"url"`
				Width  int    `json:"width"`
				Height int    `json:"height"`
			} `json:"thumbnails"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	seen := make(map[string]struct{}, len(raw.Entries))
	tracks := make([]Track, 0, len(raw.Entries))
	for _, e := range raw.Entries {
		if !videoIDPattern.MatchString(e.ID) || strings.TrimSpace(e.Title) == "" {
			continue
		}
		if e.LiveStatus == "is_live" || e.LiveStatus == "is_upcoming" || e.LiveStatus == "post_live" {
			continue
		}
		if _, dup := seen[e.ID]; dup {
			continue
		}
		seen[e.ID] = struct{}{}

		channel := e.Channel
		if channel == "" {
			channel = e.Uploader
		}
		t := Track{
			ID:        e.ID,
			Title:     e.Title,
			Channel:   channel,
			Duration:  int(e.Duration + 0.5),
			Thumbnail: pickThumbnail(e.Thumbnails, e.ID),
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

func pickThumbnail(thumbs []struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}, id string) string {
	best := ""
	bestWidth := -1
	for _, t := range thumbs {
		if t.URL == "" {
			continue
		}
		if t.Width >= 320 && t.Width <= 800 && t.Width > bestWidth {
			best = t.URL
			bestWidth = t.Width
		}
	}
	if best == "" {
		for _, t := range thumbs {
			if t.URL != "" {
				best = t.URL
				break
			}
		}
	}
	if best == "" {
		return fallbackThumbnail(id)
	}
	return best
}

func fallbackThumbnail(id string) string {
	return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
}

func mimeForExt(ext string) string {
	switch ext {
	case "m4a", "mp4":
		return "audio/mp4"
	case "webm":
		return "audio/webm"
	case "opus":
		return "audio/ogg"
	case "mp3":
		return "audio/mpeg"
	case "ogg", "oga":
		return "audio/ogg"
	default:
		return "audio/mp4"
	}
}

func watchURL(id string) string {
	return "https://www.youtube.com/watch?v=" + id
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "no output"
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// limitedBuffer is an io.Writer that stops storing after limit bytes while
// still accepting writes, so subprocesses never block on a full pipe.
type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := b.limit - b.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.buf.Write(p)
	}
	return n, nil
}

func (b *limitedBuffer) Bytes() []byte  { return b.buf.Bytes() }
func (b *limitedBuffer) String() string { return b.buf.String() }
