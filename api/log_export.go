package api

import (
	"github.com/gofiber/fiber/v2"
	"sealchat/service"
)

func logExportCreate(c *fiber.Ctx) error {
	u := getCurUser(c)
	if u == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	var input service.LogExportInput
	if err := logDecodeBody(c, &input); err != nil {
		return logResponse(c, nil, err)
	}
	job, err := service.CreateLogMessageExportJob(c.Params("id"), u.ID, input)
	if err != nil {
		return logResponse(c, nil, err)
	}
	return logResponse(c, chatExportResponse{
		TaskID: job.ID, Status: job.Status, Message: "导出任务已创建", RequestedAt: job.CreatedAt.UnixMilli(), DisplayName: job.DisplayName,
	}, nil)
}
