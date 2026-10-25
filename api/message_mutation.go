package api

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"sealchat/model"
	"sealchat/protocol"
	"sealchat/service"
)

func apiMessageAppearancePreview(ctx *ChatContext, input *service.MessageAppearancePreviewInput) (any, error) {
	return service.PreviewMessageAppearance(ctx.User.ID, *input)
}
func apiMessageAppearanceApply(ctx *ChatContext, input *struct {
	PreviewID  string `json:"preview_id"`
	ClientOpID string `json:"client_op_id"`
}) (any, error) {
	return service.ApplyMessageAppearance(ctx.User.ID, input.PreviewID, input.ClientOpID)
}
func logMutationJobGet(c *fiber.Ctx) error {
	u := getCurUser(c)
	if u == nil {
		return logResponse(c, nil, &service.LogError{Code: "UNAUTHENTICATED", Message: "请先登录"})
	}
	limit, err := strconv.Atoi(c.Query("limit", "100"))
	if err != nil {
		return logResponse(c, nil, &service.LogError{Code: "INVALID_INPUT", Message: "limit 无效"})
	}
	data, err := service.GetMessageMutationJob(u.ID, c.Params("jobId"), c.Query("cursor"), limit, strings.HasSuffix(c.Path(), "/items"))
	return logResponse(c, data, err)
}
func BroadcastMessageMutation(messageID, actorID string) {
	var m model.MessageModel
	if model.GetDB().Preload("User").Preload("Member").Where("id = ? AND is_deleted = ? AND is_revoked = ?", messageID, false, false).Take(&m).Error != nil {
		return
	}
	channel, err := model.ChannelGet(m.ChannelID)
	if err != nil || channel == nil {
		return
	}
	ctx := &ChatContext{ChannelUsersMap: getChannelUsersMap(), UserId2ConnInfo: getUserConnInfoMap()}
	if ctx.UserId2ConnInfo == nil {
		return
	}
	event := &protocol.Event{Type: protocol.EventMessageUpdated, Channel: channel.ToProtocolType(), Message: m.ToProtocolType2(channel.ToProtocolType()), User: &protocol.User{ID: actorID}}
	if m.IsWhisper {
		recipients := resolveWhisperRecipients(m.WhisperTo, model.GetWhisperRecipientIDs(m.ID), m.UserID)
		ctx.BroadcastEventInChannelToUsers(m.ChannelID, append(recipients, m.UserID), event)
	} else {
		ctx.BroadcastEventInChannel(m.ChannelID, event)
	}
}
