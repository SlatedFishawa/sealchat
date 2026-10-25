package service

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"gorm.io/gorm"

	"sealchat/model"
)

// LogProjectAsset registers an ordinary LOG image in the draft. The bytes stay an
// existing attachment; the registry entry is the LOG-scoped grant to read it.
// Style package images keep their own references (assetId / backgroundAssetId).
type LogProjectAsset struct {
	ID           string `json:"id"`
	AttachmentID string `json:"attachmentId"`
	Name         string `json:"name"`
}

const (
	logMaxProjectAssets     = 500
	logProjectAssetRootType = "log_project_asset"
)

var logAttachmentIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{4,128}$`)

// Project images are decoded at release like style images, so only formats the
// release validator understands may be registered.
var logProjectImageMIME = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}

func logProjectAssetNotFound() error { return logError("NOT_FOUND", "LOG 素材不可用") }

// validateLogProjectAssetRegistry checks the registry shape only; ownership needs the saved draft.
func validateLogProjectAssetRegistry(d *LogDraft) error {
	if len(d.Assets) == 0 {
		d.Assets = nil
		return nil
	}
	if len(d.Assets) > logMaxProjectAssets {
		return logError("INVALID_INPUT", "LOG 素材数量超出上限")
	}
	ids := map[string]bool{}
	for _, a := range d.Assets {
		if !logUUIDPattern.MatchString(a.ID) || ids[a.ID] || !logAttachmentIDPattern.MatchString(a.AttachmentID) || len([]rune(a.Name)) > 200 {
			return logError("INVALID_INPUT", "LOG 素材登记无效")
		}
		ids[a.ID] = true
	}
	return nil
}

// claimLogProjectAssetRegistrations keeps an existing registry entry stable. A new entry may
// reuse a file already authorized by the saved draft; otherwise it must claim the editor's own
// unbound temporary upload. Claiming happens in the same transaction as the draft save.
func claimLogProjectAssetRegistrations(tx *gorm.DB, old, next *LogDraft, projectID, userID string) error {
	previous := map[string]string{}
	authorizedAttachments := map[string]bool{}
	for _, a := range old.Assets {
		previous[a.ID] = a.AttachmentID
		authorizedAttachments[a.AttachmentID] = true
	}
	denied := func(id string) error {
		return &LogError{Code: "PERMISSION_DENIED", Message: "只能登记自己新上传的图片", Details: map[string]any{"assetIds": []string{id}}}
	}
	unbound := func(db *gorm.DB, attachmentID string) *gorm.DB {
		return db.Where(
			"id = ? AND user_id = ? AND is_temp = ? AND deleted_at IS NULL AND COALESCE(root_id, '') = '' AND COALESCE(root_id_type, '') = '' AND COALESCE(channel_id, '') = '' AND COALESCE(parent_id, '') = '' AND COALESCE(parent_id_type, '') = ''",
			attachmentID, userID, true,
		)
	}
	for _, a := range next.Assets {
		if attachment, ok := previous[a.ID]; ok {
			if attachment != a.AttachmentID {
				return logError("INVALID_INPUT", "LOG 素材不能改绑其他文件")
			}
			continue
		}
		if authorizedAttachments[a.AttachmentID] {
			continue
		}
		var att model.AttachmentModel
		if err := unbound(tx, a.AttachmentID).Limit(1).Find(&att).Error; err != nil {
			return err
		}
		if att.ID == "" || !logProjectAttachmentUsable(&att) {
			return denied(a.ID)
		}
		r := unbound(tx.Model(&model.AttachmentModel{}), a.AttachmentID).Updates(map[string]any{
			"is_temp": false, "root_id": projectID, "root_id_type": logProjectAssetRootType,
		})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return denied(a.ID)
		}
		authorizedAttachments[a.AttachmentID] = true
	}
	return nil
}

func logProjectAttachmentUsable(a *model.AttachmentModel) bool {
	if a == nil || a.ID == "" {
		return false
	}
	mime := strings.ToLower(strings.TrimSpace(strings.SplitN(a.MimeType, ";", 2)[0]))
	if mime == "image/jpg" {
		mime = "image/jpeg"
	}
	return a.DeletedAt == nil && a.RootIDType != "world_clue" && !a.IsTTSManaged() && a.Size <= 20<<20 && logProjectImageMIME[mime]
}

// logProjectAttachment resolves a registered attachment by exact ID (no legacy hash lookup).
func logProjectAttachment(id string) *model.AttachmentModel {
	if !logAttachmentIDPattern.MatchString(id) {
		return nil
	}
	var a model.AttachmentModel
	if err := model.GetDB().Where("id = ?", id).Limit(1).Find(&a).Error; err != nil || !logProjectAttachmentUsable(&a) {
		return nil
	}
	return &a
}

func logProjectAssetIDs(d *LogDraft) map[string]bool {
	out := make(map[string]bool, len(d.Assets))
	for _, a := range d.Assets {
		out[a.ID] = true
	}
	return out
}

// logReferencedProjectAssets lists project assets used by the page background and elements,
// in first-use order. Registered but unused assets never reach a render document or release.
func logReferencedProjectAssets(d *LogDraft) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if d.Page.BackgroundProjectAssetID != nil {
		add(*d.Page.BackgroundProjectAssetID)
	}
	elements, err := logDraftElements(d)
	if err != nil {
		return nil, err
	}
	for _, e := range elements {
		if id, ok := e.Content["projectAssetId"].(string); ok {
			add(id)
		}
	}
	return out, nil
}

func logProjectAssetsUnavailable(ids []string) error {
	return &LogError{Code: "INVALID_TEMPLATE", Message: "引用的 LOG 素材文件已不可用", Details: map[string]any{"assetIds": ids}}
}

// validateLogProjectAssetsReadable fails publishing early instead of releasing missing images.
func validateLogProjectAssetsReadable(d *LogDraft) error {
	ids, err := logReferencedProjectAssets(d)
	if err != nil {
		return err
	}
	byID := map[string]LogProjectAsset{}
	for _, a := range d.Assets {
		byID[a.ID] = a
	}
	bad := []string{}
	for _, id := range ids {
		if logProjectAttachment(byID[id].AttachmentID) == nil {
			bad = append(bad, id)
		}
	}
	if len(bad) > 0 {
		return logProjectAssetsUnavailable(bad)
	}
	return nil
}

// GetLogProjectAsset is the LOG-scoped read adapter: any legal designer of the project may
// read images registered in its saved draft, without widening ordinary attachment access.
func GetLogProjectAsset(ctx context.Context, projectID, assetID, userID string) (*LogBodyAssetBytes, error) {
	if userID == "" {
		return nil, logError("UNAUTHENTICATED", "请先登录")
	}
	if !logUUIDPattern.MatchString(assetID) {
		return nil, logProjectAssetNotFound()
	}
	p, _, err := loadLogProjectForDesign(projectID, userID)
	if err != nil {
		return nil, logProjectAssetNotFound()
	}
	var d struct {
		Assets []LogProjectAsset `json:"assets"`
	}
	if err := json.Unmarshal([]byte(p.DraftJSON), &d); err != nil {
		return nil, logProjectAssetNotFound()
	}
	for _, a := range d.Assets {
		if a.ID != assetID {
			continue
		}
		asset, err := logReadBodyAsset(ctx, logProjectAttachment(a.AttachmentID))
		if err != nil {
			return nil, logProjectAssetNotFound()
		}
		return asset, nil
	}
	return nil, logProjectAssetNotFound()
}

// logBuildProjectAssets snapshots each referenced project asset once per release as a
// publisher-approved (node-less) resource and returns asset ID -> public key.
func logBuildProjectAssets(ctx context.Context, r *model.LogReleaseModel, d *LogDraft) (map[string]string, error) {
	ids, err := logReferencedProjectAssets(d)
	if err != nil {
		return nil, err
	}
	byID := map[string]LogProjectAsset{}
	for _, a := range d.Assets {
		byID[a.ID] = a
	}
	keys := map[string]string{}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		a := logProjectAttachment(byID[id].AttachmentID)
		if a == nil {
			return nil, logProjectAssetsUnavailable([]string{id})
		}
		// Keyed by attachment: two registrations of one file share a single snapshot.
		key, err := logSnapshotAttachment(ctx, r, a, logPublicKey(r.ID, "project", a.ID), "")
		if err != nil {
			return nil, err
		}
		if key == "" {
			return nil, logProjectAssetsUnavailable([]string{id})
		}
		keys[id] = key
	}
	return keys, nil
}
