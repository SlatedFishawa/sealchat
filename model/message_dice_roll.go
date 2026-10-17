package model

import "gorm.io/gorm"

// MessageDiceRollModel 记录消息中的掷骰结果，便于编辑和回填
type MessageDiceRollModel struct {
	StringPKBaseModel
	MessageID       string `json:"message_id" gorm:"size:100;index:idx_msg_dice_roll"`
	RollIndex       int    `json:"roll_index" gorm:"index:idx_msg_dice_roll"`
	SourceText      string `json:"source_text" gorm:"type:text"`
	Formula         string `json:"formula" gorm:"type:text"`
	ResultDetail    string `json:"result_detail" gorm:"type:text"`
	ResultValueText string `json:"result_value_text" gorm:"type:text"`
	ResultText      string `json:"result_text" gorm:"type:text"`
	IsError         bool   `json:"is_error" gorm:"default:false"`
}

func (*MessageDiceRollModel) TableName() string {
	return "message_dice_rolls"
}

// MessageDiceRollListByMessageID 查询消息对应的掷骰结果
func MessageDiceRollListByMessageID(messageID string) ([]*MessageDiceRollModel, error) {
	if messageID == "" {
		return []*MessageDiceRollModel{}, nil
	}
	var items []*MessageDiceRollModel
	err := db.Where("message_id = ?", messageID).
		Order("roll_index asc").
		Find(&items).Error
	if err == gorm.ErrRecordNotFound {
		return []*MessageDiceRollModel{}, nil
	}
	return items, err
}

// MessageDiceRollReplace 将指定消息的掷骰结果重写为 rolls
func MessageDiceRollReplace(messageID string, rolls []*MessageDiceRollModel) error {
	return db.Transaction(func(tx *gorm.DB) error { return MessageDiceRollReplaceTx(tx, messageID, rolls) })
}
func MessageDiceRollReplaceTx(tx *gorm.DB, messageID string, rolls []*MessageDiceRollModel) error {
	if err := tx.Where("message_id = ?", messageID).
		Delete(&MessageDiceRollModel{}).Error; err != nil {
		return err
	}
	if len(rolls) == 0 {
		return nil
	}
	for _, roll := range rolls {
		if roll == nil {
			continue
		}
		roll.MessageID = messageID
		if roll.ID == "" {
			roll.Init()
		}
	}
	return tx.Create(&rolls).Error
}
