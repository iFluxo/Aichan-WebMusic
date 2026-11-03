# Aichan Music

A personal music streaming web app with a colourful **liquid-glass** interface.
The backend is pure Go (standard library), while search, metadata and audio
resolution are powered by **yt-dlp**. Audio is proxied through the Go server so
the HTML5 `<audio>` element can seek with HTTP Range requests — nothing is
stored on disk permanently.

> Use this for personal listening only. Respect YouTube's Terms of Service and
> the rights of the artists you listen to.

---

## Features

- **Real search** via `yt-dlp` (`ytsearch`), with artwork, artist, duration and
  video id.
- **Real streaming** through `GET /api/stream?id=…`:
  - resolves a browser-compatible audio URL with `yt-dlp`;
  - proxies it with full `Range` support (instant seek, no full download);
  - retries once when the signed media URL expires;
  - cancels work and closes upstream connections when the browser disconnects.
- **Resolve-first playback**: a short `GET /api/resolve` warms the server-side
  source cache before the audio element attaches, so cold extraction never trips
  browser media timeouts. The first result and hovered tracks are prefetched.
- **Persistent player**: play/pause, previous/next, seek, volume, mute,
  auto-advance, loading and error states, Media Session API metadata/controls.
- **Queue**: add, play next, reorder (drag or arrows), remove, clear, live
  current-track highlight.
- **Library**: saved songs stored locally, plus lightweight playlists.
- **Home**: welcome, popular search shortcuts, real featured tracks, recently
  played history and real recommendations (all from live searches).
- **Keyboard shortcuts**, toasts, skeleton loaders, reduced-motion support,
  responsive layout for desktop and mobile.
- Zero frontend frameworks, zero Go dependencies, single binary with embedded
  static assets.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Go | 1.22+ | `go version` |
| yt-dlp | recent | `yt-dlp --version` — keep it updated |
| FFmpeg | optional | `ffmpeg -version` — useful for yt-dlp fallbacks |

Install the tools on Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Keep `yt-dlp` fresh; YouTube changes frequently:

```bash
sudo yt-dlp -U          # or: pipx upgrade yt-dlp / pip install -U yt-dlp
```

## Run

```bash
git clone <this-repo> aichan-music
cd aichan-music

go run ./cmd/server
# → http://localhost:8080
```

Build a single self-contained binary (frontend is embedded):

```bash
go build -trimpath -ldflags "-s -w" -o aichan-music ./cmd/server
./aichan-music
```

The server listens on `:8080` by default. Open <http://localhost:8080>.

## Configuration

All settings are optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ADDR` | `:8080` | Listen address (`127.0.0.1:8080`, `:9000`, …) |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg (health check only) |
| `SEARCH_LIMIT` | `12` | Default number of search results (1–30) |
| `SEARCH_LIMIT_MAX` | `24` | Upper bound accepted from clients |
| `MAX_CONCURRENT_YTDLP` | `4` | Concurrent yt-dlp processes |
| `SEARCH_TIMEOUT` | `30s` | Search timeout |
| `INFO_TIMEOUT` | `30s` | Metadata timeout |
| `RESOLVE_TIMEOUT` | `45s` | Stream-resolution timeout |
| `METADATA_CACHE_TTL` | `10m` | Search/info cache lifetime |
| `STREAM_CACHE_TTL` | `20m` | Resolved stream URL lifetime |
| `DISCOVER_CACHE_TTL` | `20m` | Home recommendations cache |

Example:

```bash
ADDR=127.0.0.1:8080 MAX_CONCURRENT_YTDLP=2 ./aichan-music
```

## API

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Engine status, yt-dlp/FFmpeg availability, uptime |
| `GET /api/search?q=…&limit=…` | Search tracks (`limit` capped by `SEARCH_LIMIT_MAX`) |
| `GET /api/info?id=…` | Track metadata for an 11-character YouTube id |
| `GET /api/resolve?id=…` | Resolve and cache a playable source before playback starts |
| `GET /api/stream?id=…` | Proxied audio stream with `Range`/seek support |
| `GET /api/discover` | Home sections built from real searches |

Errors use a stable shape:

```json
{ "error": { "code": "timeout", "message": "The music engine took too long…" } }
```

Inputs are validated (`^[A-Za-z0-9_-]{11}$` for ids, 1–120 printable characters
for queries). No user input ever reaches a shell; yt-dlp is executed with an
argument vector and no shell. Subprocesses run under `context` deadlines, with a
hard concurrency limit, bounded output and `WaitDelay` so none are left behind.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `←` / `→` | Seek 5 s |
| `↑` / `↓` | Volume ±5% |
| `M` | Mute / unmute |
| `N` / `P` | Next / previous |
| `Q` | Toggle queue drawer |
| `/` | Focus search |
| `Esc` | Close dialog / drawer |

Media keys are wired through the Media Session API where supported.

## Project layout

```
.
├── cmd/server/main.go        # config, HTTP server, graceful shutdown, static files
├── internal/
│   ├── cache/                # small generic TTL cache
│   ├── config/               # environment configuration
│   ├── handler/              # JSON API, validation, middleware, security headers
│   ├── music/                # yt-dlp service: search, info, stream resolution, discover
│   └── streaming/            # range-aware audio proxy + retry logic
├── web/                      # embedded frontend
│   ├── index.html
│   ├── embed.go
│   └── assets/{css,js,images,audio}
├── go.mod
└── README.md
```

## Testing

```bash
go vet ./...
go test ./...
```

The tests use a fake `yt-dlp` shell script and local `httptest` servers, so they
do not touch the network or YouTube.

Manual smoke test:

```bash
# health
curl -s localhost:8080/api/health | jq
# search
curl -s 'localhost:8080/api/search?q=daft%20punk' | jq '.tracks[0]'
# stream headers (seekable)
curl -sI -H 'Range: bytes=0-1023' 'localhost:8080/api/stream?id=dQw4w9WgXcQ'
```

## Troubleshooting

- **“Sign in to confirm you’re not a bot”** — update yt-dlp
  (`yt-dlp -U`) and/or export cookies with `YTDLP_COOKIES` style options on the
  yt-dlp command. Some networks/IP ranges are challenged by YouTube.
- **Search works but playback stalls** — check that `yt-dlp -g -f
  "bestaudio[ext=m4a]/bestaudio" <url>` returns a URL and that the server can
  reach `*.googlevideo.com` over HTTPS.
- **404/502 while streaming** — the track may be region-locked, private or
  removed. The UI surfaces a toast and lets you skip.
- **FFmpeg not found** — streaming works without it for m4a/webm sources; it is
  only reported in `/api/health` and used by yt-dlp when needed.

## License

See [LICENSE](LICENSE).
