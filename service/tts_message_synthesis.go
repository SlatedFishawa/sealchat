package service

import (
	"encoding/json"
	"strconv"
	"time"

	"sealchat/model"
	"sealchat/protocol"
	"sealchat/utils"
)

// TTSSynthesizeMessage accepts only a persisted message ID. One in-flight
// manual intent survives ambiguous retries; a known terminal failure may start
// a fresh server-keyed attempt for the same message revision.
func TTSSynthesizeMessage(actorID, messageID string) (*protocol.MessageTTS, error) {
	db := model.GetDB()
	var m model.MessageModel
	if err := db.Where("id = ? AND is_deleted = ? AND (is_revoked = ? OR is_revoked IS NULL) AND deleted_at IS NULL", messageID, false, false).First(&m).Error; err != nil {
		return nil, err
	}
	channel, err := model.ChannelGet(m.ChannelID)
	if err != nil {
		return nil, err
	}
	if !CanEditHistoricalMessage(channel, &m, actorID) {
		return nil, ErrTTSDenied
	}
	if _, err := ttsConfig(); err != nil {
		return nil, err
	}
	access, err := ResolveTTSWorldAccess(actorID, m.ChannelID)
	if err != nil {
		return nil, err
	}
	if !access.Allowed {
		return nil, ErrTTSWorldDenied
	}
	var previous TTSSnapshot
	_ = json.Unmarshal([]byte(m.TTSIntent), &previous)
	if ttsManualSynthesisBlocksRetry(m.TTSStatus) {
		return m.ValidTTS(), nil
	}
	if data := m.ValidTTS(); data != nil && data.Status == "ready" && data.AudioResourceID != "" {
		return data, nil
	}
	if previous.ManualRequestedAt != 0 && !ttsManualSynthesisTerminalFailure(m.TTSStatus) {
		// Unknown/manual intermediate states fail closed. A lost response must not
		// create a second charged attempt for the same persisted intent.
		return m.ValidTTS(), nil
	}
	var actor, sender model.UserModel
	if err := db.Where("id = ? AND deleted_at IS NULL", actorID).First(&actor).Error; err != nil {
		return nil, err
	}
	if err := db.Where("id = ? AND deleted_at IS NULL", m.UserID).First(&sender).Error; err != nil {
		return nil, err
	}
	if sender.IsBot {
		return nil, TTSValidationError("此消息类型不朗读")
	}
	if m.IsWhisper {
		var recipients []model.MessageWhisperRecipientModel
		if err := db.Where("message_id = ? AND deleted_at IS NULL", m.ID).Find(&recipients).Error; err != nil {
			return nil, err
		}
		for _, recipient := range recipients {
			m.WhisperTargets = append(m.WhisperTargets, &model.UserModel{StringPKBaseModel: model.StringPKBaseModel{ID: recipient.UserID}})
		}
	}
	oldStatus, oldIntent := m.TTSStatus, m.TTSIntent
	if err := ttsPrepareMessageIntent(&m, &actor, time.Now().Unix(), utils.NewID()); err != nil {
		return nil, err
	}
	result := db.Model(&model.MessageModel{}).Where(
		"id = ? AND edit_count = ? AND COALESCE(tts_status, '') = ? AND COALESCE(tts_intent, '') = ? AND is_deleted = ? AND (is_revoked = ? OR is_revoked IS NULL) AND deleted_at IS NULL",
		m.ID, m.EditCount, oldStatus, oldIntent, false, false,
	).Updates(map[string]any{"tts_intent": m.TTSIntent, "tts_status": "pending", "tts_data": nil})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		// Never apply a prepared snapshot to a different edit or replace a winner.
		var current model.MessageModel
		if err := db.Where("id = ? AND edit_count = ? AND is_deleted = ? AND (is_revoked = ? OR is_revoked IS NULL) AND deleted_at IS NULL", m.ID, m.EditCount, false, false).First(&current).Error; err != nil {
			return nil, ErrTTSConflict
		}
		return current.ValidTTS(), nil
	}
	m.TTSData = nil
	ttsNotifyMessageState(m.ID)
	TTSWake()
	return m.ValidTTS(), nil
}

func ttsManualSynthesisBlocksRetry(status string) bool {
	switch status {
	case "pending", "queued", "running", "storage_pending", "archiving", "usage_unknown":
		return true
	default:
		return false
	}
}

func ttsManualSynthesisTerminalFailure(status string) bool {
	switch status {
	case "failed", "skipped", "unavailable", "cancelled", "invalidated":
		return true
	default:
		return false
	}
}

func ttsMessageRequestKey(m model.MessageModel, s TTSSnapshot) string {
	if s.ManualRequestedAt != 0 {
		if s.ManualRequestKey != "" {
			return "message-manual:" + s.ManualRequestKey
		}
		return "message-manual:" + m.ID + ":" + strconv.Itoa(m.EditCount)
	}
	return "message:" + m.ID
}

func ttsMessagePayer(m model.MessageModel, s TTSSnapshot) string {
	if s.ManualRequestedAt != 0 {
		return s.Owner
	}
	return m.UserID
}
