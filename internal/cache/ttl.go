// Package cache provides a tiny in-memory TTL cache used for metadata,
// search results and resolved stream URLs.
package cache

import (
	"sync"
	"time"
)

type item[T any] struct {
	value   T
	expires time.Time
}

// TTL is a concurrency-safe, size-bounded cache with per-entry expiry.
type TTL[T any] struct {
	mu    sync.Mutex
	items map[string]item[T]
	ttl   time.Duration
	max   int
}

// New creates a cache that keeps entries for ttl and holds at most max items.
func New[T any](ttl time.Duration, max int) *TTL[T] {
	if max <= 0 {
		max = 128
	}
	return &TTL[T]{
		items: make(map[string]item[T]),
		ttl:   ttl,
		max:   max,
	}
}

// Get returns a cached value when it exists and has not expired.
func (c *TTL[T]) Get(key string) (T, bool) {
	var zero T
	c.mu.Lock()
	defer c.mu.Unlock()

	it, ok := c.items[key]
	if !ok {
		return zero, false
	}
	if time.Now().After(it.expires) {
		delete(c.items, key)
		return zero, false
	}
	return it.value, true
}

// Set stores a value, evicting expired entries when the cache is full.
func (c *TTL[T]) Set(key string, value T) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.items) >= c.max {
		now := time.Now()
		for k, v := range c.items {
			if now.After(v.expires) {
				delete(c.items, k)
			}
		}
		// Still full: drop an arbitrary entry so the cache stays bounded.
		for k := range c.items {
			if len(c.items) < c.max {
				break
			}
			delete(c.items, k)
		}
	}
	c.items[key] = item[T]{value: value, expires: time.Now().Add(c.ttl)}
}

// Delete removes a key from the cache.
func (c *TTL[T]) Delete(key string) {
	c.mu.Lock()
	delete(c.items, key)
	c.mu.Unlock()
}

// Len reports the number of stored entries (including expired ones).
func (c *TTL[T]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}
