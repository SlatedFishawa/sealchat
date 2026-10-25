package service

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"gorm.io/gorm"
	"sealchat/model"
	"sealchat/utils"
)

const ttsAudioCacheTTL = 30 * time.Minute
const ttsCleanupBatchSize = 128
const ttsAudioCleanupClaim = "tts-job-audio-cleanup"

type TTSStorageAmount struct {
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
}

func (a *TTSStorageAmount) add(size int64) { a.Files++; a.Bytes += size }

type TTSStorageScope struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Channels int64  `json:"channels"`
	Messages int64  `json:"messages"`
	Files    int64  `json:"files"`
	Bytes    int64  `json:"bytes"`
}

type TTSStorageSummary struct {
	Total       TTSStorageAmount `json:"total"`
	Local       TTSStorageAmount `json:"local"`
	S3          TTSStorageAmount `json:"s3"`
	Reclaimable struct {
		Total               TTSStorageAmount `json:"total"`
		InvalidatedMessages TTSStorageAmount `json:"invalidatedMessages"`
		DeletedMessages     TTSStorageAmount `json:"deletedMessages"`
		ExpiredPreviews     TTSStorageAmount `json:"expiredPreviews"`
	} `json:"reclaimable"`
	Channel TTSStorageScope `json:"channel"`
	World   TTSStorageScope `json:"world"`
}

type TTSCleanupSelection struct {
	ChannelID           string `json:"channelId"`
	InvalidatedMessages bool   `json:"invalidatedMessages"`
	DeletedMessages     bool   `json:"deletedMessages"`
	ExpiredPreviews     bool   `json:"expiredPreviews"`
}

type TTSStoragePurgeRequest struct {
	ChannelID string `json:"channelId"`
	Scope     string `json:"scope"`
}

type TTSPurgeResult struct {
	TTSStorageAmount
	Messages int64 `json:"messages"`
}

type ttsStorageContext struct {
	channel model.ChannelModel
	world   *model.WorldModel
}

func ttsStorageAuthorize(actorID, channelID string) (*ttsStorageContext, error) {
	channelID = strings.TrimSpace(channelID)
	if channelID == "" {
		return nil, TTSValidationError("channelId 不能为空")
	}
	worldID, err := ttsChannelWorld(model.GetDB(), channelID)
	if err != nil {
		return nil, err
	}
	world, err := GetWorldByID(worldID)
	if err != nil {
		return nil, err
	}
	if !ttsCanManageWorld(actorID, world) {
		return nil, ErrTTSDenied
	}
	c := &ttsStorageContext{world: world}
	err = model.GetDB().Select("id", "name", "world_id").Where("id = ? AND world_id = ? AND deleted_at IS NULL AND status <> ?", channelID, worldID, model.ChannelStatusDeleted).First(&c.channel).Error
	return c, err
}

func (c *ttsStorageContext) channels(db *gorm.DB, active bool) *gorm.DB {
	q := db.Model(&model.ChannelModel{}).Select("id").Where("world_id = ?", c.world.ID)
	if active {
		q = q.Where("deleted_at IS NULL AND status <> ?", model.ChannelStatusDeleted)
	}
	return q
}

func ttsAudioQuery(db *gorm.DB) *gorm.DB {
	return db.Model(&model.AttachmentModel{}).Where("deleted_at IS NULL AND root_id_type = ? AND parent_id_type = ? AND object_key LIKE ?", "tts", "job_audio", "tts-private/resources/%")
}

// Attachment metadata stays bounded to 128 records. The operation's read-only
// message reference index includes references outside this world; historical
// jobs are provenance, not live references.
type ttsAudioReferences struct {
	category                       string
	protected                      bool
	channelLive, worldLive         bool
	channelTarget, worldTarget     bool
	channelMessages, worldMessages int64
	rootFound                      bool
}

func ttsJobActive(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "skipped", "unavailable", "invalidated":
		return false
	default:
		return true
	}
}

const ttsCleanupMessageSelect = "id, channel_id, edit_count, is_deleted, is_revoked, deleted_at, tts_status, tts_data"

func ttsStorageWorldChannels(db *gorm.DB, c *ttsStorageContext, ids []string) (map[string]bool, error) {
	result := map[string]bool{}
	if len(ids) == 0 {
		return result, nil
	}
	var channels []model.ChannelModel
	err := db.Select("id").Where("id IN ? AND world_id = ? AND deleted_at IS NULL AND status <> ?", ids, c.world.ID, model.ChannelStatusDeleted).Find(&channels).Error
	for _, ch := range channels {
		result[ch.ID] = true
	}
	return result, err
}

type ttsMessageReferenceIndex map[string]ttsAudioReferences

func ttsInspectAudio(db *gorm.DB, c *ttsStorageContext, attachments []model.AttachmentModel, now time.Time, messages ttsMessageReferenceIndex) (map[string]*ttsAudioReferences, error) {
	refs := make(map[string]*ttsAudioReferences, len(attachments))
	ids, roots := make([]string, 0, len(attachments)), make([]string, 0, len(attachments))
	byRoot := map[string][]string{}
	for _, a := range attachments {
		r := messages[a.ID]
		refs[a.ID] = &r
		ids, roots = append(ids, a.ID), append(roots, a.RootID)
		byRoot[a.RootID] = append(byRoot[a.RootID], a.ID)
	}
	var caches []model.TTSCache
	if err := db.Select("id, resource_id").Where("resource_id IN ? AND deleted_at IS NULL AND expires_at > ?", ids, now).FindInBatches(&caches, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		for _, cache := range caches {
			refs[cache.ResourceID].protected = true
		}
		return nil
	}).Error; err != nil {
		return nil, err
	}
	var voices []model.TTSVoice
	if err := db.Select("id, lifecycle, preview_expires_at, preview_resource_id").Where("preview_resource_id IN ?", ids).FindInBatches(&voices, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		for _, v := range voices {
			r := refs[v.PreviewResourceID]
			switch v.Lifecycle {
			case "creating", "saved":
				r.protected = true
			case "preview":
				if v.PreviewExpiresAt == nil || v.PreviewExpiresAt.After(now) {
					r.protected = true
				} else {
					r.category = "expiredPreviews"
				}
			case "delete_pending", "deleted":
				r.category = "expiredPreviews"
			default:
				r.protected = true
			}
		}
		return nil
	}).Error; err != nil {
		return nil, err
	}
	var jobs []model.TTSJob
	if err := db.Select("id, created_at, updated_at, deleted_at, operation, status, resource_id, message_id, message_revision, channel_id").Where("resource_id IN ? OR id IN ?", ids, roots).FindInBatches(&jobs, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		messageIDs := make([]string, 0, len(jobs))
		channelIDs := make([]string, 0, len(jobs))
		for _, j := range jobs {
			channelIDs = append(channelIDs, j.ChannelID)
			if j.MessageID != "" {
				messageIDs = append(messageIDs, j.MessageID)
			}
		}
		worldChannels, err := ttsStorageWorldChannels(db, c, channelIDs)
		if err != nil {
			return err
		}
		var messages []model.MessageModel
		if len(messageIDs) > 0 {
			if err := db.Select(ttsCleanupMessageSelect).Where("id IN ?", messageIDs).Find(&messages).Error; err != nil {
				return err
			}
		}
		byMessage := map[string]*model.MessageModel{}
		for i := range messages {
			byMessage[messages[i].ID] = &messages[i]
		}
		for _, j := range jobs {
			resourceID := j.ResourceID
			if rootIDs, ok := byRoot[j.ID]; ok {
				for _, id := range rootIDs {
					r := refs[id]
					r.rootFound = r.rootFound || j.DeletedAt == nil && resourceID != "" && id == resourceID
					if j.Operation == "system_preview" || ttsJobActive(j.Status) {
						r.protected = true
					} else if id != resourceID {
						// Terminal job history cannot make a discarded archive
						// authoritative, even if another old job reused it.
						r.category = "deletedMessages"
					}
				}
			}
			r := refs[resourceID]
			if r == nil {
				continue
			}
			if j.Operation == "system_preview" || ttsJobActive(j.Status) {
				r.protected = true
			}
			if j.Operation == "audition" {
				lastUse := j.UpdatedAt
				if lastUse.Before(j.CreatedAt) {
					lastUse = j.CreatedAt
				}
				if lastUse.Add(ttsAudioCacheTTL).After(now) {
					r.protected = true
				} else if r.category == "" {
					r.category = "expiredPreviews"
				}
			}
			if j.Operation != "message_synthesis" {
				continue
			}
			w := worldChannels[j.ChannelID]
			r.channelTarget = r.channelTarget || j.ChannelID == c.channel.ID
			r.worldTarget = r.worldTarget || w
			m := byMessage[j.MessageID]
			if m == nil || m.IsDeleted || m.IsRevoked || m.DeletedAt != nil {
				r.category = "deletedMessages"
			} else if data := m.ValidTTS(); int64(m.EditCount) != j.MessageRevision || data == nil || data.Status != "ready" || data.AudioResourceID != resourceID {
				if r.category != "deletedMessages" {
					r.category = "invalidatedMessages"
				}
			}
		}
		return nil
	}).Error; err != nil {
		return nil, err
	}
	for _, r := range refs {
		if !r.rootFound && r.category == "" {
			r.category = "deletedMessages"
		}
	}
	return refs, nil
}

// Build once per operation, after claims for destructive operations. No new
// ready reference can adopt a claimed attachment, so every deletion batch can
// reuse this final scan without weakening the claim/reference ordering.
func ttsMessageReferences(db *gorm.DB, c *ttsStorageContext) (ttsMessageReferenceIndex, error) {
	refs := ttsMessageReferenceIndex{}
	var messages []model.MessageModel
	if err := db.Select(ttsCleanupMessageSelect).Where("tts_data IS NOT NULL AND deleted_at IS NULL AND is_deleted = ? AND (is_revoked = ? OR is_revoked IS NULL)", false, false).FindInBatches(&messages, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		messageIDs := make([]string, 0, len(messages))
		channelIDs := make([]string, 0, len(messages))
		for _, m := range messages {
			if data := m.ValidTTS(); data != nil && data.Status == "ready" && data.AudioResourceID != "" {
				messageIDs = append(messageIDs, m.ID)
				channelIDs = append(channelIDs, m.ChannelID)
			}
		}
		worldChannels, err := ttsStorageWorldChannels(db, c, channelIDs)
		if err != nil {
			return err
		}
		active := map[string]bool{}
		if len(messageIDs) > 0 {
			var jobs []model.TTSJob
			if err := db.Select("id, message_id").Where("message_id IN ? AND deleted_at IS NULL AND status NOT IN ?", messageIDs, ttsTerminalJobStatuses).FindInBatches(&jobs, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
				for _, j := range jobs {
					active[j.MessageID] = true
				}
				return nil
			}).Error; err != nil {
				return err
			}
		}
		for _, m := range messages {
			data := m.ValidTTS()
			if data == nil || data.Status != "ready" || data.AudioResourceID == "" {
				continue
			}
			r := refs[data.AudioResourceID]
			if active[m.ID] || ttsManualSynthesisBlocksRetry(m.TTSStatus) {
				r.protected = true
			}
			w := worldChannels[m.ChannelID]
			ch := m.ChannelID == c.channel.ID
			r.channelLive = r.channelLive || !ch
			r.worldLive = r.worldLive || !w
			if ch {
				r.channelTarget = true
				r.channelMessages++
			}
			if w {
				r.worldTarget = true
				r.worldMessages++
			}
			refs[data.AudioResourceID] = r
		}
		return nil
	}).Error; err != nil {
		return nil, err
	}
	return refs, nil
}

func ttsStorageScan(db *gorm.DB, c *ttsStorageContext, messages ttsMessageReferenceIndex, visit func([]model.AttachmentModel, map[string]*ttsAudioReferences) error) error {
	var attachments []model.AttachmentModel
	return ttsAudioQuery(db).Select("id, root_id, root_id_type, parent_id_type, object_key, storage_type, size, channel_id, extra").Where("channel_id IN (?)", c.channels(db, false)).FindInBatches(&attachments, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		refs, err := ttsInspectAudio(db, c, attachments, time.Now(), messages)
		if err != nil {
			return err
		}
		return visit(attachments, refs)
	}).Error
}

func TTSStorage(actorID, channelID string) (*TTSStorageSummary, error) {
	c, err := ttsStorageAuthorize(actorID, channelID)
	if err != nil {
		return nil, err
	}
	db := model.GetDB()
	messages, err := ttsMessageReferences(db, c)
	if err != nil {
		return nil, err
	}
	s := &TTSStorageSummary{Channel: TTSStorageScope{ID: c.channel.ID, Name: c.channel.Name}, World: TTSStorageScope{ID: c.world.ID, Name: c.world.Name}}
	// Include associations whose attachment metadata has already been lost.
	for _, r := range messages {
		s.Channel.Messages += r.channelMessages
		s.World.Messages += r.worldMessages
	}
	if err := db.Model(&model.ChannelModel{}).Where("id IN (?)", c.channels(db, true)).Count(&s.World.Channels).Error; err != nil {
		return nil, err
	}
	err = ttsStorageScan(db, c, messages, func(attachments []model.AttachmentModel, refs map[string]*ttsAudioReferences) error {
		for _, a := range attachments {
			r := refs[a.ID]
			s.Total.add(a.Size)
			if a.StorageType == model.StorageS3 {
				s.S3.add(a.Size)
			} else {
				s.Local.add(a.Size)
			}
			if !r.protected {
				if r.channelTarget && !r.channelLive {
					s.Channel.Files++
					s.Channel.Bytes += a.Size
				}
				if r.worldTarget && !r.worldLive {
					s.World.Files++
					s.World.Bytes += a.Size
				}
				if r.channelMessages+r.worldMessages == 0 && !r.channelLive && !r.worldLive && r.category != "" {
					s.Reclaimable.Total.add(a.Size)
					switch r.category {
					case "invalidatedMessages":
						s.Reclaimable.InvalidatedMessages.add(a.Size)
					case "deletedMessages":
						s.Reclaimable.DeletedMessages.add(a.Size)
					case "expiredPreviews":
						s.Reclaimable.ExpiredPreviews.add(a.Size)
					}
				}
			}
		}
		return nil
	})
	return s, err
}

func (s TTSCleanupSelection) selected(category string) bool {
	switch category {
	case "invalidatedMessages":
		return s.InvalidatedMessages
	case "deletedMessages":
		return s.DeletedMessages
	case "expiredPreviews":
		return s.ExpiredPreviews
	}
	return false
}

func TTSCleanupStorage(ctx context.Context, actorID string, selection TTSCleanupSelection) (TTSStorageAmount, error) {
	result := TTSStorageAmount{}
	c, err := ttsStorageAuthorize(actorID, selection.ChannelID)
	if err != nil {
		return result, err
	}
	if !selection.InvalidatedMessages && !selection.DeletedMessages && !selection.ExpiredPreviews {
		return result, TTSValidationError("请选择至少一种清理分类")
	}
	db := model.GetDB()
	claimID := ttsAudioCleanupClaim + ":" + utils.NewID()
	defer ttsReleaseAudioClaim(db, claimID)
	// Collect claims before the one global message scan. This preliminary pass
	// may overselect shared resources; the final index always protects them.
	err = ttsStorageScan(db, c, nil, func(attachments []model.AttachmentModel, refs map[string]*ttsAudioReferences) error {
		var candidates []model.AttachmentModel
		for _, a := range attachments {
			r := refs[a.ID]
			if !selection.selected(r.category) || r.protected {
				continue
			}
			candidates = append(candidates, a)
		}
		return ttsClaimAudioBatch(db, candidates, claimID)
	})
	if err != nil {
		return result, err
	}
	return ttsCleanupClaimedAudio(ctx, c, claimID, "", selection)
}

// Claim before the final reference scan. New cached jobs/voice adoption/ready
// publication take the same attachment row lock and refuse a claimed resource.
// The claim survives interrupted I/O and can be retried by a later cleanup.
func ttsClaimAudioBatch(db *gorm.DB, attachments []model.AttachmentModel, claimID string) error {
	if len(attachments) == 0 {
		return nil
	}
	ids := make([]string, 0, len(attachments))
	for _, a := range attachments {
		ids = append(ids, a.ID)
	}
	// A per-request claim prevents two administrators from deleting/counting the
	// same object. Abandoned claims can be retried after the 10s I/O deadline.
	now := time.Now()
	claim := ttsAudioQuery(db).Where("id IN ?", ids).
		Where("COALESCE(extra, '') IN ? OR (extra LIKE ? AND updated_at < ?)", []string{"", ttsAudioCleanupClaim}, ttsAudioCleanupClaim+":%", now.Add(-time.Minute)).
		Updates(map[string]any{"extra": claimID, "updated_at": now})
	return claim.Error
}

func ttsReleaseAudioClaim(db *gorm.DB, claimID string) {
	// Leave an explicit retryable marker on I/O/DB failures, while blocking new
	// references to an object whose deletion outcome may be ambiguous.
	_ = ttsAudioQuery(db).Where("extra = ?", claimID).UpdateColumn("extra", ttsAudioCleanupClaim).Error
}

func ttsCleanupClaimedAudio(ctx context.Context, c *ttsStorageContext, claimID, scope string, selection TTSCleanupSelection) (TTSStorageAmount, error) {
	result := TTSStorageAmount{}
	db := model.GetDB()
	messages, err := ttsMessageReferences(db, c)
	if err != nil {
		return result, err
	}
	var attachments []model.AttachmentModel
	err = ttsAudioQuery(db).Where("extra = ?", claimID).FindInBatches(&attachments, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		deleted, err := ttsCleanupAudioBatch(ctx, c, attachments, claimID, scope, selection, messages)
		result.Files += deleted.Files
		result.Bytes += deleted.Bytes
		return err
	}).Error
	return result, err
}

func ttsCleanupAudioBatch(ctx context.Context, c *ttsStorageContext, attachments []model.AttachmentModel, claimID, scope string, selection TTSCleanupSelection, messages ttsMessageReferenceIndex) (TTSStorageAmount, error) {
	result := TTSStorageAmount{}
	db := model.GetDB()
	refs, err := ttsInspectAudio(db, c, attachments, time.Now(), messages)
	if err != nil {
		return result, err
	}
	for _, a := range attachments {
		r := refs[a.ID]
		allowed := !r.protected
		switch scope {
		case "channel":
			allowed = allowed && !r.channelLive && r.channelMessages == 0
		case "world":
			allowed = allowed && !r.worldLive && r.worldMessages == 0
		default:
			allowed = allowed && selection.selected(r.category) && r.channelMessages+r.worldMessages == 0 && !r.channelLive && !r.worldLive
		}
		if !allowed {
			if err := ttsAudioQuery(db).Where("id = ? AND extra = ?", a.ID, claimID).UpdateColumn("extra", "").Error; err != nil {
				return result, err
			}
			continue
		}
		// Refresh this object's lease just before I/O; a long batch must not
		// retain ownership of a claim already recovered by another request.
		lease := ttsAudioQuery(db).Where("id = ? AND extra = ?", a.ID, claimID).UpdateColumn("updated_at", time.Now())
		if lease.Error != nil {
			return result, lease.Error
		}
		if lease.RowsAffected != 1 {
			continue
		}
		deleted, err := ttsDeleteJobAudio(ctx, &a)
		if err != nil {
			return result, err
		}
		if deleted {
			result.add(a.Size)
		}
	}
	return result, nil
}

var ttsTerminalJobStatuses = []string{"succeeded", "failed", "cancelled", "skipped", "unavailable", "invalidated"}

func TTSPurgeStorage(ctx context.Context, actorID string, request TTSStoragePurgeRequest) (TTSPurgeResult, error) {
	result := TTSPurgeResult{}
	if request.Scope != "channel" && request.Scope != "world" {
		return result, TTSValidationError("scope 只支持 channel/world")
	}
	c, err := ttsStorageAuthorize(actorID, request.ChannelID)
	if err != nil {
		return result, err
	}
	db := model.GetDB()
	claimID := ttsAudioCleanupClaim + ":" + utils.NewID()
	defer ttsReleaseAudioClaim(db, claimID)
	// Detach in bounded batches before the final reference index, including
	// missing audio and resources originating outside this world. The IDs come
	// only from server-scoped messages, never a client-provided deletion list.
	var messages []model.MessageModel
	q := db.Select(ttsCleanupMessageSelect + ", tts_intent").Where("deleted_at IS NULL AND tts_data IS NOT NULL")
	if request.Scope == "channel" {
		q = q.Where("channel_id = ?", c.channel.ID)
	} else {
		q = q.Where("channel_id IN (?)", c.channels(db, true))
	}
	err = q.FindInBatches(&messages, ttsCleanupBatchSize, func(_ *gorm.DB, _ int) error {
		resourceIDs := make([]string, 0, len(messages))
		for _, m := range messages {
			if m.TTSData == nil || m.TTSData.AudioResourceID == "" || ttsManualSynthesisBlocksRetry(m.TTSStatus) {
				continue
			}
			changed, err := ttsInvalidateStoredMessage(db, m)
			if err != nil {
				return err
			}
			result.Messages += changed
			if changed > 0 {
				resourceIDs = append(resourceIDs, m.TTSData.AudioResourceID)
			}
		}
		if len(resourceIDs) == 0 {
			return nil
		}
		var attachments []model.AttachmentModel
		if err := ttsAudioQuery(db).Where("id IN ?", resourceIDs).Find(&attachments).Error; err != nil {
			return err
		}
		return ttsClaimAudioBatch(db, attachments, claimID)
	}).Error
	if err != nil {
		return result, err
	}
	err = ttsStorageScan(db, c, nil, func(attachments []model.AttachmentModel, refs map[string]*ttsAudioReferences) error {
		var candidates []model.AttachmentModel
		for _, a := range attachments {
			r := refs[a.ID]
			if request.Scope == "channel" && r.channelTarget || request.Scope == "world" && r.worldTarget {
				candidates = append(candidates, a)
			}
		}
		return ttsClaimAudioBatch(db, candidates, claimID)
	})
	if err != nil {
		return result, err
	}
	deleted, err := ttsCleanupClaimedAudio(ctx, c, claimID, request.Scope, TTSCleanupSelection{})
	result.Files, result.Bytes = deleted.Files, deleted.Bytes
	return result, err
}

func ttsInvalidateStoredMessage(db *gorm.DB, m model.MessageModel) (int64, error) {
	// A queued job may not have published its state yet. Keep this predicate in
	// the CAS itself so no in-flight intent can be erased by the cleanup scan.
	raw, err := json.Marshal(m.TTSData)
	if err != nil {
		return 0, err
	}
	r := db.Model(&model.MessageModel{}).Where("id = ? AND edit_count = ? AND tts_data = ? AND COALESCE(tts_status, '') = ? AND COALESCE(tts_intent, '') = ?", m.ID, m.EditCount, string(raw), m.TTSStatus, m.TTSIntent).
		Where("NOT EXISTS (?)", db.Model(&model.TTSJob{}).Select("1").Where("message_id = ? AND deleted_at IS NULL AND status NOT IN ?", m.ID, ttsTerminalJobStatuses)).
		Updates(map[string]any{"tts_data": nil, "tts_status": "invalidated", "tts_intent": ""})
	return r.RowsAffected, r.Error
}

func ttsLockJobAudio(tx *gorm.DB, resourceID string) error {
	r := ttsAudioQuery(tx).Where("id = ? AND COALESCE(extra, '') NOT LIKE ?", resourceID, ttsAudioCleanupClaim+"%").UpdateColumn("updated_at", time.Now())
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return ErrTTSConflict
	}
	return nil
}
