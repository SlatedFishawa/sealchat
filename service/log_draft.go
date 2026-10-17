package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"sealchat/model"
)

type LogSourceSpec struct {
	ChannelID       string     `json:"channelId"`
	FromTime        *time.Time `json:"fromTime"`
	ToTime          time.Time  `json:"toTime"`
	IncludeOOC      bool       `json:"includeOoc"`
	IncludeArchived bool       `json:"includeArchived"`
	IdentityIDs     []string   `json:"identityIds"`
}
type LogSection struct {
	ID     string        `json:"id"`
	Title  string        `json:"title"`
	Source LogSourceSpec `json:"source"`
	Order  int           `json:"order"`
}
type LogPageSettings struct {
	Preset    string  `json:"preset"`
	WidthMM   float64 `json:"widthMm"`
	HeightMM  float64 `json:"heightMm"`
	MarginsMM struct {
		Top    float64 `json:"top"`
		Right  float64 `json:"right"`
		Bottom float64 `json:"bottom"`
		Left   float64 `json:"left"`
	} `json:"marginsMm"`
	GutterMM          float64 `json:"gutterMm"`
	Columns           int     `json:"columns"`
	BackgroundColor   string  `json:"backgroundColor"`
	BackgroundAssetID *string `json:"backgroundAssetId"`
	FontFamily        string  `json:"fontFamily"`
	FontSizePT        float64 `json:"fontSizePt"`
	LineHeight        float64 `json:"lineHeight"`
	HeaderTemplateID  *string `json:"headerTemplateId"`
	FooterTemplateID  *string `json:"footerTemplateId"`
	ShowPageNumbers   bool    `json:"showPageNumbers"`
	MergeNeighbors    bool    `json:"mergeNeighbors"`
}
type LogDraft struct {
	SchemaVersion       int               `json:"schemaVersion"`
	Title               string            `json:"title"`
	Sections            []LogSection      `json:"sections"`
	Elements            []json.RawMessage `json:"elements"`
	Page                LogPageSettings   `json:"page"`
	StylePackageID      string            `json:"stylePackageId"`
	StylePackageVersion string            `json:"stylePackageVersion"`
	ThemeTokens         map[string]any    `json:"themeTokens"`
}
type LogDraftUpdate struct {
	ExpectedVersion int64           `json:"expectedVersion"`
	Draft           json.RawMessage `json:"draft"`
}
type LogDraftResult struct {
	DraftVersion int64    `json:"draftVersion"`
	Draft        LogDraft `json:"draft"`
}

var logUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var logColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$`)

func parseLogDraft(raw []byte) (LogDraft, error) {
	var draft LogDraft
	if len(raw) > 2<<20 {
		return draft, logError("TOO_LARGE", "草稿超过 2MB")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&draft); err != nil {
		return draft, logError("INVALID_INPUT", "草稿格式无效")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return draft, logError("INVALID_INPUT", "草稿格式无效")
	}
	if draft.SchemaVersion != 1 || strings.TrimSpace(draft.Title) == "" || len([]rune(draft.Title)) > 200 || draft.Sections == nil || draft.Elements == nil || len(draft.Sections) > 200 || len(draft.Elements) > 10000 {
		return draft, logError("INVALID_INPUT", "草稿字段或数量无效")
	}
	seen := map[string]bool{}
	for _, section := range draft.Sections {
		if !logUUIDPattern.MatchString(section.ID) || seen[section.ID] || len([]rune(section.Title)) > 200 || section.Order < 0 || int64(section.Order) > LogMaxVersion {
			return draft, logError("INVALID_INPUT", "章节标识或顺序无效")
		}
		seen[section.ID] = true
		s := section.Source
		if s.ChannelID == "" || len(s.ChannelID) > 100 || s.ToTime.IsZero() || (s.FromTime != nil && s.FromTime.After(s.ToTime)) || s.IdentityIDs == nil || len(s.IdentityIDs) > 200 {
			return draft, logError("INVALID_INPUT", "来源范围无效")
		}
		identities := map[string]bool{}
		for _, id := range s.IdentityIDs {
			if id == "" || len(id) > 100 || identities[id] {
				return draft, logError("INVALID_INPUT", "角色筛选无效")
			}
			identities[id] = true
		}
	}
	p := draft.Page
	m := p.MarginsMM
	for _, n := range []float64{p.WidthMM, p.HeightMM, m.Top, m.Right, m.Bottom, m.Left, p.GutterMM, p.FontSizePT, p.LineHeight} {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
			return draft, logError("INVALID_INPUT", "页面数值无效")
		}
	}
	if (p.Preset != "a4" && p.Preset != "a5" && p.Preset != "custom") || p.WidthMM < 50 || p.WidthMM > 1000 || p.HeightMM < 50 || p.HeightMM > 1000 || m.Top+m.Bottom >= p.HeightMM || m.Left+m.Right+p.GutterMM >= p.WidthMM || (p.Columns != 1 && p.Columns != 2) || p.FontSizePT < 6 || p.FontSizePT > 72 || p.LineHeight < 1 || p.LineHeight > 3 || !logColorPattern.MatchString(p.BackgroundColor) {
		return draft, logError("INVALID_INPUT", "页面设置超出允许范围")
	}
	if draft.StylePackageID == "" && p.FontFamily != "sans-serif" && p.FontFamily != "serif" && p.FontFamily != "monospace" {
		return draft, logError("INVALID_INPUT", "字体未登记")
	}
	return draft, nil
}

func loadLogProjectForDesign(id, userID string) (*model.LogProjectModel, bool, error) {
	var p model.LogProjectModel
	if err := model.GetDB().Where("id = ? AND enabled = ?", id, true).Take(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, false, logError("NOT_FOUND", "工程不存在")
		}
		return nil, false, err
	}
	_, admin, err := logWorldAccess(p.WorldID, userID, false)
	if err != nil {
		return nil, false, err
	}
	if err := logCheckSources(&p, userID); err != nil {
		return nil, false, err
	}
	return &p, admin, nil
}

func SaveLogDraft(id, userID string, input LogDraftUpdate) (*LogDraftResult, error) {
	p, admin, err := loadLogProjectForDesign(id, userID)
	if err != nil {
		return nil, err
	}
	if input.ExpectedVersion < 1 || input.ExpectedVersion >= LogMaxVersion {
		return nil, logError("INVALID_INPUT", "版本无效")
	}
	if p.DraftVersion != input.ExpectedVersion {
		return nil, logConflict(p.DraftVersion)
	}
	draft, err := parseLogDraft(input.Draft)
	if err != nil {
		return nil, err
	}
	if err := validateLogDraftStyle(&draft, userID); err != nil {
		return nil, err
	}
	var old LogDraft
	if err := json.Unmarshal([]byte(p.DraftJSON), &old); err != nil {
		return nil, err
	}
	if !admin {
		if len(old.Sections) != len(draft.Sections) {
			return nil, logError("PERMISSION_DENIED", "仅管理者可以更改来源")
		}
		oldSources := map[string]LogSourceSpec{}
		for _, s := range old.Sections {
			oldSources[s.ID] = s.Source
		}
		for _, s := range draft.Sections {
			source, ok := oldSources[s.ID]
			if !ok || !reflect.DeepEqual(source, s.Source) {
				return nil, logError("PERMISSION_DENIED", "仅管理者可以更改来源")
			}
		}
	}
	encoded, err := json.Marshal(draft)
	if err != nil {
		return nil, err
	}
	next := *p
	next.DraftJSON = string(encoded)
	if err := logCheckSources(&next, userID); err != nil {
		return nil, err
	}
	err = model.GetDB().Transaction(func(tx *gorm.DB) error {
		r := tx.Model(&model.LogProjectModel{}).Where("id = ? AND enabled = ? AND draft_version = ?", id, true, input.ExpectedVersion).Updates(map[string]any{"draft_json": string(encoded), "draft_version": gorm.Expr("draft_version + 1")})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return logConflict(p.DraftVersion)
		}
		binding := model.LogProjectStyleBindingModel{ProjectID: id, PackageID: draft.StylePackageID, Version: draft.StylePackageVersion}
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "project_id"}}, DoUpdates: clause.AssignmentColumns([]string{"package_id", "version"})}).Create(&binding).Error
	})
	if err != nil {
		return nil, err
	}
	logAudit("draft.save", userID, id, "", "OK", p.DraftVersion+1, int64(len(draft.Elements)))
	return &LogDraftResult{DraftVersion: p.DraftVersion + 1, Draft: draft}, nil
}
