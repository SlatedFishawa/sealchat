package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"gorm.io/gorm"
	"sealchat/model"
	"sealchat/utils"
)

type MessageAppearancePreviewInput struct {
	ChannelID string `json:"channel_id"`
	Selection struct {
		IdentityID       *string   `json:"identity_id"`
		SharedIdentityID *string   `json:"shared_identity_id"`
		VariantID        *string   `json:"variant_id"`
		FromTime         time.Time `json:"from_time"`
		ToTime           time.Time `json:"to_time"`
	} `json:"selection"`
	Patch MessageAppearancePatch `json:"patch"`
}

func PreviewMessageAppearance(actor string, input MessageAppearancePreviewInput) (map[string]any, error) {
	if err := ValidateMessageAppearancePatch(input.Patch); err != nil {
		return nil, err
	}
	s := input.Selection
	if (s.IdentityID != nil && *s.IdentityID == "") || (s.SharedIdentityID != nil && *s.SharedIdentityID == "") {
		return nil, logError("INVALID_INPUT", "身份标识不能为空")
	}
	if (s.IdentityID == nil) == (s.SharedIdentityID == nil) || s.FromTime.IsZero() || s.ToTime.IsZero() || s.FromTime.After(s.ToTime) {
		return nil, logError("INVALID_INPUT", "身份和时间范围无效")
	}
	if !CanReadChannelByUserId(actor, input.ChannelID) {
		return nil, logError("PERMISSION_DENIED", "频道不可读")
	}
	patch, _ := json.Marshal(input.Patch)
	p := model.MessageMutationPreviewModel{ActorID: actor, ChannelID: input.ChannelID, PatchJSON: string(patch), ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}
	p.Init()
	if err := model.GetDB().Create(&p).Error; err != nil {
		return nil, err
	}
	samples := []map[string]any{}
	last := ""
	for {
		q := ApplyWhisperVisibilityFilter(model.GetDB().Where("channel_id = ? AND created_at >= ? AND created_at <= ? AND id > ? AND is_deleted = ?", input.ChannelID, s.FromTime, s.ToTime, last, false), actor, input.ChannelID)
		if s.IdentityID != nil {
			q = q.Where("sender_identity_id = ?", *s.IdentityID)
		} else {
			q = q.Where("sender_shared_identity_id = ?", *s.SharedIdentityID)
		}
		if s.VariantID != nil {
			q = q.Where("sender_identity_variant_id = ?", *s.VariantID)
		}
		var rows []model.MessageModel
		if err := q.Order("id").Limit(100).Find(&rows).Error; err != nil {
			return nil, err
		}
		items := []model.MessageMutationItemModel{}
		for _, m := range rows {
			p.Matched++
			if p.Matched > 100000 {
				return nil, logError("TOO_LARGE", "预览最多匹配十万条消息")
			}
			updates, err := PrepareMessageAppearance(&m, actor, input.Patch)
			allowed := err == nil
			var domain *LogError
			if err != nil && (!errors.As(err, &domain) || domain.Code != "PERMISSION_DENIED") {
				return nil, err
			}
			if allowed {
				p.Allowed++
				if len(samples) < 20 {
					samples = append(samples, map[string]any{"message_id": m.ID, "before": json.RawMessage(MessageAppearanceSnapshot(&m)), "after": updates})
				}
			}
			items = append(items, model.MessageMutationItemModel{PreviewID: p.ID, Ordinal: p.Matched, MessageID: m.ID, Version: m.Version, Allowed: allowed})
			last = m.ID
		}
		if len(items) > 0 {
			if err := model.GetDB().Create(&items).Error; err != nil {
				return nil, err
			}
		}
		if len(rows) < 100 {
			break
		}
	}
	if err := model.GetDB().Model(&p).Updates(map[string]any{"matched": p.Matched, "allowed": p.Allowed, "ready": true}).Error; err != nil {
		return nil, err
	}
	logAudit("appearance.preview", actor, "", p.ID, "OK", 0, p.Matched)
	return map[string]any{"preview_id": p.ID, "expires_at": p.ExpiresAt, "matched_count": p.Matched, "allowed_count": p.Allowed, "denied_count": p.Matched - p.Allowed, "samples": samples}, nil
}
func ApplyMessageAppearance(actor, previewID, clientOp string) (map[string]any, error) {
	if clientOp == "" || len(clientOp) > 100 {
		return nil, logError("INVALID_INPUT", "操作标识无效")
	}
	h := sha256.Sum256([]byte("appearance\x00" + previewID))
	hash := hex.EncodeToString(h[:])
	var existing model.LogJobModel
	if err := model.GetDB().Where("actor_id = ? AND client_op_id = ?", actor, clientOp).Take(&existing).Error; err == nil {
		if existing.PayloadHash != hash || existing.Kind != "appearance" {
			return nil, logError("VERSION_CONFLICT", "操作标识冲突")
		}
		return map[string]any{"job_id": existing.ID}, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	var p model.MessageMutationPreviewModel
	if err := model.GetDB().Where("id = ? AND actor_id = ? AND ready = ?", previewID, actor, true).Take(&p).Error; err != nil {
		return nil, logError("NOT_FOUND", "预览不存在")
	}
	if !time.Now().Before(p.ExpiresAt) {
		return nil, logError("PREVIEW_EXPIRED", "预览已过期")
	}
	if !CanReadChannelByUserId(actor, p.ChannelID) {
		return nil, logError("PERMISSION_DENIED", "频道不可读")
	}
	j := model.LogJobModel{Kind: "appearance", ActorID: actor, ClientOpID: clientOp, ChannelID: p.ChannelID, InputJSON: previewID, PayloadHash: hash, Status: "queued", Total: p.Matched}
	j.Init()
	if err := model.GetDB().Create(&j).Error; err != nil {
		if model.GetDB().Where("actor_id = ? AND client_op_id = ?", actor, clientOp).Take(&existing).Error == nil && existing.PayloadHash == hash {
			return map[string]any{"job_id": existing.ID}, nil
		}
		return nil, err
	}
	logAudit("appearance.apply", actor, "", j.ID, "OK", 0, j.Total)
	return map[string]any{"job_id": j.ID}, nil
}

func runMessageAppearanceJob(ctx context.Context, broadcast func(string, string)) error {
	now := time.Now().UTC()
	var j model.LogJobModel
	query := model.GetDB().Where("kind = ? AND (status = ? OR (status = ? AND lease_until < ?))", "appearance", "queued", "running", now).Order("created_at, id").Limit(1).Find(&j)
	if query.Error != nil {
		return query.Error
	}
	if query.RowsAffected == 0 {
		return nil
	}
	token := utils.NewID()
	r := model.GetDB().Model(&model.LogJobModel{}).Where("id = ? AND (status = ? OR (status = ? AND lease_until < ?))", j.ID, "queued", "running", now).Updates(map[string]any{"status": "running", "lease_token": token, "lease_until": now.Add(2 * time.Minute)})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return nil
	}
	j.LeaseToken = token
	var preview model.MessageMutationPreviewModel
	if err := model.GetDB().Where("id = ?", j.InputJSON).Take(&preview).Error; err != nil {
		return err
	}
	var patch MessageAppearancePatch
	if err := json.Unmarshal([]byte(preview.PatchJSON), &patch); err != nil {
		return err
	}
	for {
		if err := logRenewLease(ctx, &j, j.Cursor); err != nil {
			return err
		}
		var items []model.MessageMutationItemModel
		if err := model.GetDB().Where("preview_id = ? AND ordinal > ?", preview.ID, j.Cursor).Order("ordinal").Limit(100).Find(&items).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return model.GetDB().Model(&model.LogJobModel{}).Where("id = ? AND lease_token = ?", j.ID, token).Update("status", "done").Error
		}
		for _, item := range items {
			if err := ctx.Err(); err != nil {
				return err
			}
			result := model.MessageMutationResultModel{JobID: j.ID, Ordinal: item.Ordinal, MessageID: item.MessageID, Status: "success"}
			var m model.MessageModel
			err := model.GetDB().Where("id = ? AND channel_id = ?", item.MessageID, j.ChannelID).Take(&m).Error
			var updates map[string]any
			if errors.Is(err, gorm.ErrRecordNotFound) {
				result.Status = "denied"
				result.Code = "PERMISSION_DENIED"
			} else if err != nil {
				return err
			} else if m.Version != item.Version {
				result.Status = "conflict"
				result.Code = "VERSION_CONFLICT"
			} else {
				updates, err = PrepareMessageAppearance(&m, j.ActorID, patch)
				if err != nil {
					result.Status = "failed"
					result.Code = "INVALID_PATCH"
					var domain *LogError
					if errors.As(err, &domain) {
						result.Code = domain.Code
						if domain.Code == "PERMISSION_DENIED" {
							result.Status = "denied"
						}
					}
				}
			}
			before := MessageAppearanceSnapshot(&m)
			err = model.GetDB().Transaction(func(tx *gorm.DB) error {
				claim := tx.Model(&model.LogJobModel{}).Where("id = ? AND lease_token = ? AND status = ? AND cursor = ? AND lease_until > ?", j.ID, token, "running", j.Cursor, time.Now().UTC()).Updates(map[string]any{"cursor": item.Ordinal, "progress": item.Ordinal, "lease_until": time.Now().UTC().Add(2 * time.Minute)})
				if claim.Error != nil {
					return claim.Error
				}
				if claim.RowsAffected != 1 {
					return logError("VERSION_CONFLICT", "任务租约已失效")
				}
				if result.Status == "success" {
					updates["is_edited"] = true
					updates["edit_count"] = gorm.Expr("edit_count + 1")
					updates["edited_by_user_id"] = j.ActorID
					if err := model.MessageUpdateTx(tx, m.ID, &item.Version, updates); err != nil {
						if errors.Is(err, model.ErrMessageVersionConflict) {
							result.Status = "conflict"
							result.Code = "VERSION_CONFLICT"
						} else {
							return err
						}
					}
					if result.Status == "success" {
						if err := tx.Where("id = ?", m.ID).Take(&m).Error; err != nil {
							return err
						}
						history := model.MessageEditHistoryModel{MessageID: m.ID, ChannelID: m.ChannelID, EditorID: j.ActorID, EditedUserID: m.UserID, PrevContent: m.Content, BeforeSnapshot: before, AfterSnapshot: MessageAppearanceSnapshot(&m), MutationJobID: j.ID}
						if err := tx.Create(&history).Error; err != nil {
							return err
						}
					}
				}
				return tx.Create(&result).Error
			})
			if err != nil {
				return err
			}
			j.Cursor = item.Ordinal
			if result.Status == "success" && broadcast != nil {
				broadcast(m.ID, j.ActorID)
			}
		}
	}
}
func GetMessageMutationJob(actor, jobID, cursor string, limit int, items bool) (map[string]any, error) {
	var j model.LogJobModel
	if err := model.GetDB().Where("id = ? AND kind = ?", jobID, "appearance").Take(&j).Error; err != nil {
		return nil, logError("NOT_FOUND", "任务不存在")
	}
	if j.ActorID != actor {
		channel, err := model.ChannelGet(j.ChannelID)
		if err != nil || !CanReadChannelByUserId(actor, j.ChannelID) || ChannelMemberRoleRank(channel, j.ChannelID, actor) < 3 {
			return nil, logError("PERMISSION_DENIED", "无权读取任务")
		}
	}
	if items {
		last := int64(0)
		if cursor != "" {
			v, err := strconv.ParseInt(cursor, 10, 64)
			if err != nil || v < 0 {
				return nil, logError("INVALID_INPUT", "游标无效")
			}
			last = v
		}
		if limit < 1 || limit > 100 {
			return nil, logError("INVALID_INPUT", "limit 无效")
		}
		var rows []model.MessageMutationResultModel
		if err := model.GetDB().Where("job_id = ? AND ordinal > ?", jobID, last).Order("ordinal").Limit(limit + 1).Find(&rows).Error; err != nil {
			return nil, err
		}
		var next *string
		if len(rows) > limit {
			rows = rows[:limit]
			v := strconv.FormatInt(rows[len(rows)-1].Ordinal, 10)
			next = &v
		}
		out := []map[string]any{}
		for _, r := range rows {
			out = append(out, map[string]any{"messageId": r.MessageID, "status": r.Status, "code": r.Code})
		}
		return map[string]any{"items": out, "nextCursor": next}, nil
	}
	var counts []struct {
		Status string
		Count  int64
	}
	if err := model.GetDB().Model(&model.MessageMutationResultModel{}).Select("status, COUNT(*) AS count").Where("job_id = ?", jobID).Group("status").Scan(&counts).Error; err != nil {
		return nil, err
	}
	out := map[string]any{"jobId": j.ID, "status": j.Status, "matched": j.Total, "succeeded": int64(0), "conflicted": int64(0), "denied": int64(0), "failed": int64(0), "itemsCursor": nil}
	for _, c := range counts {
		key := map[string]string{"success": "succeeded", "conflict": "conflicted", "denied": "denied", "failed": "failed"}[c.Status]
		if key != "" {
			out[key] = c.Count
		}
	}
	return out, nil
}
