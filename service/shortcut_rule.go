package service

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"gorm.io/gorm"

	"sealchat/model"
)

// 快捷命令规则：personal 规则只属于本人；world 规则是世界成员共同维护的协作资源。
// 世界所有者、管理员、普通成员都可以维护 world 规则；旁观者和非成员不能维护。

var (
	ErrShortcutRuleNotFound = errors.New("shortcut rule not found")
	ErrShortcutRuleDenied   = errors.New("shortcut rule permission denied")
	ErrShortcutRuleConflict = errors.New("shortcut rule trigger already exists")
	ErrShortcutRuleInvalid  = errors.New("shortcut rule invalid")
)

const (
	ShortcutRuleTriggerMaxRunes = 64
	ShortcutRuleCommandMaxRunes = 1000
	ShortcutRuleBucketMaxCount  = 300

	ShortcutRuleClickActionSend   = "send"
	ShortcutRuleClickActionInsert = "insert"

	// quick_suggest 的候选来源：character_attrs 在输入时实时读取当前人物卡顶层属性名，不做快照。
	ShortcutRuleQuickSuggestSourceCharacterAttrs = "character_attrs"
	ShortcutRuleQuickSuggestSourceCustom         = "custom"
	ShortcutRuleQuickSuggestItemMaxRunes         = 64
	ShortcutRuleQuickSuggestItemsMaxCount        = 200
)

// ShortcutRuleInput 用于创建规则。
type ShortcutRuleInput struct {
	Scope   string         `json:"scope"`
	WorldID string         `json:"worldId"`
	Type    string         `json:"type"`
	Trigger string         `json:"trigger"`
	Command string         `json:"command"`
	Enabled *bool          `json:"enabled"`
	Config  map[string]any `json:"config"`
}

// ShortcutRulePatch 用于部分更新规则；Scope/WorldID 同时出现时表示移动到另一个作用域。
type ShortcutRulePatch struct {
	Scope   *string        `json:"scope"`
	WorldID *string        `json:"worldId"`
	Trigger *string        `json:"trigger"`
	Command *string        `json:"command"`
	Enabled *bool          `json:"enabled"`
	Config  map[string]any `json:"config"`
}

// ShortcutRuleReorderInput 按给定顺序重排同一作用域内的规则。
type ShortcutRuleReorderInput struct {
	Scope   string   `json:"scope"`
	WorldID string   `json:"worldId"`
	IDs     []string `json:"ids"`
}

// ShortcutRuleView 是对外返回的规则形状，附带最后维护者的展示名。
type ShortcutRuleView struct {
	*model.ShortcutRuleModel
	UpdatedByName string `json:"updatedByName,omitempty"`
}

// ShortcutRuleListResult 汇总当前用户在某个世界中可见的规则。
type ShortcutRuleListResult struct {
	Personal       []*ShortcutRuleView `json:"personal"`
	World          []*ShortcutRuleView `json:"world"`
	CanManageWorld bool                `json:"canManageWorld"`
}

type shortcutRuleBucket struct {
	scope   string
	worldID string
	ownerID string
}

func normalizeShortcutRuleScope(raw string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case model.ShortcutRuleScopePersonal:
		return model.ShortcutRuleScopePersonal, nil
	case model.ShortcutRuleScopeWorld:
		return model.ShortcutRuleScopeWorld, nil
	default:
		return "", fmt.Errorf("%w: 作用域无效", ErrShortcutRuleInvalid)
	}
}

func normalizeShortcutRuleType(raw string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case model.ShortcutRuleTypeSendAlias:
		return model.ShortcutRuleTypeSendAlias, nil
	case model.ShortcutRuleTypeReplace:
		return model.ShortcutRuleTypeReplace, nil
	case model.ShortcutRuleTypeMessageAction:
		return model.ShortcutRuleTypeMessageAction, nil
	case model.ShortcutRuleTypeQuickSuggest:
		return model.ShortcutRuleTypeQuickSuggest, nil
	default:
		return "", fmt.Errorf("%w: 规则类型无效", ErrShortcutRuleInvalid)
	}
}

func normalizeShortcutRuleTrigger(raw string) (string, error) {
	trigger := strings.TrimSpace(raw)
	if trigger == "" {
		return "", fmt.Errorf("%w: 触发内容不能为空", ErrShortcutRuleInvalid)
	}
	if strings.ContainsAny(trigger, "\r\n") {
		return "", fmt.Errorf("%w: 触发内容不能换行", ErrShortcutRuleInvalid)
	}
	if utf8.RuneCountInString(trigger) > ShortcutRuleTriggerMaxRunes {
		return "", fmt.Errorf("%w: 触发内容最多 %d 个字符", ErrShortcutRuleInvalid, ShortcutRuleTriggerMaxRunes)
	}
	return trigger, nil
}

// normalizeShortcutRuleCommand 校验实际内容；quick_suggest 只做输入补全、不发送命令，Command 固定为空。
func normalizeShortcutRuleCommand(ruleType, raw string) (string, error) {
	if ruleType == model.ShortcutRuleTypeQuickSuggest {
		return "", nil
	}
	command := strings.TrimSpace(raw)
	if command == "" {
		return "", fmt.Errorf("%w: 实际内容不能为空", ErrShortcutRuleInvalid)
	}
	if utf8.RuneCountInString(command) > ShortcutRuleCommandMaxRunes {
		return "", fmt.Errorf("%w: 实际内容最多 %d 个字符", ErrShortcutRuleInvalid, ShortcutRuleCommandMaxRunes)
	}
	return command, nil
}

// normalizeShortcutQuickSuggestItems 把自定义候选归一化为去重后的字符串数组。
func normalizeShortcutQuickSuggestItems(raw any) ([]string, error) {
	var values []any
	switch typed := raw.(type) {
	case nil:
	case []any:
		values = typed
	case []string:
		for _, item := range typed {
			values = append(values, item)
		}
	default:
		return nil, fmt.Errorf("%w: 自定义候选格式无效", ErrShortcutRuleInvalid)
	}
	items := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%w: 自定义候选格式无效", ErrShortcutRuleInvalid)
		}
		item := strings.TrimSpace(text)
		if item == "" {
			continue
		}
		if strings.ContainsAny(item, "\r\n") {
			return nil, fmt.Errorf("%w: 候选内容不能换行", ErrShortcutRuleInvalid)
		}
		if utf8.RuneCountInString(item) > ShortcutRuleQuickSuggestItemMaxRunes {
			return nil, fmt.Errorf("%w: 每个候选最多 %d 个字符", ErrShortcutRuleInvalid, ShortcutRuleQuickSuggestItemMaxRunes)
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		items = append(items, item)
	}
	if len(items) > ShortcutRuleQuickSuggestItemsMaxCount {
		return nil, fmt.Errorf("%w: 自定义候选最多 %d 个", ErrShortcutRuleInvalid, ShortcutRuleQuickSuggestItemsMaxCount)
	}
	return items, nil
}

// normalizeShortcutRuleConfig 只保留当前类型认识的配置键，未知键丢弃。
func normalizeShortcutRuleConfig(ruleType string, raw map[string]any) (model.JSONMap, error) {
	config := model.JSONMap{}
	switch ruleType {
	case model.ShortcutRuleTypeSendAlias:
		autoDelete, _ := raw["autoDelete"].(bool)
		config["autoDelete"] = autoDelete
	case model.ShortcutRuleTypeReplace:
		replaceInChat, _ := raw["replaceInChat"].(bool)
		config["replaceInChat"] = replaceInChat
	case model.ShortcutRuleTypeMessageAction:
		action, _ := raw["clickAction"].(string)
		if strings.TrimSpace(action) == ShortcutRuleClickActionInsert {
			config["clickAction"] = ShortcutRuleClickActionInsert
		} else {
			config["clickAction"] = ShortcutRuleClickActionSend
		}
	case model.ShortcutRuleTypeQuickSuggest:
		source, _ := raw["source"].(string)
		if strings.TrimSpace(source) != ShortcutRuleQuickSuggestSourceCustom {
			config["source"] = ShortcutRuleQuickSuggestSourceCharacterAttrs
			break
		}
		items, err := normalizeShortcutQuickSuggestItems(raw["items"])
		if err != nil {
			return nil, err
		}
		if len(items) == 0 {
			return nil, fmt.Errorf("%w: 自定义候选至少需要一项", ErrShortcutRuleInvalid)
		}
		config["source"] = ShortcutRuleQuickSuggestSourceCustom
		config["items"] = items
	}
	return config, nil
}

func shortcutWorldMemberRole(db *gorm.DB, worldID, userID string) (string, error) {
	worldID = strings.TrimSpace(worldID)
	userID = strings.TrimSpace(userID)
	if worldID == "" || userID == "" {
		return "", ErrShortcutRuleDenied
	}
	var world model.WorldModel
	if err := db.Where("id = ? AND status = ?", worldID, "active").Limit(1).Find(&world).Error; err != nil {
		return "", err
	}
	if world.ID == "" {
		return "", ErrWorldNotFound
	}
	var member model.WorldMemberModel
	if err := db.Where("world_id = ? AND user_id = ?", worldID, userID).Limit(1).Find(&member).Error; err != nil {
		return "", err
	}
	if member.ID == "" {
		return "", ErrShortcutRuleDenied
	}
	return member.Role, nil
}

func canMaintainShortcutWorldRules(role string) bool {
	switch role {
	case model.WorldRoleOwner, model.WorldRoleAdmin, model.WorldRoleMember:
		return true
	default:
		return false
	}
}

func shortcutWorldReadRole(db *gorm.DB, worldID, userID string) (string, error) {
	worldID = strings.TrimSpace(worldID)
	userID = strings.TrimSpace(userID)
	if worldID == "" {
		return "", ErrWorldNotFound
	}
	var world model.WorldModel
	if err := db.Where("id = ? AND status = ?", worldID, "active").Limit(1).Find(&world).Error; err != nil {
		return "", err
	}
	if world.ID == "" {
		return "", ErrWorldNotFound
	}
	if userID != "" {
		var member model.WorldMemberModel
		if err := db.Where("world_id = ? AND user_id = ?", worldID, userID).Limit(1).Find(&member).Error; err != nil {
			return "", err
		}
		if member.ID != "" {
			return member.Role, nil
		}
	}
	if world.Visibility == model.WorldVisibilityPublic {
		return "", nil
	}
	return "", ErrShortcutRuleDenied
}

func normalizeShortcutRuleWriteError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "idx_shortcut_rule_unique") ||
		strings.Contains(message, "unique constraint failed: shortcut_rules.scope") {
		return ErrShortcutRuleConflict
	}
	return err
}

// ensureShortcutWorldMaintainer 校验 actor 是世界内可维护规则的成员（非旁观者）。
func ensureShortcutWorldMaintainer(db *gorm.DB, worldID, actorID string) error {
	role, err := shortcutWorldMemberRole(db, worldID, actorID)
	if err != nil {
		return err
	}
	if !canMaintainShortcutWorldRules(role) {
		return ErrShortcutRuleDenied
	}
	return nil
}

func resolveShortcutRuleBucket(db *gorm.DB, actorID, scope, worldID string) (shortcutRuleBucket, error) {
	normalizedScope, err := normalizeShortcutRuleScope(scope)
	if err != nil {
		return shortcutRuleBucket{}, err
	}
	if normalizedScope == model.ShortcutRuleScopePersonal {
		return shortcutRuleBucket{scope: normalizedScope, ownerID: actorID}, nil
	}
	worldID = strings.TrimSpace(worldID)
	if worldID == "" {
		return shortcutRuleBucket{}, fmt.Errorf("%w: 缺少世界ID", ErrShortcutRuleInvalid)
	}
	if err := ensureShortcutWorldMaintainer(db, worldID, actorID); err != nil {
		return shortcutRuleBucket{}, err
	}
	return shortcutRuleBucket{scope: normalizedScope, worldID: worldID}, nil
}

func shortcutRuleBucketQuery(db *gorm.DB, bucket shortcutRuleBucket) *gorm.DB {
	return db.Model(&model.ShortcutRuleModel{}).
		Where("scope = ? AND world_id = ? AND owner_id = ?", bucket.scope, bucket.worldID, bucket.ownerID)
}

func ensureShortcutRuleTriggerAvailable(db *gorm.DB, bucket shortcutRuleBucket, ruleType, trigger, excludeID string) error {
	query := shortcutRuleBucketQuery(db, bucket).Where("rule_type = ? AND trigger_text = ?", ruleType, trigger)
	if excludeID != "" {
		query = query.Where("id <> ?", excludeID)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrShortcutRuleConflict
	}
	return nil
}

func nextShortcutRuleSortOrder(db *gorm.DB, bucket shortcutRuleBucket) (int, error) {
	var count int64
	if err := shortcutRuleBucketQuery(db, bucket).Count(&count).Error; err != nil {
		return 0, err
	}
	if count >= ShortcutRuleBucketMaxCount {
		return 0, fmt.Errorf("%w: 当前作用域最多 %d 条规则", ErrShortcutRuleInvalid, ShortcutRuleBucketMaxCount)
	}
	var maxOrder struct{ Value *int }
	if err := shortcutRuleBucketQuery(db, bucket).Select("MAX(sort_order) AS value").Scan(&maxOrder).Error; err != nil {
		return 0, err
	}
	if maxOrder.Value == nil {
		return 0, nil
	}
	return *maxOrder.Value + 1, nil
}

// loadShortcutRuleForActor 读取规则并校验读取权限；他人的 personal 规则统一表现为不存在。
func loadShortcutRuleForActor(db *gorm.DB, actorID, ruleID string) (*model.ShortcutRuleModel, error) {
	ruleID = strings.TrimSpace(ruleID)
	if ruleID == "" {
		return nil, ErrShortcutRuleNotFound
	}
	var rule model.ShortcutRuleModel
	if err := db.Where("id = ?", ruleID).Limit(1).Find(&rule).Error; err != nil {
		return nil, err
	}
	if rule.ID == "" {
		return nil, ErrShortcutRuleNotFound
	}
	if rule.Scope == model.ShortcutRuleScopePersonal && rule.OwnerID != actorID {
		return nil, ErrShortcutRuleNotFound
	}
	return &rule, nil
}

// ensureShortcutRuleMaintainable 校验 actor 可以修改/删除该规则。
func ensureShortcutRuleMaintainable(db *gorm.DB, actorID string, rule *model.ShortcutRuleModel) error {
	switch rule.Scope {
	case model.ShortcutRuleScopePersonal:
		if rule.OwnerID != actorID {
			return ErrShortcutRuleNotFound
		}
		return nil
	case model.ShortcutRuleScopeWorld:
		return ensureShortcutWorldMaintainer(db, rule.WorldID, actorID)
	default:
		return ErrShortcutRuleDenied
	}
}

func shortcutRuleBucketOf(rule *model.ShortcutRuleModel) shortcutRuleBucket {
	return shortcutRuleBucket{scope: rule.Scope, worldID: rule.WorldID, ownerID: rule.OwnerID}
}

func buildShortcutRuleViews(db *gorm.DB, rules []*model.ShortcutRuleModel) []*ShortcutRuleView {
	views := make([]*ShortcutRuleView, 0, len(rules))
	userIDs := make([]string, 0, len(rules))
	seen := map[string]struct{}{}
	for _, rule := range rules {
		if rule.Config == nil {
			rule.Config, _ = normalizeShortcutRuleConfig(rule.Type, nil)
		}
		views = append(views, &ShortcutRuleView{ShortcutRuleModel: rule})
		if id := strings.TrimSpace(rule.UpdatedBy); id != "" {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				userIDs = append(userIDs, id)
			}
		}
	}
	if len(userIDs) == 0 {
		return views
	}
	var users []model.UserModel
	if err := db.Select("id, nickname, username").Where("id IN ?", userIDs).Find(&users).Error; err != nil {
		return views
	}
	names := make(map[string]string, len(users))
	for _, user := range users {
		name := strings.TrimSpace(user.Nickname)
		if name == "" {
			name = strings.TrimSpace(user.Username)
		}
		names[user.ID] = name
	}
	for _, view := range views {
		view.UpdatedByName = names[view.UpdatedBy]
	}
	return views
}

func listShortcutRulesInBucket(db *gorm.DB, bucket shortcutRuleBucket) ([]*model.ShortcutRuleModel, error) {
	var rules []*model.ShortcutRuleModel
	err := db.Where("scope = ? AND world_id = ? AND owner_id = ?", bucket.scope, bucket.worldID, bucket.ownerID).
		Order("sort_order asc").
		Order("created_at asc").
		Order("id asc").
		Find(&rules).Error
	return rules, err
}

func loadShortcutRuleView(db *gorm.DB, ruleID string) (*ShortcutRuleView, error) {
	var rule model.ShortcutRuleModel
	if err := db.Where("id = ?", ruleID).Take(&rule).Error; err != nil {
		return nil, err
	}
	return buildShortcutRuleViews(db, []*model.ShortcutRuleModel{&rule})[0], nil
}

// ShortcutRuleList 返回当前用户的 personal 规则和（若提供 worldID）该世界的 world 规则。
// world 规则对成员及公开世界的只读旁观者可见；维护能力由 CanManageWorld 标识。
func ShortcutRuleList(actorID, worldID string) (*ShortcutRuleListResult, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, ErrShortcutRuleDenied
	}
	db := model.GetDB()
	personal, err := listShortcutRulesInBucket(db, shortcutRuleBucket{scope: model.ShortcutRuleScopePersonal, ownerID: actorID})
	if err != nil {
		return nil, err
	}
	result := &ShortcutRuleListResult{
		Personal: buildShortcutRuleViews(db, personal),
		World:    []*ShortcutRuleView{},
	}
	worldID = strings.TrimSpace(worldID)
	if worldID == "" {
		return result, nil
	}
	role, err := shortcutWorldReadRole(db, worldID, actorID)
	if err != nil {
		return nil, err
	}
	worldRules, err := listShortcutRulesInBucket(db, shortcutRuleBucket{scope: model.ShortcutRuleScopeWorld, worldID: worldID})
	if err != nil {
		return nil, err
	}
	result.World = buildShortcutRuleViews(db, worldRules)
	result.CanManageWorld = canMaintainShortcutWorldRules(role)
	return result, nil
}

// ShortcutRuleCreate 在 personal 或 world 作用域中创建规则。
func ShortcutRuleCreate(actorID string, input ShortcutRuleInput) (*ShortcutRuleView, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, ErrShortcutRuleDenied
	}
	ruleType, err := normalizeShortcutRuleType(input.Type)
	if err != nil {
		return nil, err
	}
	trigger, err := normalizeShortcutRuleTrigger(input.Trigger)
	if err != nil {
		return nil, err
	}
	command, err := normalizeShortcutRuleCommand(ruleType, input.Command)
	if err != nil {
		return nil, err
	}
	config, err := normalizeShortcutRuleConfig(ruleType, input.Config)
	if err != nil {
		return nil, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	var created *model.ShortcutRuleModel
	db := model.GetDB()
	err = db.Transaction(func(tx *gorm.DB) error {
		bucket, err := resolveShortcutRuleBucket(tx, actorID, input.Scope, input.WorldID)
		if err != nil {
			return err
		}
		if err := ensureShortcutRuleTriggerAvailable(tx, bucket, ruleType, trigger, ""); err != nil {
			return err
		}
		sortOrder, err := nextShortcutRuleSortOrder(tx, bucket)
		if err != nil {
			return err
		}
		rule := &model.ShortcutRuleModel{
			Scope:     bucket.scope,
			WorldID:   bucket.worldID,
			OwnerID:   bucket.ownerID,
			Type:      ruleType,
			Trigger:   trigger,
			Command:   command,
			Config:    config,
			Enabled:   enabled,
			SortOrder: sortOrder,
			CreatedBy: actorID,
			UpdatedBy: actorID,
		}
		if err := tx.Create(rule).Error; err != nil {
			return normalizeShortcutRuleWriteError(err)
		}
		created = rule
		return nil
	})
	if err != nil {
		return nil, err
	}
	return buildShortcutRuleViews(db, []*model.ShortcutRuleModel{created})[0], nil
}

// ShortcutRuleUpdate 部分更新规则；可同时移动到另一作用域（需要源和目标的维护权限）。
func ShortcutRuleUpdate(actorID, ruleID string, patch ShortcutRulePatch) (*ShortcutRuleView, string, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, "", ErrShortcutRuleDenied
	}
	db := model.GetDB()
	previousWorldID := ""
	err := db.Transaction(func(tx *gorm.DB) error {
		rule, err := loadShortcutRuleForActor(tx, actorID, ruleID)
		if err != nil {
			return err
		}
		if rule.Scope == model.ShortcutRuleScopeWorld {
			previousWorldID = rule.WorldID
		}
		if err := ensureShortcutRuleMaintainable(tx, actorID, rule); err != nil {
			return err
		}
		updates := map[string]any{"updated_by": actorID}
		trigger := rule.Trigger
		if patch.Trigger != nil {
			if trigger, err = normalizeShortcutRuleTrigger(*patch.Trigger); err != nil {
				return err
			}
			updates["trigger_text"] = trigger
		}
		if patch.Command != nil {
			command, err := normalizeShortcutRuleCommand(rule.Type, *patch.Command)
			if err != nil {
				return err
			}
			updates["command"] = command
		}
		if patch.Enabled != nil {
			updates["enabled"] = *patch.Enabled
		}
		if patch.Config != nil {
			config, err := normalizeShortcutRuleConfig(rule.Type, patch.Config)
			if err != nil {
				return err
			}
			updates["config"] = config
		}

		bucket := shortcutRuleBucketOf(rule)
		if patch.Scope != nil {
			worldID := rule.WorldID
			if patch.WorldID != nil {
				worldID = *patch.WorldID
			}
			target, err := resolveShortcutRuleBucket(tx, actorID, *patch.Scope, worldID)
			if err != nil {
				return err
			}
			if target != bucket {
				sortOrder, err := nextShortcutRuleSortOrder(tx, target)
				if err != nil {
					return err
				}
				updates["scope"] = target.scope
				updates["world_id"] = target.worldID
				updates["owner_id"] = target.ownerID
				updates["sort_order"] = sortOrder
				bucket = target
			}
		}
		if err := ensureShortcutRuleTriggerAvailable(tx, bucket, rule.Type, trigger, rule.ID); err != nil {
			return err
		}
		return normalizeShortcutRuleWriteError(tx.Model(&model.ShortcutRuleModel{}).Where("id = ?", rule.ID).Updates(updates).Error)
	})
	if err != nil {
		return nil, "", err
	}
	view, err := loadShortcutRuleView(db, strings.TrimSpace(ruleID))
	return view, previousWorldID, err
}

// ShortcutRuleDelete 删除规则（硬删除）。
func ShortcutRuleDelete(actorID, ruleID string) (string, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return "", ErrShortcutRuleDenied
	}
	db := model.GetDB()
	worldID := ""
	err := db.Transaction(func(tx *gorm.DB) error {
		rule, err := loadShortcutRuleForActor(tx, actorID, ruleID)
		if err != nil {
			return err
		}
		if err := ensureShortcutRuleMaintainable(tx, actorID, rule); err != nil {
			return err
		}
		if rule.Scope == model.ShortcutRuleScopeWorld {
			worldID = rule.WorldID
		}
		return tx.Where("id = ?", rule.ID).Delete(&model.ShortcutRuleModel{}).Error
	})
	return worldID, err
}

// ShortcutRuleReorder 按 IDs 顺序重写同一作用域内的 sort_order；IDs 必须恰好覆盖该作用域的全部规则。
func ShortcutRuleReorder(actorID string, input ShortcutRuleReorderInput) ([]*ShortcutRuleView, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, ErrShortcutRuleDenied
	}
	db := model.GetDB()
	var ordered []*model.ShortcutRuleModel
	err := db.Transaction(func(tx *gorm.DB) error {
		bucket, err := resolveShortcutRuleBucket(tx, actorID, input.Scope, input.WorldID)
		if err != nil {
			return err
		}
		existing, err := listShortcutRulesInBucket(tx, bucket)
		if err != nil {
			return err
		}
		if len(input.IDs) != len(existing) {
			return fmt.Errorf("%w: 排序列表与当前规则不一致，请刷新后重试", ErrShortcutRuleConflict)
		}
		byID := make(map[string]*model.ShortcutRuleModel, len(existing))
		for _, rule := range existing {
			byID[rule.ID] = rule
		}
		ordered = make([]*model.ShortcutRuleModel, 0, len(existing))
		for index, rawID := range input.IDs {
			id := strings.TrimSpace(rawID)
			rule, ok := byID[id]
			if !ok {
				return fmt.Errorf("%w: 排序列表与当前规则不一致，请刷新后重试", ErrShortcutRuleConflict)
			}
			delete(byID, id)
			if rule.SortOrder != index {
				if err := tx.Model(&model.ShortcutRuleModel{}).Where("id = ?", id).UpdateColumn("sort_order", index).Error; err != nil {
					return err
				}
				rule.SortOrder = index
			}
			ordered = append(ordered, rule)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return buildShortcutRuleViews(db, ordered), nil
}
