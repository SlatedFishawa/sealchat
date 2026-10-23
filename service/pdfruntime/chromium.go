package pdfruntime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// RendererName is the stable adapter name stored in configuration.
const RendererName = "chromium-cli"

// ReadyGlobal is the page global a render surface sets to report completion:
// {status: "pending" | "ready" | "failed", error?: string, ...report}.
const ReadyGlobal = "__SEALCHAT_LOG_PDF__"

// MaxChunkPDFBytes caps a single rendered PDF on disk.
const MaxChunkPDFBytes = int64(1 << 30)

var (
	ErrRenderTimeout   = errors.New("PDF 渲染超时")
	ErrRenderCrashed   = errors.New("浏览器渲染进程崩溃")
	ErrSurfaceFailed   = errors.New("PDF 渲染页面报告失败")
	ErrBrowserExited   = errors.New("浏览器进程意外退出")
	ErrOutputTooLarge  = errors.New("PDF 输出超过大小上限")
	errReadyStateShape = errors.New("渲染状态格式无效")
)

// Browser identifies a probed browser binary.
type Browser struct {
	Path    string
	Kind    string
	Version string
}

// RenderRequest describes one page to print. URL must be produced by the caller
// (a loopback render surface or a data: URL); users never supply it directly.
type RenderRequest struct {
	URL        string
	OutputPath string
	// WorkDir hosts the per-render temporary browser profile.
	WorkDir string
	Timeout time.Duration
}

// RenderResult carries the surface's final ready state for the caller to decode.
type RenderResult struct {
	State json.RawMessage
	Bytes int64
}

// SurfaceError is returned when the surface reported status "failed".
type SurfaceError struct{ Message string }

func (e *SurfaceError) Error() string {
	if e.Message == "" {
		return ErrSurfaceFailed.Error()
	}
	return ErrSurfaceFailed.Error() + "：" + e.Message
}

func (e *SurfaceError) Unwrap() error { return ErrSurfaceFailed }

// PDFRenderer turns a render request into a PDF file.
type PDFRenderer interface {
	Render(ctx context.Context, req RenderRequest) (*RenderResult, error)
}

// ChromiumRenderer drives a Chromium-family browser over the DevTools protocol
// (pipe transport, or an ephemeral loopback port on Windows). No Node runtime,
// Playwright or Puppeteer is involved.
type ChromiumRenderer struct {
	Browser   Browser
	NoSandbox bool
	// GOOS overrides transport selection in tests.
	GOOS string
	// PollInterval is how often the ready global is checked.
	PollInterval time.Duration
}

func (r *ChromiumRenderer) goos() string {
	if r.GOOS != "" {
		return r.GOOS
	}
	return runtime.GOOS
}

// BrowserArgs returns the fixed argument list for one render. Every value is
// controlled by the adapter; nothing from LOG content or users is interpolated
// except the adapter-owned profile directory.
func (r *ChromiumRenderer) BrowserArgs(profileDir string, pipe bool) []string {
	args := []string{}
	if r.Browser.Kind != KindChromeHeadlessShell {
		args = append(args, "--headless")
	}
	if pipe {
		args = append(args, "--remote-debugging-pipe")
	} else {
		args = append(args, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1")
	}
	args = append(args,
		"--user-data-dir="+profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-sync",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions",
		"--metrics-recording-only",
		"--mute-audio",
		"--hide-scrollbars",
		"--no-proxy-server",
		// The surface is served from the loopback IP literal; every other host fails to
		// resolve so rendered content cannot reach external sites even if CSP were bypassed.
		"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
		"--font-render-hinting=none",
	)
	if r.NoSandbox {
		args = append(args, "--no-sandbox")
	}
	return append(args, "about:blank")
}

type browserProcess struct {
	cmd     *exec.Cmd
	conn    *cdpConn
	stderr  *cappedBuffer
	exited  chan struct{}
	waitErr error
	cleanup func()
}

func (r *ChromiumRenderer) launch(ctx context.Context, profileDir string) (*browserProcess, error) {
	pipe := r.goos() != "windows"
	cmd := exec.CommandContext(ctx, r.Browser.Path, r.BrowserArgs(profileDir, pipe)...)
	configureProcess(cmd)
	cmd.WaitDelay = 3 * time.Second
	stderr := &cappedBuffer{limit: maxCapturedOutput}
	cmd.Stdout = stderr
	cmd.Stderr = stderr
	cmd.Dir = profileDir
	env := os.Environ()
	if r.goos() != "windows" {
		// Keep NSS databases, caches and crash dumps inside the throwaway profile.
		env = append(env, "HOME="+profileDir, "XDG_CONFIG_HOME="+profileDir, "XDG_CACHE_HOME="+profileDir)
	}
	cmd.Env = env

	var childIn, childOut, parentIn, parentOut *os.File
	if pipe {
		var err error
		if childIn, parentOut, err = os.Pipe(); err != nil {
			return nil, err
		}
		if parentIn, childOut, err = os.Pipe(); err != nil {
			childIn.Close()
			parentOut.Close()
			return nil, err
		}
		cmd.ExtraFiles = []*os.File{childIn, childOut}
	}
	cleanup, err := startProcess(cmd)
	if err != nil {
		for _, f := range []*os.File{childIn, childOut, parentIn, parentOut} {
			if f != nil {
				f.Close()
			}
		}
		return nil, fmt.Errorf("无法启动浏览器: %w", err)
	}
	p := &browserProcess{cmd: cmd, stderr: stderr, exited: make(chan struct{}), cleanup: cleanup}
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
	}()
	if pipe {
		childIn.Close()
		childOut.Close()
		p.conn = newCDPConn(newPipeTransport(parentOut, parentIn))
		return p, nil
	}
	wsURL, err := waitDevToolsActivePort(ctx, profileDir, p.exited)
	if err != nil {
		p.kill()
		p.cleanup()
		return nil, fmt.Errorf("等待 DevTools 调试端口: %w", p.describe(err))
	}
	t, err := dialWSTransport(ctx, wsURL)
	if err != nil {
		p.kill()
		p.cleanup()
		return nil, fmt.Errorf("无法连接浏览器控制端口: %w", p.describe(err))
	}
	p.conn = newCDPConn(t)
	return p, nil
}

func waitDevToolsActivePort(ctx context.Context, profileDir string, exited <-chan struct{}) (string, error) {
	path := filepath.Join(profileDir, "DevToolsActivePort")
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if raw, err := os.ReadFile(path); err == nil {
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			if len(lines) >= 2 {
				port, perr := strconv.Atoi(strings.TrimSpace(lines[0]))
				wsPath := strings.TrimSpace(lines[1])
				if perr == nil && port > 0 && port < 65536 && strings.HasPrefix(wsPath, "/devtools/browser/") {
					return "ws://127.0.0.1:" + strconv.Itoa(port) + wsPath, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-exited:
			return "", ErrBrowserExited
		case <-ticker.C:
		}
	}
}

func (p *browserProcess) kill() {
	if p.cmd.Cancel != nil {
		_ = p.cmd.Cancel()
	} else if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.exited:
	case <-time.After(5 * time.Second):
	}
}

// shutdown asks the browser to close and falls back to killing its process group.
func (p *browserProcess) shutdown() {
	defer p.cleanup()
	if p.conn != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = p.conn.Call(ctx, "", "Browser.close", nil, nil)
		cancel()
	}
	select {
	case <-p.exited:
	case <-time.After(3 * time.Second):
		p.kill()
	}
	// Even after a clean exit, helper processes might linger in the group.
	if p.cmd.Cancel != nil {
		_ = p.cmd.Cancel()
	}
	if p.conn != nil {
		_ = p.conn.Close()
	}
}

func (p *browserProcess) describe(err error) error {
	if err == nil {
		return nil
	}
	closed := errors.Is(err, errCDPClosed) || errors.Is(err, io.EOF)
	exited := false
	if closed {
		// The pipe usually closes slightly before Wait observes the exit.
		select {
		case <-p.exited:
			exited = true
		case <-time.After(2 * time.Second):
		}
	} else {
		select {
		case <-p.exited:
			exited = true
		default:
		}
	}
	if !exited {
		return err
	}
	if closed {
		err = ErrBrowserExited
	}
	if msg := summarizeOutput(p.stderr.Bytes()); msg != "" {
		return fmt.Errorf("%w（%s）", err, msg)
	}
	return err
}

type readyState struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

// Render opens req.URL in a fresh profile, waits for the surface to report ready,
// prints with CSS page size and background graphics, and streams the PDF to
// req.OutputPath. The caller validates and atomically publishes the file.
func (r *ChromiumRenderer) Render(parent context.Context, req RenderRequest) (*RenderResult, error) {
	if r.Browser.Path == "" {
		return nil, errors.New("未配置 PDF 浏览器")
	}
	if req.URL == "" || req.OutputPath == "" {
		return nil, errors.New("渲染请求无效")
	}
	if u, err := url.Parse(req.URL); err != nil || (u.Scheme != "http" && u.Scheme != "data") {
		return nil, errors.New("渲染地址无效")
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	workDir := req.WorkDir
	if workDir == "" {
		workDir = os.TempDir()
	}
	// The browser runs inside the profile directory. Its --user-data-dir and our
	// DevToolsActivePort lookup must refer to the same absolute directory.
	workDir, err := filepath.Abs(workDir)
	if err != nil {
		return nil, fmt.Errorf("解析 PDF 渲染工作目录: %w", err)
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return nil, err
	}
	profileDir, err := os.MkdirTemp(workDir, "profile-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(profileDir)

	proc, err := r.launch(ctx, profileDir)
	if err != nil {
		return nil, timeoutErr(ctx, err)
	}
	defer proc.shutdown()

	result, err := r.drive(ctx, proc.conn, req)
	if err != nil {
		if proc.conn.Crashed() {
			err = ErrRenderCrashed
		}
		err = proc.describe(err)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			if msg := summarizeOutput(proc.stderr.Bytes()); msg != "" {
				err = fmt.Errorf("%v（Chromium: %s）", err, msg)
			}
		}
		return nil, timeoutErr(ctx, err)
	}
	return result, nil
}

func timeoutErr(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		if err != nil {
			return fmt.Errorf("%w：%v", ErrRenderTimeout, err)
		}
		return ErrRenderTimeout
	}
	return err
}

func (r *ChromiumRenderer) drive(ctx context.Context, conn *cdpConn, req RenderRequest) (*RenderResult, error) {
	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := conn.Call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &target); err != nil {
		return nil, fmt.Errorf("创建浏览器页面: %w", err)
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := conn.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		return nil, fmt.Errorf("连接浏览器页面: %w", err)
	}
	session := attached.SessionID
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	if err := conn.Call(ctx, session, "Page.navigate", map[string]any{"url": req.URL}, &nav); err != nil {
		return nil, fmt.Errorf("导航渲染页面: %w", err)
	}
	if nav.ErrorText != "" {
		return nil, fmt.Errorf("渲染页面加载失败: %s", nav.ErrorText)
	}
	state, err := r.waitReady(ctx, conn, session)
	if err != nil {
		return nil, fmt.Errorf("等待渲染页面就绪: %w", err)
	}
	var printed struct {
		Stream string `json:"stream"`
		Data   string `json:"data"`
	}
	if err := conn.Call(ctx, session, "Page.printToPDF", map[string]any{
		"printBackground":     true,
		"preferCSSPageSize":   true,
		"displayHeaderFooter": false,
		"marginTop":           0,
		"marginBottom":        0,
		"marginLeft":          0,
		"marginRight":         0,
		"transferMode":        "ReturnAsStream",
	}, &printed); err != nil {
		return nil, fmt.Errorf("调用 Chromium PDF 打印: %w", err)
	}
	written, err := writePDFStream(ctx, conn, session, printed.Stream, printed.Data, req.OutputPath)
	if err != nil {
		return nil, fmt.Errorf("读取 Chromium PDF 输出: %w", err)
	}
	return &RenderResult{State: state, Bytes: written}, nil
}

func (r *ChromiumRenderer) waitReady(ctx context.Context, conn *cdpConn, session string) (json.RawMessage, error) {
	interval := r.PollInterval
	if interval <= 0 {
		interval = 200 * time.Millisecond
	}
	expr := "(function(){var s=window." + ReadyGlobal + ";return s?JSON.stringify(s):''})()"
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		var eval struct {
			Result struct {
				Value any `json:"value"`
			} `json:"result"`
		}
		// Errors while the document is still loading (context replaced) are transient.
		if err := conn.Call(ctx, session, "Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true}, &eval); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if errors.Is(err, errCDPClosed) {
				return nil, err
			}
		} else if raw, ok := eval.Result.Value.(string); ok && raw != "" {
			var st readyState
			if json.Unmarshal([]byte(raw), &st) != nil {
				return nil, errReadyStateShape
			}
			switch st.Status {
			case "ready":
				return json.RawMessage(raw), nil
			case "failed":
				msg := st.Error
				if len(msg) > 300 {
					msg = msg[:300]
				}
				return nil, &SurfaceError{Message: msg}
			}
		}
		if conn.Crashed() {
			return nil, ErrRenderCrashed
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func writePDFStream(ctx context.Context, conn *cdpConn, session, handle, inline, path string) (int64, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	w := bufio.NewWriterSize(f, 256<<10)
	var total int64
	fail := func(err error) (int64, error) {
		f.Close()
		os.Remove(path)
		return 0, err
	}
	write := func(data string, encoded bool) error {
		var chunk []byte
		if encoded {
			var derr error
			if chunk, derr = base64.StdEncoding.DecodeString(data); derr != nil {
				return derr
			}
		} else {
			chunk = []byte(data)
		}
		total += int64(len(chunk))
		if total > MaxChunkPDFBytes {
			return ErrOutputTooLarge
		}
		_, werr := w.Write(chunk)
		return werr
	}
	if handle == "" {
		if err := write(inline, true); err != nil {
			return fail(err)
		}
	} else {
		for {
			var part struct {
				Data          string `json:"data"`
				Base64Encoded bool   `json:"base64Encoded"`
				EOF           bool   `json:"eof"`
			}
			if err := conn.Call(ctx, session, "IO.read", map[string]any{"handle": handle, "size": 1 << 20}, &part); err != nil {
				return fail(err)
			}
			if err := write(part.Data, part.Base64Encoded); err != nil {
				return fail(err)
			}
			if part.EOF {
				break
			}
		}
		_ = conn.Call(ctx, session, "IO.close", map[string]any{"handle": handle}, nil)
	}
	if err := w.Flush(); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return 0, err
	}
	return total, nil
}

// SmokeURL is a self-contained page used to prove the browser can print PDFs.
func SmokeURL() string {
	html := `<!doctype html><meta charset="utf-8"><title>smoke</title><style>@page{size:148mm 210mm;margin:0}body{font:16px sans-serif;margin:20mm}</style>` +
		`<p>SealChat PDF smoke test 中文</p><script>window.` + ReadyGlobal + `={status:'ready'}</script>`
	return "data:text/html;charset=utf-8," + url.PathEscape(html)
}
