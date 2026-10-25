package service

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"time"

	"sealchat/service/pdfruntime"
	"sealchat/utils"
)

var (
	logPDFRuntimeMu sync.RWMutex
	logPDFRuntime   *pdfruntime.Manager
)

func logPDFRuntimeConfig(cfg utils.ExportPDFConfig) pdfruntime.Config {
	utils.ApplyExportPDFDefaults(&cfg)
	return pdfruntime.Config{
		Enabled:           cfg.Enabled,
		BrowserPath:       cfg.BrowserPath,
		MergerPath:        cfg.MergerPath,
		WorkerConcurrency: cfg.WorkerConcurrency,
		TimeoutSeconds:    cfg.TimeoutSeconds,
		NoSandbox:         cfg.NoSandbox,
	}
}

// InitLogPDFRuntime creates the process-wide PDF runtime and probes it in the
// background when enabled. A missing browser never blocks startup.
func InitLogPDFRuntime(cfg utils.ExportPDFConfig, storageDir string) *pdfruntime.Manager {
	if storageDir == "" {
		storageDir = "./data/exports"
	}
	m := pdfruntime.NewManager(logPDFRuntimeConfig(cfg), pdfruntime.Options{WorkDir: filepath.Join(storageDir, ".pdf-probe")})
	setLogPDFRuntime(m)
	if m.Config().Enabled {
		go probeLogPDFRuntimeAsync(m)
	}
	return m
}

func setLogPDFRuntime(m *pdfruntime.Manager) {
	logPDFRuntimeMu.Lock()
	logPDFRuntime = m
	logPDFRuntimeMu.Unlock()
}

// LogPDFRuntime returns the PDF runtime manager, or nil before initialization.
func LogPDFRuntime() *pdfruntime.Manager {
	logPDFRuntimeMu.RLock()
	defer logPDFRuntimeMu.RUnlock()
	return logPDFRuntime
}

func probeLogPDFRuntimeAsync(m *pdfruntime.Manager) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	st := m.Probe(ctx)
	if st.Browser.Available {
		log.Printf("export: 后台 PDF 渲染器可用 (%s %s)", st.Browser.Kind, st.Browser.Version)
	} else {
		log.Printf("export: 后台 PDF 渲染器不可用: %s", st.Browser.Error)
	}
}

// ReconfigureLogPDFRuntime applies saved settings and reports whether the cached
// probe was invalidated (changed paths or sandbox mode) and must be re-run.
func ReconfigureLogPDFRuntime(cfg utils.ExportPDFConfig) bool {
	m := LogPDFRuntime()
	if m == nil {
		return false
	}
	m.Configure(logPDFRuntimeConfig(cfg))
	st := m.Status()
	return st.Enabled && !st.Probed && !st.Probing
}

// ProbeLogPDFRuntime runs a synchronous re-probe (administrator action).
func ProbeLogPDFRuntime(ctx context.Context) (pdfruntime.Status, bool) {
	m := LogPDFRuntime()
	if m == nil {
		return pdfruntime.Status{}, false
	}
	return m.Probe(ctx), true
}

// LogPDFCapability is the user-facing capability; it never exposes tool paths.
type LogPDFCapability struct {
	Enabled         bool   `json:"enabled"`
	Available       bool   `json:"available"`
	Probing         bool   `json:"probing"`
	RuntimeKind     string `json:"runtimeKind,omitempty"`
	MergerAvailable bool   `json:"mergerAvailable"`
	Reason          string `json:"reason,omitempty"`
}

func GetLogPDFCapability() LogPDFCapability {
	m := LogPDFRuntime()
	if m == nil {
		return LogPDFCapability{Reason: "服务器未启用后台 PDF"}
	}
	st := m.Status()
	c := LogPDFCapability{Enabled: st.Enabled, Probing: st.Probing || (st.Enabled && !st.Probed)}
	if st.Enabled && st.Probed && st.Browser.Available {
		c.Available = true
		c.RuntimeKind = st.Browser.Kind
		c.MergerAvailable = st.Merger.Available
		return c
	}
	c.Reason = st.ErrorSummary()
	return c
}

// acquireLogPDFSlot reserves a Chromium render slot. When the runtime is absent
// the job is still accepted so it can fail fast with a clear message instead of
// staying pending forever.
func acquireLogPDFSlot() (func(), bool) {
	m := LogPDFRuntime()
	if m == nil {
		return func() {}, true
	}
	if !m.TryAcquire() {
		return nil, false
	}
	var once sync.Once
	return func() { once.Do(m.Release) }, true
}
