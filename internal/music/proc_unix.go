//go:build unix

package music

import (
	"os/exec"
	"syscall"
)

// setProcessGroup makes cancellation kill yt-dlp and any helper process it
// spawned, so a stuck child can never keep the output pipe open.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// Negative pid targets the whole process group.
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if err == syscall.ESRCH {
			return nil
		}
		return err
	}
}
