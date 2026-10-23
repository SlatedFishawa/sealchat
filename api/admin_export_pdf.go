package api

import (
	"context"
	"strings"
	"time"
	"unicode"

	"github.com/gofiber/fiber/v2"

	"sealchat/service"
	"sealchat/service/pdfruntime"
	"sealchat/utils"
)

// Background LOG PDF runtime settings. Only platform administrators can read tool
// paths or change them; regular users see GET /log/pdf-capability without paths.

const adminExportPDFProbeTimeout = 3 * time.Minute

func adminExportPDFResponse(status pdfruntime.Status) fiber.Map {
	cfg := utils.ExportPDFConfig{}
	if appConfig != nil {
		cfg = appConfig.Export.PDF
	}
	return fiber.Map{
		"config": cfg,
		"status": status,
		"limits": fiber.Map{
			"maxWorkerConcurrency": pdfruntime.MaxWorkerConcurrency,
			"minTimeoutSeconds":    15,
			"maxTimeoutSeconds":    1800,
		},
	}
}

func currentExportPDFStatus() pdfruntime.Status {
	if m := service.LogPDFRuntime(); m != nil {
		return m.Status()
	}
	return pdfruntime.Status{Renderer: pdfruntime.RendererName}
}

func AdminExportPDFGet(c *fiber.Ctx) error {
	return c.JSON(adminExportPDFResponse(currentExportPDFStatus()))
}

func validateExportPDFToolPath(label, value string) error {
	value = strings.TrimSpace(value)
	if len(value) > 1024 {
		return fiber.NewError(fiber.StatusBadRequest, label+"过长")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fiber.NewError(fiber.StatusBadRequest, label+"包含非法字符")
		}
	}
	return nil
}

func AdminExportPDFUpdate(c *fiber.Ctx) error {
	var body struct {
		Config utils.ExportPDFConfig `json:"config"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "请求格式无效"})
	}
	if err := validateExportPDFToolPath("浏览器路径", body.Config.BrowserPath); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	if err := validateExportPDFToolPath("合并工具路径", body.Config.MergerPath); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	next := body.Config
	utils.ApplyExportPDFDefaults(&next)

	configMutationMu.Lock()
	current := appConfig
	if current == nil {
		current = &utils.AppConfig{}
	}
	merged := *current
	merged.Export.PDF = next
	if err := utils.WriteConfigChecked(&merged); err != nil {
		configMutationMu.Unlock()
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "配置文件写入失败，运行配置未修改"})
	}
	appConfig = &merged
	SyncConfigToDB(appConfig, "api")
	needsProbe := service.ReconfigureLogPDFRuntime(next)
	configMutationMu.Unlock()

	status := currentExportPDFStatus()
	if needsProbe {
		ctx, cancel := context.WithTimeout(context.Background(), adminExportPDFProbeTimeout)
		status, _ = service.ProbeLogPDFRuntime(ctx)
		cancel()
	}
	return c.JSON(adminExportPDFResponse(status))
}

func AdminExportPDFProbe(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(context.Background(), adminExportPDFProbeTimeout)
	defer cancel()
	status, ok := service.ProbeLogPDFRuntime(ctx)
	if !ok {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": "PDF 运行时未初始化"})
	}
	return c.JSON(adminExportPDFResponse(status))
}

func logPDFCapabilityGet(c *fiber.Ctx) error {
	if getCurUser(c) == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	return logResponse(c, service.GetLogPDFCapability(), nil)
}
