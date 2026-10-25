package pdfruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// Config is the runtime subset of export.pdf configuration.
type Config struct {
	Enabled           bool
	BrowserPath       string
	MergerPath        string
	WorkerConcurrency int
	TimeoutSeconds    int
	NoSandbox         bool
}

// MaxWorkerConcurrency bounds concurrent Chromium renders regardless of config.
const MaxWorkerConcurrency = 4

func (c Config) concurrency() int {
	n := c.WorkerConcurrency
	if n < 1 {
		n = 1
	}
	if n > MaxWorkerConcurrency {
		n = MaxWorkerConcurrency
	}
	return n
}

// Timeout is the per-chunk render timeout.
func (c Config) Timeout() time.Duration {
	if c.TimeoutSeconds <= 0 {
		return 2 * time.Minute
	}
	return time.Duration(c.TimeoutSeconds) * time.Second
}

// ProbeAttempt records a rejected candidate for the admin status view.
type ProbeAttempt struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	Error  string `json:"error"`
}

// ToolStatus describes one external tool after probing.
type ToolStatus struct {
	Available   bool           `json:"available"`
	Kind        string         `json:"kind"`
	Version     string         `json:"version"`
	Path        string         `json:"path"`
	Source      string         `json:"source"`
	Error       string         `json:"error"`
	SmokeTested bool           `json:"smokeTested"`
	Attempts    []ProbeAttempt `json:"attempts,omitempty"`
}

// Status is the cached capability snapshot.
type Status struct {
	Enabled   bool       `json:"enabled"`
	Renderer  string     `json:"renderer"`
	Probed    bool       `json:"probed"`
	Probing   bool       `json:"probing"`
	CheckedAt int64      `json:"checkedAt"`
	Browser   ToolStatus `json:"browser"`
	Merger    ToolStatus `json:"merger"`
}

// Options injects host dependencies (tests replace them with fakes).
type Options struct {
	Env         Environment
	Runner      CommandRunner
	NewRenderer func(b Browser, noSandbox bool) PDFRenderer
	NewMerger   func(m Merger, runner CommandRunner) PDFMerger
	// WorkDir hosts probe scratch files; defaults to the system temp directory.
	WorkDir string
}

// Manager owns configuration, cached probe results and the render slot limit.
type Manager struct {
	opts Options

	mu        sync.Mutex
	cfg       Config
	gen       int64
	probeGen  int64
	probeDone chan struct{}
	status    Status
	browser   *Browser
	merger    *Merger
	active    int
}

func NewManager(cfg Config, opts Options) *Manager {
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.NewRenderer == nil {
		opts.NewRenderer = func(b Browser, noSandbox bool) PDFRenderer {
			return &ChromiumRenderer{Browser: b, NoSandbox: noSandbox}
		}
	}
	if opts.NewMerger == nil {
		opts.NewMerger = func(m Merger, runner CommandRunner) PDFMerger {
			return &CLIMerger{Merger: m, Runner: runner}
		}
	}
	if opts.Env.LookPath == nil && opts.Env.Stat == nil && opts.Env.GOOS == "" {
		opts.Env = DefaultEnvironment()
	}
	m := &Manager{opts: opts, cfg: cfg}
	m.status = Status{Enabled: cfg.Enabled, Renderer: RendererName}
	return m
}

// Configure applies new settings. Changing tool paths or sandbox mode invalidates
// the cached probe so stale results are never used.
func (m *Manager) Configure(cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev := m.cfg
	m.cfg = cfg
	m.status.Enabled = cfg.Enabled
	if prev.BrowserPath != cfg.BrowserPath || prev.MergerPath != cfg.MergerPath || prev.NoSandbox != cfg.NoSandbox {
		m.gen++
		m.browser, m.merger = nil, nil
		m.status = Status{Enabled: cfg.Enabled, Renderer: RendererName, Probing: m.probeDone != nil}
	}
}

func (m *Manager) Config() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.status
	s.Browser.Attempts = append([]ProbeAttempt(nil), s.Browser.Attempts...)
	s.Merger.Attempts = append([]ProbeAttempt(nil), s.Merger.Attempts...)
	return s
}

// Probe runs discovery, version checks and smoke tests for browser and merger.
// Concurrent callers share the in-flight probe. Waiting is context-aware, and a
// caller that observes a configuration change retries against the latest generation
// instead of running a second probe concurrently.
func (m *Manager) Probe(ctx context.Context) Status {
	for {
		if ctx.Err() != nil {
			return m.Status()
		}

		m.mu.Lock()
		cfg, gen := m.cfg, m.gen
		if m.probeDone != nil {
			done, activeGen := m.probeDone, m.probeGen
			m.mu.Unlock()
			select {
			case <-ctx.Done():
				return m.Status()
			case <-done:
			}
			m.mu.Lock()
			currentGen := m.gen
			st := m.status
			m.mu.Unlock()
			if activeGen == gen && currentGen == gen && st.Probed {
				return st
			}
			continue
		}

		done := make(chan struct{})
		m.probeDone = done
		m.probeGen = gen
		m.status.Probing = true
		m.mu.Unlock()

		workDir := m.opts.WorkDir
		if workDir == "" {
			workDir = os.TempDir()
		}
		_ = os.MkdirAll(workDir, 0o700)
		browserStatus, browser := m.probeBrowser(ctx, cfg, workDir)
		mergerStatus, merger := m.probeMerger(ctx, cfg, workDir)

		m.mu.Lock()
		stale := gen != m.gen
		if !stale {
			m.browser, m.merger = browser, merger
			m.status = Status{
				Enabled: cfg.Enabled, Renderer: RendererName, Probed: true,
				CheckedAt: time.Now().UnixMilli(), Browser: browserStatus, Merger: mergerStatus,
			}
		} else {
			m.status.Probing = false
		}
		if m.probeDone == done {
			close(done)
			m.probeDone = nil
		}
		st := m.status
		m.mu.Unlock()
		if stale {
			continue
		}
		return st
	}
}

var versionNumber = regexp.MustCompile(`\d+\.\d+`)

func (m *Manager) probeBrowser(ctx context.Context, cfg Config, workDir string) (ToolStatus, *Browser) {
	candidates := BrowserCandidates(cfg.BrowserPath, m.opts.Env)
	st := ToolStatus{}
	if len(candidates) == 0 {
		st.Error = "未找到 chrome-headless-shell 或兼容的 Chromium 浏览器"
		return st, nil
	}
	for _, c := range candidates {
		b, err := m.probeBrowserCandidate(ctx, c, cfg, workDir)
		if err == nil {
			return ToolStatus{Available: true, Kind: b.Kind, Version: b.Version, Path: b.Path, Source: c.Source, SmokeTested: true, Attempts: st.Attempts}, &b
		}
		st.Attempts = append(st.Attempts, ProbeAttempt{Path: c.Path, Source: c.Source, Error: err.Error()})
		if ctx.Err() != nil {
			break
		}
	}
	last := st.Attempts[len(st.Attempts)-1]
	st.Path, st.Source = last.Path, last.Source
	st.Error = last.Error
	if cfg.BrowserPath != "" {
		st.Error = "配置的浏览器不可用：" + last.Error
	}
	return st, nil
}

func (m *Manager) probeBrowserCandidate(ctx context.Context, c Candidate, cfg Config, workDir string) (Browser, error) {
	b := Browser{Path: c.Path}
	if info, err := m.opts.Env.normalized().Stat(c.Path); err != nil || info.IsDir() {
		return b, errors.New("文件不存在")
	}
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	out, err := m.opts.Runner.Run(vctx, c.Path, "--version")
	cancel()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return b, errors.New("版本探测超时")
		}
		if msg := summarizeOutput(out); msg != "" {
			return b, fmt.Errorf("版本命令失败: %v（%s）", err, msg)
		}
		return b, fmt.Errorf("版本命令失败: %v", err)
	}
	b.Version = firstLine(out)
	if !versionNumber.MatchString(b.Version) {
		// Windows GUI builds of Chrome print nothing for --version; the smoke test
		// below is then the only proof, which is acceptable for fallback browsers.
		if m.opts.Env.normalized().GOOS != "windows" || b.Version != "" {
			return b, errors.New("版本输出无法识别，可能不是 Chromium 浏览器")
		}
		b.Version = "unknown"
	}
	b.Kind = DetectBrowserKind(c.Path, b.Version)
	dir, err := os.MkdirTemp(workDir, "browser-smoke-")
	if err != nil {
		return b, err
	}
	defer os.RemoveAll(dir)
	out2 := filepath.Join(dir, "smoke.pdf")
	sctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	renderer := m.opts.NewRenderer(b, cfg.NoSandbox)
	var renderErr error
	for attempt := 1; attempt <= 2; attempt++ {
		_ = os.Remove(out2)
		_, renderErr = renderer.Render(sctx, RenderRequest{URL: SmokeURL(), OutputPath: out2, WorkDir: dir, Timeout: 25 * time.Second})
		if renderErr == nil {
			break
		}
		if !errors.Is(renderErr, ErrRenderTimeout) || attempt == 2 || sctx.Err() != nil {
			return b, fmt.Errorf("PDF 冒烟测试失败: %v", renderErr)
		}
	}
	if err := ValidatePDFFile(out2); err != nil {
		return b, fmt.Errorf("PDF 冒烟测试输出无效: %v", err)
	}
	return b, nil
}

func (m *Manager) probeMerger(ctx context.Context, cfg Config, workDir string) (ToolStatus, *Merger) {
	candidates := MergerCandidates(cfg.MergerPath, m.opts.Env)
	st := ToolStatus{}
	if len(candidates) == 0 {
		st.Error = "未找到 pdfunite 或 qpdf"
		return st, nil
	}
	env := m.opts.Env.normalized()
	for _, c := range candidates {
		var merger Merger
		var err error
		if info, serr := env.Stat(c.Path); serr != nil || info.IsDir() {
			err = errors.New("文件不存在")
		} else {
			merger, err = ProbeMerger(ctx, m.opts.Runner, c, workDir)
		}
		if err == nil {
			return ToolStatus{Available: true, Kind: merger.Kind, Version: merger.Version, Path: merger.Path, Source: c.Source, SmokeTested: true, Attempts: st.Attempts}, &merger
		}
		st.Attempts = append(st.Attempts, ProbeAttempt{Path: c.Path, Source: c.Source, Error: err.Error()})
		if ctx.Err() != nil {
			break
		}
	}
	last := st.Attempts[len(st.Attempts)-1]
	st.Path, st.Source, st.Error = last.Path, last.Source, last.Error
	if cfg.MergerPath != "" {
		st.Error = "配置的合并工具不可用：" + last.Error
	}
	return st, nil
}

// Renderer returns the probed renderer, or false when PDF export is disabled or
// no working browser was found.
func (m *Manager) Renderer() (PDFRenderer, Browser, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.cfg.Enabled || m.browser == nil {
		return nil, Browser{}, false
	}
	return m.opts.NewRenderer(*m.browser, m.cfg.NoSandbox), *m.browser, true
}

// Merger returns the probed merger, if any.
func (m *Manager) Merger() (PDFMerger, Merger, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.merger == nil {
		return nil, Merger{}, false
	}
	return m.opts.NewMerger(*m.merger, m.opts.Runner), *m.merger, true
}

// Available reports whether background PDF can run right now.
func (m *Manager) Available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.Enabled && m.browser != nil
}

// TryAcquire reserves one render slot.
func (m *Manager) TryAcquire() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active >= m.cfg.concurrency() {
		return false
	}
	m.active++
	return true
}

func (m *Manager) Release() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active > 0 {
		m.active--
	}
}

// Active returns the number of renders in flight.
func (m *Manager) Active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// ErrorSummary returns a short user-facing reason PDF is unavailable.
func (s Status) ErrorSummary() string {
	switch {
	case !s.Enabled:
		return "后台 PDF 已被管理员关闭"
	case !s.Probed:
		return "服务器尚未完成 PDF 渲染器检测"
	case !s.Browser.Available:
		return "服务器未检测到 PDF 渲染器"
	default:
		return ""
	}
}
