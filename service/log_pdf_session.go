package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"sealchat/model"
	"sealchat/service/storage"
)

// Render sessions are the only way the background browser reads LOG data. Each
// session is bound to one export job chunk, lives only in memory, expires, and
// exposes a fixed allowlist of resources resolved under the job owner's LOG
// permissions. The server listens on loopback only; it is not part of the public
// Fiber application and grants no user session.

const (
	logPDFSessionTokenBytes = 32
	logPDFMaxAssetBytes     = 48 << 20
	logPDFSurfacePage       = "ui/dist/log-pdf-render.html"
	logPDFSurfaceAssets     = "ui/dist/assets"
)

var (
	logPDFSurfaceFSMu sync.RWMutex
	logPDFSurfaceFS   fs.FS

	logPDFAssetName  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,200}$`)
	logPDFTokenShape = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	logPDFAttID      = regexp.MustCompile(`^[A-Za-z0-9_-]{4,128}$`)
	logPDFBodyCtx    = regexp.MustCompile(`^([A-Za-z0-9_-]{1,100})/([A-Za-z0-9_-]{1,100})/([a-f0-9]{32})$`)
	logPDFProjID     = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	logPDFFontToken  = regexp.MustCompile(`^([A-Za-z0-9_-]{1,100}):(full|chunk:([a-f0-9]{2,400}))$`)
	logPDFStyleAsset = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$`)
)

// SetLogPDFSurfaceFS registers the embedded UI build containing the render surface.
func SetLogPDFSurfaceFS(fsys fs.FS) {
	logPDFSurfaceFSMu.Lock()
	logPDFSurfaceFS = fsys
	logPDFSurfaceFSMu.Unlock()
}

func currentLogPDFSurfaceFS() fs.FS {
	logPDFSurfaceFSMu.RLock()
	defer logPDFSurfaceFSMu.RUnlock()
	return logPDFSurfaceFS
}

// logPDFAssetScope is the minimal resource surface of one chunk.
type logPDFAssetScope struct {
	ProjectID string
	UserID    string
	// SectionMessages limits body: tokens to messages rendered in this chunk.
	SectionMessages map[string]map[string]bool
	// MessageText holds the chunk's raw message contents and identity avatar IDs;
	// an att: token is served only when its ID occurs there.
	MessageText    []string
	StyleID        string
	StyleVersion   string
	FontID         string
	FontItem       *model.PlatformFontAsset
	FontManifest   *PlatformFontSubsetManifestData
	ProjectAssets  map[string]bool
	attachmentSeen sync.Map
}

func (s *logPDFAssetScope) allowsAttachment(id string) bool {
	if v, ok := s.attachmentSeen.Load(id); ok {
		return v.(bool)
	}
	allowed := false
	for _, text := range s.MessageText {
		if strings.Contains(text, id) {
			allowed = true
			break
		}
	}
	s.attachmentSeen.Store(id, allowed)
	return allowed
}

type logPDFSession struct {
	token        string
	jobID        string
	chunk        int
	draftVersion int64
	payload      []byte
	scope        *logPDFAssetScope
	expires      time.Time
}

// logPDFAssetResolver fetches bytes for an allowed token; tests replace it.
type logPDFAssetResolver func(ctx context.Context, scope *logPDFAssetScope, token string) ([]byte, string, error)

type logPDFRenderServer struct {
	mu       sync.Mutex
	listener net.Listener
	server   *http.Server
	base     string
	sessions map[string]*logPDFSession
	resolve  logPDFAssetResolver
	now      func() time.Time
}

var logPDFServer = &logPDFRenderServer{}

func (s *logPDFRenderServer) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *logPDFRenderServer) ensureStarted() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.server != nil {
		return s.base, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	s.listener = ln
	s.base = "http://" + ln.Addr().String()
	if s.sessions == nil {
		s.sessions = map[string]*logPDFSession{}
	}
	s.server = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func(srv *http.Server, ln net.Listener) { _ = srv.Serve(ln) }(s.server, ln)
	return s.base, nil
}

func newLogPDFToken() (string, error) {
	b := make([]byte, logPDFSessionTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// open registers a session and returns its surface URL.
func (s *logPDFRenderServer) open(jobID string, chunk int, draftVersion int64, payload []byte, scope *logPDFAssetScope, ttl time.Duration) (*logPDFSession, string, error) {
	base, err := s.ensureStarted()
	if err != nil {
		return nil, "", err
	}
	token, err := newLogPDFToken()
	if err != nil {
		return nil, "", err
	}
	sess := &logPDFSession{token: token, jobID: jobID, chunk: chunk, draftVersion: draftVersion, payload: payload, scope: scope, expires: s.clock().Add(ttl)}
	s.mu.Lock()
	s.pruneLocked()
	s.sessions[token] = sess
	s.mu.Unlock()
	return sess, base + "/r/" + token + "/", nil
}

func (s *logPDFRenderServer) close(sess *logPDFSession) {
	if sess == nil {
		return
	}
	s.mu.Lock()
	delete(s.sessions, sess.token)
	s.mu.Unlock()
}

// closeJob invalidates every session of a job (job finished or failed).
func (s *logPDFRenderServer) closeJob(jobID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, sess := range s.sessions {
		if sess.jobID == jobID {
			delete(s.sessions, token)
		}
	}
}

func (s *logPDFRenderServer) pruneLocked() {
	now := s.clock()
	for token, sess := range s.sessions {
		if !now.Before(sess.expires) {
			delete(s.sessions, token)
		}
	}
}

func (s *logPDFRenderServer) lookup(token string) *logPDFSession {
	if !logPDFTokenShape.MatchString(token) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[token]
	if sess == nil {
		return nil
	}
	if !s.clock().Before(sess.expires) {
		delete(s.sessions, token)
		return nil
	}
	return sess
}

func (s *logPDFRenderServer) activeSessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// 'unsafe-eval' is required by @satorijs/element (used by the shared LOG content
// renderer), which compiles its interpolation helper with new Function at load.
// Scripts still come only from the embedded build; network access stays limited
// to this loopback origin (connect-src) and the browser's host-resolver rules.
const logPDFSurfaceCSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

func (s *logPDFRenderServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// DNS-rebinding guard: only the loopback address we listen on is accepted.
	s.mu.Lock()
	expectedHost := strings.TrimPrefix(s.base, "http://")
	s.mu.Unlock()
	if expectedHost == "" || r.Host != expectedHost {
		http.NotFound(w, r)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/r/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	token, sub, _ := strings.Cut(rest, "/")
	sess := s.lookup(token)
	if sess == nil {
		http.NotFound(w, r)
		return
	}
	switch {
	case sub == "" || sub == "index.html":
		s.serveSurface(w)
	case sub == "payload":
		h.Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(sess.payload)
	case sub == "asset":
		s.serveAsset(w, r, sess)
	case strings.HasPrefix(sub, "assets/"):
		s.serveStatic(w, strings.TrimPrefix(sub, "assets/"))
	default:
		http.NotFound(w, r)
	}
}

func (s *logPDFRenderServer) serveSurface(w http.ResponseWriter) {
	fsys := currentLogPDFSurfaceFS()
	if fsys == nil {
		http.Error(w, "surface unavailable", http.StatusServiceUnavailable)
		return
	}
	data, err := fs.ReadFile(fsys, logPDFSurfacePage)
	if err != nil {
		http.Error(w, "surface unavailable", http.StatusServiceUnavailable)
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", logPDFSurfaceCSP)
	h.Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func (s *logPDFRenderServer) serveStatic(w http.ResponseWriter, name string) {
	fsys := currentLogPDFSurfaceFS()
	if fsys == nil || !logPDFAssetName.MatchString(name) || strings.HasPrefix(name, ".") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	data, err := fs.ReadFile(fsys, path.Join(logPDFSurfaceAssets, name))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ctype := mime.TypeByExtension(path.Ext(name))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	_, _ = w.Write(data)
}

func (s *logPDFRenderServer) serveAsset(w http.ResponseWriter, r *http.Request, sess *logPDFSession) {
	token := r.URL.Query().Get("t")
	resolve := s.resolve
	if resolve == nil {
		resolve = resolveLogPDFAsset
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	data, ctype, err := resolve(ctx, sess.scope, token)
	if err != nil || len(data) == 0 || len(data) > logPDFMaxAssetBytes {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

var errLogPDFAssetDenied = errors.New("资源不在本次渲染范围内")

// resolveLogPDFAsset maps an allowlisted token to bytes through the same LOG
// resolvers and permission checks used by the design workbench.
func resolveLogPDFAsset(ctx context.Context, scope *logPDFAssetScope, token string) ([]byte, string, error) {
	if scope == nil || len(token) > 600 {
		return nil, "", errLogPDFAssetDenied
	}
	kind, id, ok := strings.Cut(token, ":")
	if !ok || id == "" {
		return nil, "", errLogPDFAssetDenied
	}
	switch kind {
	case "att":
		if !logPDFAttID.MatchString(id) || !scope.allowsAttachment(id) {
			return nil, "", errLogPDFAssetDenied
		}
		var att model.AttachmentModel
		if err := model.GetDB().Where("id = ?", id).Limit(1).Find(&att).Error; err != nil || att.ID == "" {
			return nil, "", errLogPDFAssetDenied
		}
		// Same exclusions as the attachment endpoint: clue media and TTS audio never leak by ID.
		if att.RootIDType == "world_clue" || att.IsTTSManaged() {
			return nil, "", errLogPDFAssetDenied
		}
		b, err := logReadBodyAsset(ctx, &att)
		if err != nil {
			return nil, "", err
		}
		return b.Data, b.MIME, nil
	case "body":
		m := logPDFBodyCtx.FindStringSubmatch(id)
		if m == nil || !scope.SectionMessages[m[1]][m[2]] {
			return nil, "", errLogPDFAssetDenied
		}
		b, err := GetLogBodyAsset(ctx, scope.ProjectID, m[1], m[2], m[3], scope.UserID)
		if err != nil {
			return nil, "", err
		}
		return b.Data, b.MIME, nil
	case "proj":
		if !logPDFProjID.MatchString(id) || !scope.ProjectAssets[id] {
			return nil, "", errLogPDFAssetDenied
		}
		b, err := GetLogProjectAsset(ctx, scope.ProjectID, id, scope.UserID)
		if err != nil {
			return nil, "", err
		}
		return b.Data, b.MIME, nil
	case "style":
		if scope.StyleID == "" || !logPDFStyleAsset.MatchString(id) {
			return nil, "", errLogPDFAssetDenied
		}
		a, err := GetLogStyleAsset(scope.StyleID, scope.StyleVersion, id, scope.UserID)
		if err != nil || a == nil {
			return nil, "", errLogPDFAssetDenied
		}
		return a.Data, a.MIME, nil
	case "platform-font":
		m := logPDFFontToken.FindStringSubmatch(id)
		if m == nil || scope.FontItem == nil || m[1] != scope.FontID {
			return nil, "", errLogPDFAssetDenied
		}
		item := scope.FontItem
		if m[2] == "full" {
			if strings.TrimSpace(item.OriginalObjectKey) == "" {
				return nil, "", errLogPDFAssetDenied
			}
			data, ctype, err := readPlatformFontObject(item.OriginalStorageType, item.OriginalObjectKey, item.SourceMimeType)
			return data, ctype, err
		}
		raw, err := hex.DecodeString(m[3])
		if err != nil || scope.FontManifest == nil || strings.TrimSpace(item.SubsetObjectKey) == "" {
			return nil, "", errLogPDFAssetDenied
		}
		name := string(raw)
		for _, chunk := range scope.FontManifest.Chunks {
			if chunk.Name == name && !strings.Contains(name, "..") {
				return readPlatformFontObject(item.SubsetStorageType, storage.BuildPlatformFontSubsetObjectKey(item.ID, name), chunk.MimeType)
			}
		}
		return nil, "", errLogPDFAssetDenied
	default:
		return nil, "", errLogPDFAssetDenied
	}
}

// logPDFSurfaceAvailable reports whether the embedded build contains the surface.
func logPDFSurfaceAvailable() bool {
	fsys := currentLogPDFSurfaceFS()
	if fsys == nil {
		return false
	}
	_, err := fs.Stat(fsys, logPDFSurfacePage)
	return err == nil
}
