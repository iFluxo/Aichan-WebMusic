package cache

import (
	"testing"
	"time"
)

func TestTTLExpiry(t *testing.T) {
	c := New[string](40*time.Millisecond, 8)
	c.Set("a", "one")
	if v, ok := c.Get("a"); !ok || v != "one" {
		t.Fatalf("expected cached value, got %q %v", v, ok)
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok := c.Get("a"); ok {
		t.Fatal("expected entry to expire")
	}
}

func TestTTLDeleteAndBounds(t *testing.T) {
	c := New[int](time.Minute, 2)
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("c", 3)
	if c.Len() > 2 {
		t.Fatalf("cache exceeded bound: %d", c.Len())
	}
	c.Delete("a")
	if _, ok := c.Get("a"); ok {
		t.Fatal("expected deleted entry to be gone")
	}
}
