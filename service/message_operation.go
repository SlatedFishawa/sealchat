package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"gorm.io/gorm"
	"sealchat/model"
)

func MessageOperationReplay(actor, clientOp, kind string, input any) (string, json.RawMessage, error) {
	if clientOp == "" {
		return "", nil, nil
	}
	if len(clientOp) > 100 {
		return "", nil, logError("INVALID_INPUT", "操作标识过长")
	}
	b, err := json.Marshal(input)
	if err != nil {
		return "", nil, err
	}
	var scope struct {
		ChannelID string `json:"channel_id"`
		MessageID string `json:"message_id"`
	}
	if err := json.Unmarshal(b, &scope); err != nil {
		return "", nil, err
	}
	if !CanReadChannelByUserId(actor, scope.ChannelID) {
		return "", nil, logError("PERMISSION_DENIED", "频道不可读")
	}
	if kind == "message.update" {
		var visible int64
		if err := ApplyWhisperVisibilityFilter(model.GetDB().Model(&model.MessageModel{}).Where("id = ? AND channel_id = ? AND is_deleted = ? AND is_revoked = ?", scope.MessageID, scope.ChannelID, false, false), actor, scope.ChannelID).Count(&visible).Error; err != nil {
			return "", nil, err
		}
		if visible != 1 {
			return "", nil, logError("NOT_FOUND", "消息不可读")
		}
	}
	sum := sha256.Sum256(append([]byte(kind+"\x00"), b...))
	hash := hex.EncodeToString(sum[:])
	var row model.MessageOperationModel
	err = model.GetDB().Where("actor_id = ? AND client_op_id = ?", actor, clientOp).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return hash, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if row.PayloadHash != hash {
		return "", nil, logError("VERSION_CONFLICT", "操作标识已用于其他请求")
	}
	return hash, json.RawMessage(row.ResultJSON), nil
}
func RecordMessageOperation(tx *gorm.DB, actor, clientOp, hash string, result any) error {
	if clientOp == "" {
		return nil
	}
	b, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return tx.Create(&model.MessageOperationModel{ActorID: actor, ClientOpID: clientOp, PayloadHash: hash, ResultJSON: string(b)}).Error
}

func ValidateMessageExpectedVersions(ids []string, versions map[string]int64) error {
	if versions == nil {
		return nil
	}
	if len(versions) != len(ids) {
		return logError("INVALID_INPUT", "版本映射必须覆盖全部目标")
	}
	for _, id := range ids {
		v, ok := versions[id]
		if !ok || v < 1 || v >= LogMaxVersion {
			return logError("INVALID_INPUT", "消息版本无效")
		}
	}
	return nil
}

func ReplayCommittedMessageOperation(actor, clientOp, hash string) json.RawMessage {
	if clientOp == "" {
		return nil
	}
	var row model.MessageOperationModel
	if model.GetDB().Where("actor_id = ? AND client_op_id = ? AND payload_hash = ?", actor, clientOp, hash).Take(&row).Error != nil {
		return nil
	}
	return json.RawMessage(row.ResultJSON)
}
