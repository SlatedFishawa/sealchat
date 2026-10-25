//go:build !windows

package pdfruntime

import (
	"os/exec"
	"syscall"
)

// configureProcess puts the tool in its own process group so cancellation also
// terminates browser helper processes (renderer, zygote, GPU).
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}

func startProcess(cmd *exec.Cmd) (func(), error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return func() {}, nil
}
