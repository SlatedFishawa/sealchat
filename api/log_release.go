package api

import (
	"bytes"
	"strconv"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"sealchat/service"
)

var logPublicLimits = struct {
	sync.Mutex
	Entries map[string]struct {
		Start time.Time
		Count int
	}
}{Entries: make(map[string]struct {
	Start time.Time
	Count int
})}

func logPublicRateLimit(c *fiber.Ctx) error {
	now := time.Now()
	key := c.IP()
	logPublicLimits.Lock()
	if len(logPublicLimits.Entries) >= 10000 {
		for k, v := range logPublicLimits.Entries {
			if now.Sub(v.Start) >= time.Minute {
				delete(logPublicLimits.Entries, k)
			}
		}
	}
	v, exists := logPublicLimits.Entries[key]
	if !exists && len(logPublicLimits.Entries) >= 10000 {
		logPublicLimits.Unlock()
		return logResponse(c, nil, &service.LogError{Code: "RATE_LIMITED", Message: "请求过于频繁"})
	}
	if now.Sub(v.Start) >= time.Minute {
		v.Start = now
		v.Count = 0
	}
	v.Count++
	logPublicLimits.Entries[key] = v
	logPublicLimits.Unlock()
	if v.Count > 120 {
		return logResponse(c, nil, &service.LogError{Code: "RATE_LIMITED", Message: "请求过于频繁"})
	}
	return c.Next()
}

func bindLogReleaseRoutes(r fiber.Router) {
	r.Post("/log/projects/:id/releases", logAuthentication, logReleaseCreate)
	r.Get("/log/projects/:id/jobs/:jobId", logAuthentication, logReleaseJobGet)
	r.Delete("/log/projects/:id/publication", logAuthentication, logReleaseWithdraw)
	public := r.Group("/public/log", func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-store")
		c.Set("X-Content-Type-Options", "nosniff")
		c.Set("Referrer-Policy", "no-referrer")
		return c.Next()
	}, logPublicRateLimit)
	public.Get("/:slug", logPublicGet)
	public.Get("/:slug/sections/:sectionId/items", logPublicQuery)
	public.Get("/:slug/sections/:sectionId/context/:nodeId", logPublicQuery)
	public.Get("/:slug/chapters/:chapterId/items", logPublicChapterQuery)
	public.Get("/:slug/chapters/:chapterId/context/:nodeId", logPublicChapterQuery)
	public.Get("/:slug/search", logPublicSearch)
	public.Get("/:slug/assets/:assetKey", logPublicAsset)
}
func logReleaseCreate(c *fiber.Ctx) error {
	u := getCurUser(c)
	if u == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	var input service.LogReleaseInput
	if err := logDecodeBody(c, &input); err != nil {
		return logResponse(c, nil, err)
	}
	data, err := service.QueueLogRelease(c.Params("id"), u.ID, input)
	if err == nil {
		c.Status(202)
	}
	return logResponse(c, data, err)
}
func logReleaseJobGet(c *fiber.Ctx) error {
	u := getCurUser(c)
	if u == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	data, err := service.GetLogJob(c.Params("id"), c.Params("jobId"), u.ID)
	return logResponse(c, data, err)
}
func logReleaseWithdraw(c *fiber.Ctx) error {
	u := getCurUser(c)
	if u == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	var input struct {
		ExpectedVersion int64 `json:"expectedVersion"`
	}
	if err := logDecodeBody(c, &input); err != nil {
		return logResponse(c, nil, err)
	}
	if err := service.WithdrawLogPublication(c.Params("id"), u.ID, input.ExpectedVersion); err != nil {
		return logResponse(c, nil, err)
	}
	c.Set("Cache-Control", "no-store")
	return c.SendStatus(204)
}
func logPublicGet(c *fiber.Ctx) error {
	data, err := service.GetPublicLog(c.Params("slug"))
	return logResponse(c, data, err)
}
func logPublicQuery(c *fiber.Ctx) error {
	limit, err := strconv.Atoi(c.Query("limit", "100"))
	if err != nil {
		return logResponse(c, nil, &service.LogError{Code: "INVALID_INPUT", Message: "limit 无效"})
	}
	data, err := service.QueryPublicLog(c.Params("slug"), c.Params("sectionId"), c.Query("cursor"), c.Params("nodeId"), "", limit)
	return logResponse(c, data, err)
}
func logPublicChapterQuery(c *fiber.Ctx) error {
	limit, err := strconv.Atoi(c.Query("limit", "100"))
	if err != nil {
		return logResponse(c, nil, &service.LogError{Code: "INVALID_INPUT", Message: "limit 无效"})
	}
	data, err := service.QueryPublicLogChapter(c.Params("slug"), c.Params("chapterId"), c.Query("cursor"), c.Params("nodeId"), limit)
	return logResponse(c, data, err)
}
func logPublicSearch(c *fiber.Ctx) error {
	limit, err := strconv.Atoi(c.Query("limit", "20"))
	if err != nil || limit > 50 || c.Query("q") == "" {
		return logResponse(c, nil, &service.LogError{Code: "INVALID_INPUT", Message: "搜索参数无效"})
	}
	data, err := service.QueryPublicLog(c.Params("slug"), "", c.Query("cursor"), "", c.Query("q"), limit)
	return logResponse(c, data, err)
}
func logPublicAsset(c *fiber.Ctx) error {
	a, err := service.GetPublicLogAsset(c.Params("slug"), c.Params("assetKey"))
	if err != nil {
		return logResponse(c, nil, err)
	}
	c.Set("Content-Type", a.MIME)
	return c.SendStream(bytes.NewReader(a.Data), len(a.Data))
}
