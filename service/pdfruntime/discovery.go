package pdfruntime

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Browser runtime kinds reported by probing. The configured renderer adapter is
// always "chromium-cli"; the kind only describes which binary backs it.
const (
	KindChromeHeadlessShell = "chrome-headless-shell"
	KindChromium            = "chromium"
	KindChrome              = "chrome"
	KindEdge                = "edge"
	KindOtherChromium       = "other-chromium-compatible"
)

// Merger kinds.
const (
	MergerPDFUnite = "pdfunite"
	MergerQPDF     = "qpdf"
)

// Candidate sources, in probing priority order.
const (
	SourceConfig   = "config"
	SourceTools    = "tools"
	SourcePath     = "path"
	SourceFallback = "fallback"
)

// Environment abstracts the host so discovery can be tested without real binaries.
type Environment struct {
	GOOS     string
	ExeDir   string
	WorkDir  string
	LookPath func(string) (string, error)
	Stat     func(string) (os.FileInfo, error)
	Getenv   func(string) string
}

// DefaultEnvironment describes the running process.
func DefaultEnvironment() Environment {
	env := Environment{GOOS: runtime.GOOS, LookPath: exec.LookPath, Stat: os.Stat, Getenv: os.Getenv}
	if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		env.ExeDir = filepath.Dir(exe)
	}
	if wd, err := os.Getwd(); err == nil {
		env.WorkDir = wd
	}
	return env
}

func (e Environment) normalized() Environment {
	if e.GOOS == "" {
		e.GOOS = runtime.GOOS
	}
	if e.LookPath == nil {
		e.LookPath = exec.LookPath
	}
	if e.Stat == nil {
		e.Stat = os.Stat
	}
	if e.Getenv == nil {
		e.Getenv = func(string) string { return "" }
	}
	return e
}

// Candidate is one executable path to probe.
type Candidate struct {
	Path   string
	Source string
	// Kind is the merger kind for merger candidates; empty for browsers.
	Kind string
}

func (e Environment) isFile(path string) bool {
	if path == "" {
		return false
	}
	info, err := e.Stat(path)
	return err == nil && !info.IsDir()
}

func (e Environment) exeName(name string) string {
	if e.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		return name + ".exe"
	}
	return name
}

// resolveExplicit turns an administrator-supplied path into an absolute path.
// A bare command name is looked up in PATH; nothing is ever interpreted by a shell.
func (e Environment) resolveExplicit(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !strings.ContainsAny(p, `/\`) {
		if found, err := e.LookPath(p); err == nil {
			return found
		}
		return p
	}
	if !filepath.IsAbs(p) && e.WorkDir != "" {
		p = filepath.Join(e.WorkDir, p)
	}
	return filepath.Clean(p)
}

func (e Environment) toolRoots() []string {
	roots := []string{}
	seen := map[string]bool{}
	for _, dir := range []string{e.ExeDir, e.WorkDir} {
		if dir == "" {
			continue
		}
		root := filepath.Join(dir, "tools")
		if !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots
}

// BrowserCandidates lists browser executables in priority order. An explicit
// path disables automatic discovery so a misconfiguration is reported instead of
// silently replaced by another browser.
func BrowserCandidates(explicit string, env Environment) []Candidate {
	env = env.normalized()
	if p := env.resolveExplicit(explicit); p != "" {
		return []Candidate{{Path: p, Source: SourceConfig}}
	}
	out := []Candidate{}
	seen := map[string]bool{}
	add := func(path, source string) {
		if path == "" {
			return
		}
		key := filepath.Clean(path)
		if env.GOOS == "windows" || env.GOOS == "darwin" {
			key = strings.ToLower(key)
		}
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, Candidate{Path: path, Source: source})
	}
	shell := env.exeName("chrome-headless-shell")
	platformDirs := []string{"linux64", "mac-arm64", "mac-x64", "win64", "win32"}
	for _, root := range env.toolRoots() {
		dir := filepath.Join(root, "chrome-headless-shell")
		if p := filepath.Join(dir, shell); env.isFile(p) {
			add(p, SourceTools)
		}
		// Layout of the official Chrome for Testing archive when extracted as-is.
		for _, plat := range platformDirs {
			if p := filepath.Join(dir, "chrome-headless-shell-"+plat, shell); env.isFile(p) {
				add(p, SourceTools)
			}
		}
	}
	if p, err := env.LookPath(shell); err == nil {
		add(p, SourcePath)
	}
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "microsoft-edge-stable", "msedge"} {
		if p, err := env.LookPath(env.exeName(name)); err == nil {
			add(p, SourceFallback)
		}
	}
	for _, p := range wellKnownBrowserPaths(env) {
		if env.isFile(p) {
			add(p, SourceFallback)
		}
	}
	return out
}

func wellKnownBrowserPaths(env Environment) []string {
	switch env.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
	case "windows":
		paths := []string{}
		for _, base := range []string{env.Getenv("ProgramFiles"), env.Getenv("ProgramFiles(x86)"), env.Getenv("LOCALAPPDATA")} {
			if base == "" {
				continue
			}
			paths = append(paths,
				filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
				filepath.Join(base, "Chromium", "Application", "chrome.exe"),
				filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			)
		}
		return paths
	default:
		return []string{"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/snap/bin/chromium"}
	}
}

// DetectBrowserKind classifies a browser from its file name and version banner.
func DetectBrowserKind(path, version string) string {
	base := strings.ToLower(filepath.Base(path))
	v := strings.ToLower(version)
	switch {
	case strings.Contains(base, "headless-shell") || strings.Contains(base, "headless_shell") || strings.Contains(v, "headlesschrome") || strings.Contains(v, "headless shell"):
		return KindChromeHeadlessShell
	case strings.Contains(base, "edge") || strings.Contains(v, "microsoft edge"):
		return KindEdge
	case strings.Contains(base, "chromium") || strings.Contains(v, "chromium"):
		return KindChromium
	case strings.Contains(v, "google chrome") || strings.Contains(base, "chrome"):
		return KindChrome
	default:
		return KindOtherChromium
	}
}

// MergerKindOf infers the merger dialect from an executable name.
func MergerKindOf(path string) string {
	base := strings.ToLower(filepath.Base(path))
	switch {
	case strings.HasPrefix(base, "pdfunite"):
		return MergerPDFUnite
	case strings.HasPrefix(base, "qpdf"):
		return MergerQPDF
	default:
		return ""
	}
}

// MergerCandidates lists merger executables in priority order (explicit path
// only when configured, otherwise tools directory then PATH).
func MergerCandidates(explicit string, env Environment) []Candidate {
	env = env.normalized()
	if p := env.resolveExplicit(explicit); p != "" {
		return []Candidate{{Path: p, Source: SourceConfig, Kind: MergerKindOf(p)}}
	}
	out := []Candidate{}
	seen := map[string]bool{}
	add := func(path, source, kind string) {
		key := filepath.Clean(path)
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, Candidate{Path: path, Source: source, Kind: kind})
	}
	for _, root := range env.toolRoots() {
		for _, rel := range [][]string{
			{"pdfunite", env.exeName("pdfunite")},
			{"poppler", env.exeName("pdfunite")},
			{"poppler", "bin", env.exeName("pdfunite")},
			{env.exeName("pdfunite")},
			{"qpdf", env.exeName("qpdf")},
			{"qpdf", "bin", env.exeName("qpdf")},
			{env.exeName("qpdf")},
		} {
			p := filepath.Join(append([]string{root}, rel...)...)
			if env.isFile(p) {
				add(p, SourceTools, MergerKindOf(p))
			}
		}
	}
	for _, name := range []string{"pdfunite", "qpdf"} {
		if p, err := env.LookPath(env.exeName(name)); err == nil {
			add(p, SourcePath, MergerKindOf(p))
		}
	}
	return out
}
