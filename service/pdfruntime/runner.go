package pdfruntime

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// maxCapturedOutput bounds stdout/stderr kept from external tools so error
// messages cannot bloat logs or the export job row.
const maxCapturedOutput = 4096

// CommandRunner runs a short-lived external command. Implementations must pass
// path and args straight to the OS (no shell); tests inject fakes.
type CommandRunner interface {
	Run(ctx context.Context, path string, args ...string) ([]byte, error)
}

// ExecRunner is the production CommandRunner built on exec.CommandContext.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, path string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	out := &cappedBuffer{limit: maxCapturedOutput}
	cmd.Stdout = out
	cmd.Stderr = out
	configureProcess(cmd)
	cmd.WaitDelay = 2 * time.Second
	cleanup, err := startProcess(cmd)
	if err == nil {
		defer cleanup()
		err = cmd.Wait()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return out.Bytes(), ctxErr
	}
	return out.Bytes(), err
}

// cappedBuffer keeps the first limit bytes and the most recent limit bytes, which
// covers both version banners and the final error lines of a crash.
type cappedBuffer struct {
	mu    sync.Mutex
	limit int
	head  []byte
	tail  []byte
	cut   bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if room := b.limit - len(b.head); room > 0 {
		take := room
		if take > len(p) {
			take = len(p)
		}
		b.head = append(b.head, p[:take]...)
		p = p[take:]
	}
	if len(p) == 0 {
		return n, nil
	}
	b.tail = append(b.tail, p...)
	if len(b.tail) > b.limit {
		b.tail = append([]byte(nil), b.tail[len(b.tail)-b.limit:]...)
		b.cut = true
	}
	return n, nil
}

func (b *cappedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := append([]byte(nil), b.head...)
	if b.cut {
		out = append(out, []byte("\n…\n")...)
	}
	return append(out, b.tail...)
}

func (b *cappedBuffer) String() string { return string(b.Bytes()) }

// exitCoder is satisfied by *exec.ExitError and by test fakes.
type exitCoder interface{ ExitCode() int }

func exitCodeOf(err error) (int, bool) {
	var ec exitCoder
	if errors.As(err, &ec) {
		return ec.ExitCode(), true
	}
	return 0, false
}

// summarizeOutput trims tool output to a short single-paragraph diagnostic.
func summarizeOutput(out []byte) string {
	s := strings.TrimSpace(string(out))
	if len(s) > 600 {
		s = s[len(s)-600:]
	}
	return s
}
