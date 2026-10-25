package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gofiber/fiber/v2"

	"sealchat/model"
	"sealchat/service"
)

type channelIdentityModeConfigPayload struct {
	TargetUserID string  `json:"targetUserId"`
	ICRoleID     *string `json:"icRoleId"`
	OOCRoleID    *string `json:"oocRoleId"`
}

func serializeChannelIdentityModeConfig(config *model.ChannelIdentityModeConfigModel) fiber.Map {
	if config == nil {
		return fiber.Map{
			"icRoleId":  nil,
			"oocRoleId": nil,
		}
	}
	return fiber.Map{
		"icRoleId":  nullableJSONID(config.ICIdentityID),
		"oocRoleId": nullableJSONID(config.OOCIdentityID),
	}
}

func nullableJSONID(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func normalizeOptionalID(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func ChannelIdentityModeConfigUpsert(c *fiber.Ctx) error {
	user := getCurUser(c)
	if user == nil {
		return c.Status(http.StatusUnauthorized).JSON(fiber.Map{"message": "未登录"})
	}
	channelID := strings.TrimSpace(c.Params("channelId"))
	if channelID == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{"message": "缺少频道ID"})
	}

	var body channelIdentityModeConfigPayload
	if err := c.BodyParser(&body); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{"message": "请求参数错误"})
	}
	ctx, err := resolveChannelIdentityActorFromRequest(c, channelID, body.TargetUserID)
	if err != nil {
		return handleChannelIdentityActorErr(c, err)
	}
	if ctx.IsBotTarget {
		return c.Status(http.StatusForbidden).JSON(fiber.Map{"message": "BOT 外观不支持场内场外映射"})
	}

	icRoleID := normalizeOptionalID(body.ICRoleID)
	oocRoleID := normalizeOptionalID(body.OOCRoleID)
	record, err := service.ChannelIdentityModeConfigSet(ctx.TargetUserID, channelID, icRoleID, oocRoleID)
	if err != nil {
		if errors.Is(err, service.ErrChannelIdentityModeConfigSameRole) ||
			errors.Is(err, service.ErrChannelIdentityModeConfigICRoleInvalid) ||
			errors.Is(err, service.ErrChannelIdentityModeConfigOOCRoleInvalid) {
			return c.Status(http.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
		}
		return wrapError(c, err, "保存场内场外角色映射失败")
	}
	reason := "identity-mode-config-upsert"
	if record == nil {
		reason = "identity-mode-config-delete"
	}
	broadcastChannelIdentityRefresh(channelIdentityRefreshPayload{
		ChannelID:      channelID,
		TargetUserID:   ctx.TargetUserID,
		OperatorUserID: ctx.OperatorUserID,
		Reason:         reason,
	})
	return c.JSON(fiber.Map{
		"channelId": channelID,
		"exists":    record != nil,
		"config":    serializeChannelIdentityModeConfig(record),
	})
}
