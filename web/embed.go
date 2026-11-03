// Package web embeds the frontend assets into the server binary.
package web

import "embed"

// Assets contains the static frontend (index.html and assets/).
//
//go:embed index.html assets
var Assets embed.FS
