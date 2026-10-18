package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"

	"sealchat/model"
	"sealchat/pkg/ttsprovider"
	"sealchat/service/storage"
	"sealchat/utils"
)

func TTSSpoolDir() (string, error) {
	m := GetStorageManager()
	if m == nil {
		return "", fmt.Errorf("存储尚未初始化")
	}
	p, err := m.ResolveLocalPath("tts-private/spool")
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(p, 0700); err != nil {
		return "", err
	}
	return p, nil
}

func TTSPersistAudio(userID, channelID, jobID, kind, path string, media ttsprovider.Media) (*model.AttachmentModel, error) {
	m := GetStorageManager()
	if m == nil {
		return nil, fmt.Errorf("存储尚未初始化")
	}
	// Copies keep the validated spool intact if moving/uploading or DB persistence
	// fails. The caller may retry storage without another synthesis request.
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dir, err := TTSSpoolDir()
	if err != nil {
		return nil, err
	}
	copyFile, err := os.CreateTemp(dir, "archive-*")
	if err != nil {
		return nil, err
	}
	copyPath := copyFile.Name()
	defer os.Remove(copyPath)
	if _, err = copyFile.Write(b); err != nil {
		copyFile.Close()
		return nil, err
	}
	if err = copyFile.Close(); err != nil {
		return nil, err
	}
	id := utils.NewID()
	key := "tts-private/resources/" + id
	ctx := context.Background()
	input := storage.UploadInput{ObjectKey: key, LocalPath: copyPath, ContentType: ttsMIME(media.Container)}
	var result *storage.UploadResult
	switch kind {
	case "job_audio":
		result, err = m.UploadTTS(ctx, input)
	case "clone_source":
		// Clone enrollment is a transport concern: if any configured S3 backend
		// is healthy, prefer it even when the general/TTS storage target is local.
		// This gives the provider a chance to fetch a short-lived presigned URL.
		if m.HasRemote() {
			result, err = m.UploadToS3(ctx, input)
		}
		if result == nil || err != nil {
			result, err = m.UploadWithBackend(ctx, storage.BackendLocal, input)
		}
	default:
		result, err = m.UploadWithBackend(ctx, storage.BackendLocal, input)
	}
	if err != nil {
		return nil, err
	}
	meta, _ := json.Marshal(media)
	storageType := model.StorageLocal
	if result.Backend == storage.BackendS3 {
		storageType = model.StorageS3
	}
	a := &model.AttachmentModel{StringPKBaseModel: model.StringPKBaseModel{ID: id}, UserID: userID, ChannelID: channelID, RootIDType: "tts", RootID: jobID, ParentIDType: kind, StorageType: storageType, ObjectKey: result.ObjectKey, Size: int64(len(b)), MimeType: ttsMIME(media.Container), Filename: "speech." + media.Container, Note: string(meta)}
	if err = model.GetDB().Create(a).Error; err != nil {
		// This object was created by this attempt and has no durable reference.
		// Remove the actual stored object; preserve the synthesis spool for retry.
		_ = m.Delete(ctx, result.Backend, result.ObjectKey)
		return nil, err
	}
	return a, nil
}
func ttsMIME(format string) string {
	switch format {
	case "wav":
		return "audio/wav"
	case "mp3":
		return "audio/mpeg"
	default:
		return "application/octet-stream"
	}
}
func TTSResourcePath(a *model.AttachmentModel) (string, error) {
	if a == nil || !a.IsTTSManaged() || a.DeletedAt != nil || a.StorageType != model.StorageLocal || !strings.HasPrefix(a.ObjectKey, "tts-private/resources/") {
		return "", ErrTTSDenied
	}
	manager := GetStorageManager()
	if manager == nil {
		return "", ErrTTSDisabled
	}
	return manager.ResolveLocalPath(a.ObjectKey)
}
func TTSValidateSpool(path string) bool {
	dir, err := TTSSpoolDir()
	return err == nil && filepath.Dir(path) == dir && strings.HasPrefix(filepath.Base(path), "synthesis-")
}

func ttsResourceBackend(a *model.AttachmentModel) (storage.BackendType, error) {
	if a == nil || !a.IsTTSManaged() || a.DeletedAt != nil || !strings.HasPrefix(a.ObjectKey, "tts-private/resources/") {
		return "", ErrTTSDenied
	}
	switch a.StorageType {
	case model.StorageLocal:
		return storage.BackendLocal, nil
	case model.StorageS3:
		return storage.BackendS3, nil
	default:
		return "", ErrTTSDenied
	}
}

// Delete only archived job audio. Clone samples, spool and regular attachments
// are outside this helper's authority. No database transaction spans storage I/O.
func ttsDeleteJobAudio(ctx context.Context, a *model.AttachmentModel) (bool, error) {
	if a == nil || !a.IsTTSManaged() || a.RootIDType != "tts" || a.ParentIDType != "job_audio" || !strings.HasPrefix(a.ObjectKey, "tts-private/resources/") || path.Clean(a.ObjectKey) != a.ObjectKey || strings.Contains(a.ObjectKey, `\`) {
		return false, ErrTTSDenied
	}
	backend, err := ttsResourceBackend(a)
	if err != nil {
		return false, err
	}
	m := GetStorageManager()
	if m == nil || backend == storage.BackendS3 && !m.HasRemote() {
		return false, ErrTTSDisabled
	}
	deleteCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := m.Delete(deleteCtx, backend, a.ObjectKey); err != nil {
		return false, err
	}
	var deleted bool
	err = model.GetDB().Transaction(func(tx *gorm.DB) error {
		r := tx.Model(&model.AttachmentModel{}).Where("id = ? AND deleted_at IS NULL AND root_id_type = ? AND parent_id_type = ?", a.ID, "tts", "job_audio").UpdateColumn("deleted_at", time.Now())
		if r.Error != nil {
			return r.Error
		}
		deleted = r.RowsAffected == 1
		return tx.Where("resource_id = ?", a.ID).Delete(&model.TTSCache{}).Error
	})
	return deleted && err == nil, err
}

func TTSResourceExists(ctx context.Context, a *model.AttachmentModel) (bool, error) {
	backend, err := ttsResourceBackend(a)
	if err != nil {
		return false, err
	}
	m := GetStorageManager()
	if m == nil {
		return false, ErrTTSDisabled
	}
	return m.Exists(ctx, backend, a.ObjectKey)
}

// TTSOpenResource is used only after ticket/resource authorization.
func TTSOpenResource(ctx context.Context, a *model.AttachmentModel) (io.ReadCloser, error) {
	backend, err := ttsResourceBackend(a)
	if err != nil {
		return nil, err
	}
	m := GetStorageManager()
	if m == nil {
		return nil, ErrTTSDisabled
	}
	return m.OpenRead(ctx, backend, a.ObjectKey)
}

const ttsCloneSourceCleanupClaim = "tts-clone-source-cleanup"

func ttsLockCloneSource(tx *gorm.DB, sourceID, userID string, now time.Time) error {
	if tx == nil || sourceID == "" || userID == "" {
		return ErrTTSDenied
	}
	r := tx.Model(&model.AttachmentModel{}).
		Where("id = ? AND user_id = ? AND root_id_type = ? AND parent_id_type = ? AND deleted_at IS NULL AND COALESCE(extra, '') <> ?", sourceID, userID, "tts", "clone_source", ttsCloneSourceCleanupClaim).
		UpdateColumn("updated_at", now)
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return ErrTTSDenied
	}
	return nil
}

// Cleanup is best effort after a durable terminal voice transition. Keep the
// provenance ID on the voice, and retain samples needed by other clone attempts.
// A durable attachment claim blocks new reservations without holding a database
// transaction across S3/local I/O; failed or interrupted cleanup can be retried.
func ttsCleanupCloneSource(ctx context.Context, sourceID string) error {
	if sourceID == "" {
		return nil
	}
	db := model.GetDB()
	claimed := db.Model(&model.AttachmentModel{}).
		Where("id = ? AND root_id_type = ? AND parent_id_type = ? AND deleted_at IS NULL AND COALESCE(extra, '') IN ?", sourceID, "tts", "clone_source", []string{"", ttsCloneSourceCleanupClaim}).
		Updates(map[string]any{"extra": ttsCloneSourceCleanupClaim, "updated_at": time.Now()})
	if claimed.Error != nil {
		return claimed.Error
	}
	if claimed.RowsAffected == 0 {
		return nil
	}

	var a model.AttachmentModel
	if err := db.Where("id = ? AND root_id_type = ? AND parent_id_type = ? AND deleted_at IS NULL AND extra = ?", sourceID, "tts", "clone_source", ttsCloneSourceCleanupClaim).First(&a).Error; err != nil {
		return err
	}
	var refs int64
	if err := db.Model(&model.TTSVoice{}).Where("kind = ? AND source_resource_id = ? AND (lifecycle = ? OR (lifecycle = ? AND provider_voice_id <> ?))", "clone", sourceID, "creating", "delete_pending", "").Count(&refs).Error; err != nil {
		return err
	}
	if refs != 0 {
		return db.Model(&model.AttachmentModel{}).
			Where("id = ? AND deleted_at IS NULL AND extra = ?", sourceID, ttsCloneSourceCleanupClaim).
			UpdateColumn("extra", "").Error
	}

	backend, err := ttsResourceBackend(&a)
	if err != nil {
		return err
	}
	m := GetStorageManager()
	// Keep the claim on retryable failures so a new clone cannot acquire a source
	// whose terminal cleanup has already begun.
	if m == nil || (backend == storage.BackendS3 && !m.HasRemote()) {
		return ErrTTSDisabled
	}
	deleteCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := m.Delete(deleteCtx, backend, a.ObjectKey); err != nil {
		return err
	}
	retired := db.Model(&model.AttachmentModel{}).
		Where("id = ? AND root_id_type = ? AND parent_id_type = ? AND deleted_at IS NULL AND extra = ?", a.ID, "tts", "clone_source", ttsCloneSourceCleanupClaim).
		UpdateColumn("deleted_at", time.Now())
	if retired.Error != nil {
		return retired.Error
	}
	return nil
}

func ttsRetryCloneSourceCleanup(ctx context.Context, db *gorm.DB) {
	if db == nil {
		return
	}
	var sourceIDs []string
	err := db.Table("attachments AS a").
		Select("DISTINCT a.id").
		Joins("LEFT JOIN tts_voices AS v ON v.source_resource_id = a.id AND v.kind = ?", "clone").
		Where("a.deleted_at IS NULL AND a.root_id_type = ? AND a.parent_id_type = ?", "tts", "clone_source").
		Where("a.extra = ? OR ((v.lifecycle IN ? AND v.provider_status IN ?) OR v.lifecycle = ?)", ttsCloneSourceCleanupClaim, []string{"preview", "saved"}, []string{"OK", "UNDEPLOYED"}, "deleted").
		Order("a.updated_at ASC, a.id ASC").
		Limit(4).
		Pluck("a.id", &sourceIDs).Error
	if err != nil {
		return
	}
	for _, sourceID := range sourceIDs {
		_ = ttsCleanupCloneSource(ctx, sourceID)
	}
}

func ttsCleanupCloneJobSource(job *model.TTSJob) {
	if job == nil || job.Operation != "clone" {
		return
	}
	var snapshot TTSSnapshot
	if json.Unmarshal([]byte(job.Snapshot), &snapshot) == nil {
		_ = ttsCleanupCloneSource(context.Background(), snapshot.SourceResourceID)
	}
}
