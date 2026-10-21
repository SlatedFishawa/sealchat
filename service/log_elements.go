package service

import (
	"encoding/json"
	"sealchat/model"
	"strings"
)

type LogAnchor struct {
	Kind      string `json:"kind"`
	SectionID string `json:"sectionId"`
	MessageID string `json:"messageId,omitempty"`
	Side      string `json:"side,omitempty"`
}
type LogElement struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Anchor     LogAnchor      `json:"anchor"`
	Order      int64          `json:"order"`
	TemplateID string         `json:"templateId"`
	Content    map[string]any `json:"content"`
	Style      map[string]any `json:"style"`
}

// validateLogDraftStyle checks style references against the bound package and project image
// references against the draft's own asset registry; neither source can stand in for the other.
func validateLogDraftStyle(d *LogDraft, userID string) error {
	projectAssets := logProjectAssetIDs(d)
	if id := d.Page.BackgroundProjectAssetID; id != nil && (d.Page.BackgroundAssetID != nil || !projectAssets[*id]) {
		return logTemplateError()
	}
	if d.StylePackageID == "" && d.StylePackageVersion == "" && len(d.Elements) == 0 && len(d.ThemeTokens) == 0 && d.Page.BackgroundAssetID == nil && d.Page.HeaderTemplateID == nil && d.Page.FooterTemplateID == nil {
		return nil
	}
	p, err := GetLogStyle(d.StylePackageID, d.StylePackageVersion, userID)
	if err != nil {
		return err
	}
	assets, err := logStyleAssets(p.ID, p.Version)
	if err != nil {
		return err
	}
	if err := ValidateLogStyle(p, assets); err != nil {
		return err
	}
	if d.Page.FontFamily != "sans-serif" && d.Page.FontFamily != "serif" && d.Page.FontFamily != "monospace" && !isLogPlatformFont(d.Page.FontFamily) {
		valid := false
		for _, a := range p.Assets {
			if strings.HasPrefix(a.MIME, "font/") && a.ID == d.Page.FontFamily {
				valid = true
			}
		}
		if !valid {
			return logTemplateError()
		}
	}
	for key, v := range d.ThemeTokens {
		base, ok := p.Tokens[key]
		if !ok {
			return logTemplateError()
		}
		switch b := base.(type) {
		case string:
			s, ok := v.(string)
			if !ok || len(s) > 200 || strings.ContainsAny(s, ";{}\\<>@()") {
				return logTemplateError()
			}
			_ = b
		case float64:
			if _, ok := v.(float64); !ok {
				return logTemplateError()
			}
		case bool:
			if _, ok := v.(bool); !ok {
				return logTemplateError()
			}
		default:
			return logTemplateError()
		}
	}
	if id := d.Page.BackgroundAssetID; id != nil {
		if _, ok := assets[*id]; !ok {
			return logTemplateError()
		}
	}
	for _, id := range []*string{d.Page.HeaderTemplateID, d.Page.FooterTemplateID} {
		if id != nil {
			if _, ok := p.Templates[*id]; !ok {
				return logTemplateError()
			}
		}
	}
	sections := map[string]bool{}
	for _, s := range d.Sections {
		sections[s.ID] = true
	}
	seen := map[string]bool{}
	for _, raw := range d.Elements {
		var e LogElement
		if logStrictJSON(raw, &e) != nil || !logUUIDPattern.MatchString(e.ID) || seen[e.ID] || !sections[e.Anchor.SectionID] || e.Order < 0 || e.Order > LogMaxVersion || e.Content == nil || e.Style == nil {
			return logTemplateError()
		}
		seen[e.ID] = true
		if _, ok := p.Templates[e.TemplateID]; !ok {
			return logTemplateError()
		}
		if e.Anchor.Kind == "message" {
			if e.Anchor.MessageID == "" || len(e.Anchor.MessageID) > 100 || (e.Anchor.Side != "before" && e.Anchor.Side != "after") {
				return logTemplateError()
			}
		} else if (e.Anchor.Kind != "sectionStart" && e.Anchor.Kind != "sectionEnd") || e.Anchor.MessageID != "" || e.Anchor.Side != "" {
			return logTemplateError()
		}
		if err := logElementContent(e, assets, projectAssets); err != nil {
			return err
		}
		// Each template owns a closed settings schema; absence permits no settings.
		schema, ok := p.SettingsSchema[e.TemplateID].(map[string]any)
		if !ok {
			if len(e.Style) > 0 || e.Type == "custom" {
				return logTemplateError()
			}
		} else {
			r, err := logResolveSettings(schema)
			value := map[string]any{"style": e.Style}
			if e.Type == "custom" {
				value["props"] = e.Content["props"]
			}
			if err != nil || r.Validate(value) != nil {
				return logTemplateError()
			}
		}
	}
	return nil
}

// Image elements carry one image source: assetId (style package) or projectAssetId (LOG registry).
// A cover may have none; an image plate needs exactly one.
func logElementContent(e LogElement, assets map[string][]byte, projectAssets map[string]bool) error {
	allowed := map[string]string{}
	images := 0
	switch e.Type {
	case "cover":
		allowed = map[string]string{"title": "string", "subtitle": "string", "assetId": "asset?", "projectAssetId": "project?", "imageWidth": "width?"}
	case "imagePlate":
		allowed = map[string]string{"assetId": "asset?", "projectAssetId": "project?", "caption": "string", "fit": "fit", "imageWidth": "width?"}
	case "pageBreak":
	case "transition":
		allowed = map[string]string{"label": "string"}
	case "quote", "prologue", "epilogue":
		allowed = map[string]string{"body": "string"}
	case "heading":
		allowed = map[string]string{"text": "string", "level": "level"}
	case "toc":
		allowed = map[string]string{"depth": "level"}
	case "custom":
		allowed = map[string]string{"props": "object"}
	default:
		return logTemplateError()
	}
	for key := range e.Content {
		if _, ok := allowed[key]; !ok {
			return logTemplateError()
		}
	}
	for key, kind := range allowed {
		v, ok := e.Content[key]
		if !ok {
			if kind == "asset?" || kind == "project?" || kind == "width?" {
				continue
			}
			return logTemplateError()
		}
		s, isString := v.(string)
		switch kind {
		case "width?":
			n, ok := v.(float64)
			if !ok || !validLogImageWidth(n) {
				return logTemplateError()
			}
		case "string":
			if !isString || len(s) > 128<<10 {
				return logTemplateError()
			}
		case "asset?":
			if !isString || assets[s] == nil {
				return logTemplateError()
			}
			images++
		case "project?":
			if !isString || !projectAssets[s] {
				return logTemplateError()
			}
			images++
		case "fit":
			if !isString || (s != "contain" && s != "cover") {
				return logTemplateError()
			}
		case "level":
			n, ok := v.(float64)
			if !ok || (n != 1 && n != 2 && n != 3) {
				return logTemplateError()
			}
		case "object":
			if _, ok := v.(map[string]any); !ok {
				return logTemplateError()
			}
		}
	}
	if images > 1 || (e.Type == "imagePlate" && images != 1) {
		return logTemplateError()
	}
	return nil
}

func logDraftElements(d *LogDraft) ([]LogElement, error) {
	out := make([]LogElement, 0, len(d.Elements))
	for _, raw := range d.Elements {
		var e LogElement
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func validateLogPublishAnchors(p *model.LogProjectModel, d *LogDraft, actor string) error {
	elements, err := logDraftElements(d)
	if err != nil {
		return err
	}
	bad := []string{}
	for _, section := range d.Sections {
		anchors := []LogElement{}
		for _, e := range elements {
			if e.Anchor.Kind == "message" && e.Anchor.SectionID == section.ID {
				anchors = append(anchors, e)
			}
		}
		for start := 0; start < len(anchors); start += 200 {
			end := start + 200
			if end > len(anchors) {
				end = len(anchors)
			}
			ids := []string{}
			for _, e := range anchors[start:end] {
				ids = append(ids, e.Anchor.MessageID)
			}
			var found []string
			if err := logSourceQuery(p, section, actor).Where("id IN ? AND is_whisper = ? AND is_revoked = ?", ids, false, false).Pluck("id", &found).Error; err != nil {
				return err
			}
			visible := map[string]bool{}
			for _, id := range found {
				visible[id] = true
			}
			for _, e := range anchors[start:end] {
				if !visible[e.Anchor.MessageID] {
					bad = append(bad, e.ID)
				}
			}
		}
	}
	if len(bad) > 0 {
		return &LogError{Code: "INVALID_TEMPLATE", Message: "存在不可发布的孤立元素锚点", Details: map[string]any{"elementIds": bad}}
	}
	return nil
}
