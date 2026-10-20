package model

// ShortcutRuleScope 区分个人规则与世界共享规则。
const (
	ShortcutRuleScopePersonal = "personal"
	ShortcutRuleScopeWorld    = "world"
)

// ShortcutRuleType 是快捷命令的行为类型。
const (
	ShortcutRuleTypeSendAlias     = "send_alias"
	ShortcutRuleTypeReplace       = "replace"
	ShortcutRuleTypeMessageAction = "message_action"
	// ShortcutRuleTypeQuickSuggest 是输入阶段的候选补全：Trigger 为输入前缀，Command 为空。
	ShortcutRuleTypeQuickSuggest = "quick_suggest"
)

// ShortcutRuleModel 存储快捷命令规则。
//
// personal 规则：Scope=personal，OwnerID=所属用户，WorldID 为空，跨世界生效。
// world 规则：Scope=world，WorldID=所属世界，OwnerID 为空，由世界成员共同维护。
// Config 保存按类型区分的轻量配置（autoDelete、clickAction、quick_suggest 的 source/items 等），由 service 层归一化。
type ShortcutRuleModel struct {
	StringPKBaseModel
	Scope     string  `json:"scope" gorm:"size:16;not null;index:idx_shortcut_rule_bucket,priority:1;uniqueIndex:idx_shortcut_rule_unique,priority:1"`
	WorldID   string  `json:"worldId" gorm:"size:100;not null;default:'';index:idx_shortcut_rule_bucket,priority:2;uniqueIndex:idx_shortcut_rule_unique,priority:2"`
	OwnerID   string  `json:"ownerId" gorm:"size:100;not null;default:'';index:idx_shortcut_rule_bucket,priority:3;uniqueIndex:idx_shortcut_rule_unique,priority:3"`
	Type      string  `json:"type" gorm:"column:rule_type;size:32;not null;uniqueIndex:idx_shortcut_rule_unique,priority:4"`
	Trigger   string  `json:"trigger" gorm:"column:trigger_text;size:255;not null;uniqueIndex:idx_shortcut_rule_unique,priority:5"`
	Command   string  `json:"command" gorm:"type:text"`
	Config    JSONMap `json:"config" gorm:"type:json"`
	Enabled   bool    `json:"enabled" gorm:"not null"`
	SortOrder int     `json:"sortOrder" gorm:"not null;default:0"`
	CreatedBy string  `json:"createdBy" gorm:"size:100"`
	UpdatedBy string  `json:"updatedBy" gorm:"size:100"`
}

func (*ShortcutRuleModel) TableName() string { return "shortcut_rules" }
