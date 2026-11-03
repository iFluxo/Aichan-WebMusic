//go:build !unix

package music

import "os/exec"

// setProcessGroup is a no-op on platforms without process groups.
func setProcessGroup(cmd *exec.Cmd) {}
