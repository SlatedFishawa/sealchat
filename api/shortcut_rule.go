package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"

	"sealchat/protocol"
	"sealchat/service"
)

const shortcutRulesUpdatedEvent = "world-shortcut-rules-updated"

func broadcastShortcutWorldRulesUpdated(worldID string) {
	worldID = strings.TrimSpace(worldID)
	if worldID == "" {
		return
	}
	ctx := &ChatContext{UserId2ConnInfo: userId2ConnInfoGlobal}
	ctx.BroadcastEventInWorld(worldID, &protocol.Event{Type: shortcutRulesUpdatedEvent})
}

// BindShortcutRuleRoutes 注册快捷命令规则资源路由（需要登录）。
func BindShortcutRuleRoutes(group fiber.Router) {
	group.Get("/shortcut-rules", shortcutRuleListHandler)
	group.Post("/shortcut-rules", shortcutRuleCreateHandler)
	group.Post("/shortcut-rules/reorder", shortcutRuleReorderHandler)
	group.Patch("/shortcut-rules/:ruleId", shortcutRuleUpdateHandler)
	group.Delete("/shortcut-rules/:ruleId", shortcutRuleDeleteHandler)
}

func shortcutRuleError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, service.ErrShortcutRuleInvalid):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": shortcutRuleErrorDetail(err, "规则内容无效")})
	case errors.Is(err, service.ErrShortcutRuleConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": shortcutRuleErrorDetail(err, "同类型的触发内容已存在")})
	case errors.Is(err, service.ErrShortcutRuleNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "规则不存在或已删除"})
	case errors.Is(err, service.ErrShortcutRuleDenied):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": "无权维护该快捷命令"})
	case errors.Is(err, service.ErrWorldNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "世界不存在或已失效"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "快捷命令操作失败"})
	}
}

// shortcutRuleErrorDetail 只透出 service 主动构造的校验说明（"<sentinel>: <说明>"）。
func shortcutRuleErrorDetail(err error, fallback string) string {
	if _, detail, ok := strings.Cut(err.Error(), ": "); ok && strings.TrimSpace(detail) != "" {
		return detail
	}
	return fallback
}

func shortcutRuleListHandler(c *fiber.Ctx) error {
	user := getCurUser(c)
	result, err := service.ShortcutRuleList(user.ID, strings.TrimSpace(c.Query("worldId")))
	if err != nil {
		return shortcutRuleError(c, err)
	}
	return c.JSON(result)
}

func shortcutRuleCreateHandler(c *fiber.Ctx) error {
	var input service.ShortcutRuleInput
	if err := c.BodyParser(&input); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "请求参数解析失败"})
	}
	user := getCurUser(c)
	item, err := service.ShortcutRuleCreate(user.ID, input)
	if err != nil {
		return shortcutRuleError(c, err)
	}
	if item.Scope == "world" {
		broadcastShortcutWorldRulesUpdated(item.WorldID)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"item": item})
}

func shortcutRuleUpdateHandler(c *fiber.Ctx) error {
	ruleID := strings.TrimSpace(c.Params("ruleId"))
	if ruleID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "缺少规则ID"})
	}
	var patch service.ShortcutRulePatch
	if err := c.BodyParser(&patch); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "请求参数解析失败"})
	}
	user := getCurUser(c)
	item, previousWorldID, err := service.ShortcutRuleUpdate(user.ID, ruleID, patch)
	if err != nil {
		return shortcutRuleError(c, err)
	}
	broadcastShortcutWorldRulesUpdated(previousWorldID)
	if item.Scope == "world" {
		if item.WorldID != previousWorldID {
			broadcastShortcutWorldRulesUpdated(item.WorldID)
		}
	}
	return c.JSON(fiber.Map{"item": item})
}

func shortcutRuleDeleteHandler(c *fiber.Ctx) error {
	ruleID := strings.TrimSpace(c.Params("ruleId"))
	if ruleID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "缺少规则ID"})
	}
	user := getCurUser(c)
	worldID, err := service.ShortcutRuleDelete(user.ID, ruleID)
	if err != nil {
		return shortcutRuleError(c, err)
	}
	broadcastShortcutWorldRulesUpdated(worldID)
	return c.JSON(fiber.Map{"success": true})
}

func shortcutRuleReorderHandler(c *fiber.Ctx) error {
	var input service.ShortcutRuleReorderInput
	if err := c.BodyParser(&input); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "请求参数解析失败"})
	}
	user := getCurUser(c)
	items, err := service.ShortcutRuleReorder(user.ID, input)
	if err != nil {
		return shortcutRuleError(c, err)
	}
	if input.Scope == "world" {
		broadcastShortcutWorldRulesUpdated(input.WorldID)
	}
	return c.JSON(fiber.Map{"items": items})
}
