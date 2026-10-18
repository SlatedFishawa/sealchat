package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"sealchat/model"
	"sealchat/utils"
)

func logPublicKey(release, domain, id string) string {
	h := sha256.Sum256([]byte(release + "\x00" + domain + "\x00" + id))
	return hex.EncodeToString(h[:16])
}
func logAssetRef(release, key, node string) error {
	r := model.LogAssetReferenceModel{ReleaseID: release, AssetKey: key, NodeID: node}
	return model.GetDB().Clauses(clause.OnConflict{DoNothing: true}).Create(&r).Error
}
func logBuildStyleAssets(r *model.LogReleaseModel, d *LogDraft) error {
	if d.StylePackageID == "" {
		return nil
	}
	var assets []model.LogStyleAssetModel
	if err := model.GetDB().Where("package_id = ? AND version = ?", d.StylePackageID, d.StylePackageVersion).Find(&assets).Error; err != nil {
		return err
	}
	total := int64(0)
	for _, a := range assets {
		total += int64(len(a.Data))
		key := logPublicKey(r.ID, "style", a.AssetID)
		row := model.LogReleaseAssetModel{ReleaseID: r.ID, AssetKey: key, MIME: a.MIME, Hash: a.Hash, Data: a.Data}
		if err := model.GetDB().Create(&row).Error; err != nil {
			return err
		}
		if err := logAssetRef(r.ID, key, ""); err != nil {
			return err
		}
	}
	return model.GetDB().Model(r).Updates(map[string]any{"asset_bytes": total, "asset_count": len(assets)}).Error
}
func logSnapshotAttachment(ctx context.Context, r *model.LogReleaseModel, m *model.MessageModel, nodeID, attachmentID string) (string, error) {
	if attachmentID == "" {
		return "", nil
	}
	a, err := ResolveAttachmentAccessible(m.UserID, m.UserID, m.ChannelID, attachmentID)
	if err != nil {
		return "", nil
	}
	if a == nil || a.IsTTSManaged() || a.Size > 20<<20 {
		return "", nil
	}
	key := logPublicKey(r.ID, "attachment", a.ID)
	var existing int64
	if err := model.GetDB().Model(&model.LogReleaseAssetModel{}).Where("release_id = ? AND asset_key = ?", r.ID, key).Count(&existing).Error; err != nil {
		return "", err
	}
	if existing > 0 {
		return key, logAssetRef(r.ID, key, nodeID)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	reader, err := OpenAttachmentRead(ctx, a)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	b, err := io.ReadAll(io.LimitReader(reader, (20<<20)+1))
	if err != nil {
		return "", err
	}
	if len(b) > 20<<20 {
		return "", logError("TOO_LARGE", "公开资源超过 20MB")
	}
	p := LogStylePackage{SchemaVersion: 1, ID: "asset-check", Version: "1.0.0", MinRendererVersion: "1.0.0", Name: "asset", Tokens: map[string]any{}, Rules: []LogStyleRule{}, Templates: map[string]string{"empty": "<div></div>"}, SettingsSchema: map[string]any{}, Assets: []LogStyleAsset{{ID: "asset", Path: "assets/item", MIME: a.MimeType}}}
	if err := ValidateLogStyle(&p, map[string][]byte{"asset": b}); err != nil {
		return "", nil
	}
	if !strings.HasPrefix(p.Assets[0].MIME, "image/") {
		return "", nil
	}
	row := model.LogReleaseAssetModel{ReleaseID: r.ID, AssetKey: key, AttachmentID: a.ID, MIME: p.Assets[0].MIME, Hash: p.Assets[0].SHA256, Data: b}
	if err := model.GetDB().Transaction(func(tx *gorm.DB) error {
		reserve := tx.Model(&model.LogReleaseModel{}).Where("id = ? AND asset_bytes <= ? AND asset_count < ?", r.ID, (512<<20)-len(b), 10000).Updates(map[string]any{"asset_bytes": gorm.Expr("asset_bytes + ?", len(b)), "asset_count": gorm.Expr("asset_count + 1")})
		if reserve.Error != nil {
			return reserve.Error
		}
		if reserve.RowsAffected != 1 {
			return logError("TOO_LARGE", "发布资源超过 512MB 或一万项")
		}
		return tx.Create(&row).Error
	}); err != nil {
		return "", err
	}
	if err := logAssetRef(r.ID, key, nodeID); err != nil {
		return "", err
	}
	return key, nil
}

func logBuildMessage(ctx context.Context, r *model.LogReleaseModel, section string, m *model.MessageModel, ordinal int64) error {
	id := utils.NewID()
	doc := buildRichDocumentForExport(m.Content, true)
	var walk func([]AgentRichNode, int) error
	count := 0
	walk = func(nodes []AgentRichNode, depth int) error {
		if depth > 32 {
			return logError("TOO_LARGE", "正文嵌套超限")
		}
		for i := range nodes {
			n := &nodes[i]
			marks := n.Marks[:0]
			for _, mark := range n.Marks {
				if mark.Type == "link" {
					u, err := url.Parse(mark.Value)
					if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
						continue
					}
				}
				marks = append(marks, mark)
			}
			n.Marks = marks
			count++
			if count > 10000 {
				return logError("TOO_LARGE", "正文节点超限")
			}
			if n.Type == "image" {
				attachment := n.Attrs["attachment_id"]
				// Only explicit registered attachment references may become public assets.
				key, err := logSnapshotAttachment(ctx, r, m, id, attachment)
				if err != nil {
					return err
				}
				n.Attrs = map[string]string{}
				if key != "" {
					n.Attrs["src"] = "/__log_asset/" + key
				}
			}
			if err := walk(n.Children, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(doc.Blocks, 0); err != nil {
		return err
	}
	avatar, err := logSnapshotAttachment(ctx, r, m, id, m.SenderIdentityAvatarID)
	if err != nil {
		return err
	}
	name := m.SenderIdentityName
	if name == "" {
		name = m.SenderMemberName
	}
	if name == "" {
		name = "匿名"
	}
	speakerID := m.SenderIdentityID
	if speakerID == "" {
		speakerID = m.UserID
	}
	var color, avatarValue, variant any
	if logColorPattern.MatchString(m.SenderIdentityColor) {
		color = m.SenderIdentityColor
	}
	if avatar != "" {
		avatarValue = avatar
	}
	if m.SenderIdentityVariantID != "" {
		variant = logPublicKey(r.ID, "variant", m.SenderIdentityVariantID)
	}
	typ := "ic"
	if m.ICMode == "ooc" {
		typ = "ooc"
	}
	if m.User != nil && m.User.IsBot {
		typ = "bot"
	}
	if m.DiceVisualJSON != "" {
		typ = "dice"
	}
	node := map[string]any{"id": id, "kind": "message", "sectionId": section, "messageType": typ, "speaker": map[string]any{"key": logPublicKey(r.ID, "speaker", speakerID), "name": name, "color": color, "avatarAssetKey": avatarValue, "variantKey": variant}, "bodyHtml": RenderAgentRichDocumentHTML(doc, true), "plainText": AgentRichDocumentPlainText(doc), "createdAt": m.CreatedAt.UTC(), "quoteNodeId": nil}
	b, err := json.Marshal(node)
	if err != nil {
		return err
	}
	row := model.LogReleaseNodeModel{ID: id, ReleaseID: r.ID, SectionID: section, Ordinal: ordinal, MessageID: m.ID, ChannelID: m.ChannelID, SourceVersion: m.Version, NodeJSON: string(b), SearchText: AgentRichDocumentPlainText(doc), QuoteMessageID: m.QuoteID}
	return model.GetDB().Create(&row).Error
}
func logBuildElement(r *model.LogReleaseModel, e LogElement, ordinal int64) error {
	id := utils.NewID()
	content := e.Content
	if asset, ok := content["assetId"].(string); ok {
		delete(content, "assetId")
		content["assetKey"] = logPublicKey(r.ID, "style", asset)
	}
	if body, ok := content["body"].(string); ok {
		doc := buildRichDocumentForExport(body, false)
		content["body"] = RenderAgentRichDocumentHTML(doc, false)
	}
	b, err := json.Marshal(map[string]any{"id": id, "kind": "element", "sectionId": e.Anchor.SectionID, "type": e.Type, "templateId": e.TemplateID, "content": content, "style": e.Style})
	if err != nil {
		return err
	}
	row := model.LogReleaseNodeModel{ID: id, ReleaseID: r.ID, SectionID: e.Anchor.SectionID, Ordinal: ordinal, NodeJSON: string(b)}
	return model.GetDB().Create(&row).Error
}
func logBuildPublicMetadata(r *model.LogReleaseModel, d *LogDraft) (map[string]any, error) {
	// d.Sections is already in publish order. In chapter mode a section's public title is its chapter's
	// visual title (labels are editor-only); readers that predate chapters still get one entry per section.
	chapterTitles := map[string]string{}
	for _, c := range d.Chapters {
		chapterTitles[c.ID] = c.Title
	}
	sections := []map[string]string{}
	chapters := []map[string]any{}
	for _, s := range d.Sections {
		if s.ChapterID == "" {
			sections = append(sections, map[string]string{"id": s.ID, "title": s.Title})
			continue
		}
		sections = append(sections, map[string]string{"id": s.ID, "title": chapterTitles[s.ChapterID], "chapterId": s.ChapterID})
		if n := len(chapters); n > 0 && chapters[n-1]["id"] == s.ChapterID {
			chapters[n-1]["sectionIds"] = append(chapters[n-1]["sectionIds"].([]string), s.ID)
			continue
		}
		chapters = append(chapters, map[string]any{"id": s.ChapterID, "title": chapterTitles[s.ChapterID], "sectionIds": []string{s.ID}})
	}
	b, _ := json.Marshal(d.Page)
	page := map[string]any{}
	if err := json.Unmarshal(b, &page); err != nil {
		return nil, err
	}
	if d.Page.BackgroundAssetID != nil {
		page["backgroundAssetId"] = logPublicKey(r.ID, "style", *d.Page.BackgroundAssetID)
	}
	var style any
	if d.StylePackageID != "" {
		p, err := logLoadStyle(d.StylePackageID, d.StylePackageVersion)
		if err != nil {
			return nil, err
		}
		rules := []map[string]any{}
		for _, rule := range p.Rules {
			item := map[string]any{"templateId": rule.TemplateID}
			if rule.MessageType != "" {
				item["messageType"] = rule.MessageType
			}
			if rule.IdentityKey != "" {
				item["identityKey"] = logPublicKey(r.ID, "speaker", rule.IdentityKey)
			}
			if rule.VariantKey != "" {
				item["variantKey"] = logPublicKey(r.ID, "variant", rule.VariantKey)
			}
			rules = append(rules, item)
		}
		assets := []map[string]string{}
		cssText := logPublicCSS(r.ID, p)
		for _, a := range p.Assets {
			key := logPublicKey(r.ID, "style", a.ID)
			assets = append(assets, map[string]string{"assetKey": key, "mime": a.MIME, "sha256": a.SHA256})
			if strings.HasPrefix(a.MIME, "font/") && d.Page.FontFamily == a.ID {
				page["fontFamily"] = "log-font-" + key
			}
		}
		tokens := p.Tokens
		for k, v := range d.ThemeTokens {
			tokens[k] = v
		}
		style = map[string]any{"schemaVersion": 1, "version": p.Version, "name": p.Name, "license": p.License, "minRendererVersion": p.MinRendererVersion, "tokens": tokens, "templates": p.Templates, "css": cssText, "rules": rules, "settingsSchema": p.SettingsSchema, "assets": assets}
	}
	out := map[string]any{"schemaVersion": 1, "title": d.Title, "releaseId": r.ID, "sections": sections, "page": page, "style": style}
	if len(chapters) > 0 {
		out["chapters"] = chapters
	}
	return out, nil
}

func logPublicCSS(release string, p *LogStylePackage) string {
	paths := map[string]string{}
	fonts := map[string]string{}
	for _, a := range p.Assets {
		key := logPublicKey(release, "style", a.ID)
		paths[a.Path] = "/__log_asset/" + key
		if strings.HasPrefix(a.MIME, "font/") {
			fonts[a.ID] = "log-font-" + key
		}
	}
	lexer := css.NewLexer(parse.NewInputString(p.CSS))
	var out strings.Builder
	property := ""
	fontDeclaration := false
	depth := 0
	for {
		tt, data := lexer.Next()
		if tt == css.ErrorToken {
			break
		}
		value := string(data)
		switch tt {
		case css.LeftBraceToken:
			depth++
			property = ""
			fontDeclaration = false
		case css.RightBraceToken:
			depth--
			property = ""
			fontDeclaration = false
		case css.SemicolonToken:
			property = ""
			fontDeclaration = false
		case css.ColonToken:
			fontDeclaration = depth > 0 && strings.EqualFold(property, "font-family")
		case css.IdentToken:
			if fontDeclaration {
				if name, ok := fonts[value]; ok {
					value = name
				}
			} else {
				property = value
			}
		case css.StringToken:
			if fontDeclaration {
				if name, ok := fonts[strings.Trim(value, "\"'")]; ok {
					value = "\"" + name + "\""
				}
			}
		case css.URLToken:
			if len(value) >= 5 {
				path := strings.Trim(strings.TrimSpace(value[4:len(value)-1]), "\"'")
				if mapped, ok := paths[path]; ok {
					value = "url(\"" + mapped + "\")"
				}
			}
		}
		out.WriteString(value)
	}
	return out.String()
}
func logResolvePublicURLs(raw, slug string) string {
	return strings.ReplaceAll(raw, "/__log_asset/", "/api/v1/public/log/"+url.PathEscape(slug)+"/assets/")
}
