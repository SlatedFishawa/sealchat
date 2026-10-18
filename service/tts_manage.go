package service

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"sealchat/model"
	"sealchat/pkg/ttsprovider"
	aiService "sealchat/service/ai"
	"sealchat/service/storage"
	"sealchat/utils"
)

type TTSTicket struct {
	UserID     string
	ResourceID string
	MessageID  string
	ChannelID  string
	Purpose    string
	Expires    time.Time
}

var ttsTickets = struct {
	sync.Mutex
	values map[string]TTSTicket
}{values: map[string]TTSTicket{}}

func TTSIssueTicket(t TTSTicket) (string, error) {
	ttsTickets.Lock()
	defer ttsTickets.Unlock()
	now := time.Now()
	count := 0
	for k, v := range ttsTickets.values {
		if now.After(v.Expires) {
			delete(ttsTickets.values, k)
		} else if v.UserID == t.UserID {
			count++
		}
	}
	if count >= 64 || len(ttsTickets.values) >= 4096 {
		return "", TTSValidationError("播放授权请求过多")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	key := hex.EncodeToString(b)
	ttsTickets.values[key] = t
	return key, nil
}
func TTSReadTicket(key string, consume bool) (TTSTicket, bool) {
	ttsTickets.Lock()
	defer ttsTickets.Unlock()
	t, ok := ttsTickets.values[key]
	if !ok || time.Now().After(t.Expires) {
		delete(ttsTickets.values, key)
		return TTSTicket{}, false
	}
	if consume {
		delete(ttsTickets.values, key)
	}
	return t, true
}
func ttsCloneSourceToken(jobID, reservationID string, expires int64) string {
	return ttsHash("tts-clone-source:v1:" + jobID + ":" + reservationID + ":" + strconv.FormatInt(expires, 10))
}

func ttsCloneSourceAttachment(job *model.TTSJob) (*model.AttachmentModel, error) {
	if job == nil || job.ID == "" || job.Operation != "clone" || job.PayerUserID == "" || job.ReservationID == "" || job.DeletedAt != nil {
		return nil, ErrTTSDenied
	}
	var snapshot TTSSnapshot
	if json.Unmarshal([]byte(job.Snapshot), &snapshot) != nil || snapshot.SourceResourceID == "" {
		return nil, ErrTTSDenied
	}
	var a model.AttachmentModel
	if model.GetDB().Where("id = ? AND user_id = ? AND root_id_type = ? AND parent_id_type = ? AND deleted_at IS NULL AND COALESCE(extra, '') <> ?", snapshot.SourceResourceID, job.PayerUserID, "tts", "clone_source", ttsCloneSourceCleanupClaim).First(&a).Error != nil {
		return nil, ErrTTSDenied
	}
	return &a, nil
}

func ttsClonePublicBaseURL() (*url.URL, error) {
	cfg := utils.GetConfig()
	if cfg == nil {
		return nil, TTSValidationError("声音复刻需要配置可公网访问的 HTTPS Domain")
	}
	base, err := url.Parse(utils.PrimaryDomain(cfg.Domain))
	if err != nil || base.Scheme != "https" || base.Host == "" || base.Hostname() == "" || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return nil, TTSValidationError("声音复刻需要配置可公网访问的 HTTPS Domain")
	}
	base.Path = strings.TrimRight(base.Path, "/")
	webRoot := strings.Trim(cfg.WebUrl, "/")
	if webRoot != "" {
		base.Path += "/" + webRoot
	}
	return base, nil
}

func ttsCloneProxyBaseURL(source *model.AttachmentModel) (*url.URL, error) {
	base, err := ttsClonePublicBaseURL()
	if err == nil {
		return base, nil
	}
	if source != nil && source.StorageType == model.StorageS3 {
		return nil, TTSValidationError("声音复刻的 S3 样本无法生成公网 HTTPS 临时地址，请检查 S3 Endpoint/SSL；或配置可公网访问的 HTTPS Domain")
	}
	if source != nil && source.StorageType == model.StorageLocal {
		if m := GetStorageManager(); m != nil && m.HasRemote() {
			return nil, TTSValidationError("声音复刻样本当前实际存于本地（S3 未使用或上传已回退）；请检查 S3 配置/上传，或配置可公网访问的 HTTPS Domain")
		}
	}
	return nil, err
}

func TTSCloneReadURL(job *model.TTSJob) (string, error) {
	a, err := ttsCloneSourceAttachment(job)
	if err != nil {
		return "", err
	}
	if signed := ttsClonePresignedURL(context.Background(), a); signed != "" {
		return signed, nil
	}
	base, err := ttsCloneProxyBaseURL(a)
	if err != nil {
		return "", err
	}
	base.Path += "/api/v1/tts/clone-source/" + job.ID
	base.RawPath = ""
	expires := time.Now().Add(5 * time.Minute).Unix()
	base.RawQuery = url.Values{
		"expires": {strconv.FormatInt(expires, 10)},
		"token":   {ttsCloneSourceToken(job.ID, job.ReservationID, expires)},
	}.Encode()
	return base.String(), nil
}

func ttsClonePresignedURL(ctx context.Context, a *model.AttachmentModel) string {
	if a == nil || a.StorageType != model.StorageS3 {
		return ""
	}
	if backend, err := ttsResourceBackend(a); err != nil || backend != storage.BackendS3 {
		return ""
	}
	m := GetStorageManager()
	if m == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	signed := m.PresignedURL(ctx, storage.BackendS3, a.ObjectKey)
	u, err := url.Parse(signed)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return ""
	}
	return signed
}

// Authorization is database-backed; serving local TTS files across instances
// still requires a shared filesystem or routing to an instance with the file.
func TTSResolveCloneSource(jobID, expiresRaw, token string) (*model.AttachmentModel, error) {
	if jobID == "" || expiresRaw == "" || token == "" {
		return nil, ErrTTSDenied
	}
	expires, err := strconv.ParseInt(expiresRaw, 10, 64)
	if err != nil || !time.Now().Before(time.Unix(expires, 0)) {
		return nil, ErrTTSDenied
	}
	var job model.TTSJob
	if model.GetDB().Where("id = ? AND deleted_at IS NULL", jobID).First(&job).Error != nil || job.Operation != "clone" || job.PayerUserID == "" || job.ReservationID == "" {
		return nil, ErrTTSDenied
	}
	expected := ttsCloneSourceToken(job.ID, job.ReservationID, expires)
	if subtle.ConstantTimeCompare([]byte(token), []byte(expected)) != 1 {
		return nil, ErrTTSDenied
	}
	return ttsCloneSourceAttachment(&job)
}

func ttsProviderVoiceNotFound(err error) bool {
	var providerErr *ttsprovider.ProviderError
	return errors.As(err, &providerErr) && strings.EqualFold(strings.TrimSpace(providerErr.Code), "BadRequest.VoiceNotFound")
}

func ttsReconcileVoice(parent context.Context, db *gorm.DB, speech *utils.SpeechConfig, v model.TTSVoice, forceDelete bool) error {
	if db == nil || speech == nil {
		return ErrTTSDisabled
	}
	if v.ProviderVoiceID == "" {
		if v.Lifecycle != "delete_pending" {
			return nil
		}
		var refs int64
		if err := db.Model(&model.TTSJob{}).Where("voice_id = ? AND status IN ?", v.ID, []string{"queued", "running", "usage_unknown"}).Count(&refs).Error; err != nil {
			return err
		}
		if refs != 0 {
			return nil
		}
		r := db.Model(&model.TTSVoice{}).Where("id = ? AND lifecycle = ?", v.ID, "delete_pending").Updates(map[string]any{"lifecycle": "deleted", "deleted_at": time.Now()})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected == 1 && v.Kind == "clone" {
			_ = ttsCleanupCloneSource(parent, v.SourceResourceID)
		}
		return nil
	}

	var provider *utils.SpeechProviderConfig
	for _, p := range speech.Providers {
		if p.ID == v.ProviderID && p.CredentialScope == v.CredentialScope && p.Region == v.Region && p.Workspace == v.Workspace {
			cp := p
			provider = &cp
			break
		}
	}
	if provider == nil {
		return TTSValidationError("音色对应的供应商配置已不可用")
	}

	cleanupSourceID := ""
	if v.Lifecycle == "delete_pending" {
		var refs int64
		if err := db.Model(&model.TTSJob{}).Where("voice_id = ? AND status IN ?", v.ID, []string{"queued", "running", "usage_unknown"}).Count(&refs).Error; err != nil {
			return err
		}
		if refs != 0 {
			return nil
		}

		readyToDelete := true
		remoteGone := false
		if v.ProviderStatus == "DEPLOYING" {
			queryCtx, cancel := context.WithTimeout(parent, 10*time.Second)
			queried, queryErr := ttsProviderQueryVoice(queryCtx, *provider, v.ProviderVoiceID)
			cancel()
			readyToDelete = false
			if ttsProviderVoiceNotFound(queryErr) {
				remoteGone = true
			} else if queryErr != nil {
				return queryErr
			} else if queried.Output.TargetModel == v.TargetModel {
				status := queried.Output.Status
				if status != "" {
					if err := db.Model(&model.TTSVoice{}).Where("id = ? AND lifecycle = ?", v.ID, "delete_pending").UpdateColumn("provider_status", status).Error; err != nil {
						return err
					}
				}
				readyToDelete = forceDelete || status == "OK" || status == "UNDEPLOYED"
			}
		}
		if readyToDelete && !remoteGone {
			deleteCtx, cancel := context.WithTimeout(parent, 10*time.Second)
			_, deleteErr := ttsProviderDeleteVoice(deleteCtx, *provider, v.ProviderVoiceID)
			cancel()
			if deleteErr != nil && !ttsProviderVoiceNotFound(deleteErr) {
				if forceDelete {
					var providerErr *ttsprovider.ProviderError
					if errors.As(deleteErr, &providerErr) && strings.TrimSpace(providerErr.Code) != "" {
						return TTSValidationError("供应商暂时拒绝删除此音色（" + providerErr.Code + "），请稍后重试")
					}
					return TTSValidationError("供应商暂时拒绝删除此音色，请稍后重试")
				}
				return deleteErr
			}
			remoteGone = true
		}
		if remoteGone {
			r := db.Model(&model.TTSVoice{}).Where("id = ? AND lifecycle = ?", v.ID, "delete_pending").Updates(map[string]any{"lifecycle": "deleted", "deleted_at": time.Now()})
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected == 1 && v.Kind == "clone" {
				cleanupSourceID = v.SourceResourceID
			}
		}
	} else if v.ProviderStatus != "OK" {
		ctx, cancel := context.WithTimeout(parent, 10*time.Second)
		r, err := ttsProviderQueryVoice(ctx, *provider, v.ProviderVoiceID)
		cancel()
		if err != nil {
			return err
		}
		if r.Output.TargetModel != v.TargetModel {
			return ErrTTSConflict
		}
		updates := map[string]any{"provider_status": r.Output.Status}
		if r.Output.Status == "OK" || r.Output.Status == "UNDEPLOYED" {
			updates["lifecycle"] = "preview"
		}
		updated := db.Model(&model.TTSVoice{}).Where("id = ? AND lifecycle IN ?", v.ID, []string{"creating", "preview"}).Updates(updates)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected == 1 && v.Kind == "clone" && (r.Output.Status == "OK" || r.Output.Status == "UNDEPLOYED") {
			cleanupSourceID = v.SourceResourceID
		}
	}
	if cleanupSourceID != "" {
		_ = ttsCleanupCloneSource(parent, cleanupSourceID)
	}
	return nil
}

func TTSRefreshVoice(parent context.Context, userID, voiceID string) error {
	if userID == "" || voiceID == "" {
		return ErrTTSDenied
	}
	db := model.GetDB()
	var voice model.TTSVoice
	if err := db.Where("id = ? AND owner_user_id = ? AND deleted_at IS NULL", voiceID, userID).First(&voice).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrTTSDenied
		}
		return err
	}
	cfg := utils.GetConfig()
	if cfg == nil || cfg.AI.Speech == nil {
		return ErrTTSDisabled
	}
	return ttsReconcileVoice(parent, db, cfg.AI.Speech, voice, true)
}

var ttsMaintenanceAt time.Time

func ttsMaintainVoices(parent context.Context) {
	if time.Since(ttsMaintenanceAt) < 15*time.Second {
		return
	}
	ttsMaintenanceAt = time.Now()
	db := model.GetDB()
	defer ttsRetryCloneSourceCleanup(parent, db)
	cfg := utils.GetConfig()
	if cfg == nil || cfg.AI.Speech == nil {
		return
	}
	// Cache eligibility is temporary; jobs/messages keep their own file refs.
	_ = db.Where("expires_at <= ?", time.Now()).Delete(&model.TTSCache{}).Error
	var voices []model.TTSVoice
	if db.Where("deleted_at IS NULL AND (lifecycle = ? OR (lifecycle IN ? AND (provider_status <> ? OR preview_expires_at <= ?)))", "delete_pending", []string{"creating", "preview"}, "OK", time.Now()).Order("updated_at ASC, id ASC").Limit(20).Find(&voices).Error != nil {
		return
	}
	for _, v := range voices {
		// Failed cloud queries/deletions must not starve later rows forever.
		_ = db.Model(&model.TTSVoice{}).Where("id = ? AND lifecycle = ?", v.ID, v.Lifecycle).UpdateColumn("updated_at", time.Now()).Error
		if v.PreviewExpiresAt != nil && !time.Now().Before(*v.PreviewExpiresAt) && v.Lifecycle != "delete_pending" {
			_ = TTSExpirePreviews(db, v.OwnerUserID, time.Now())
			continue
		}
		_ = ttsReconcileVoice(parent, db, cfg.AI.Speech, v, false)
	}
}

type TTSQuota struct {
	WorldAccess      *TTSWorldAccess               `json:"worldAccess,omitempty"`
	Enabled          bool                          `json:"enabled"`
	AutoSynthesis    bool                          `json:"autoSynthesis"`
	Policy           utils.AIQuotaPolicyConfig     `json:"policy"`
	Usage            *aiService.QuotaUsageSnapshot `json:"usage"`
	Saved            int64                         `json:"saved"`
	Slots            int                           `json:"slots"`
	Format           string                        `json:"format"`
	CharacterPrice   *float64                      `json:"characterPrice"`
	PricingMode      string                        `json:"pricingMode"`
	InputTokenPrice  *float64                      `json:"inputTokenPrice"`
	OutputTokenPrice *float64                      `json:"outputTokenPrice"`
	DesignPrice      *float64                      `json:"designPrice"`
	ClonePrice       *float64                      `json:"clonePrice"`
	DefaultModel     string                        `json:"defaultModel"`
	VoiceContext     TTSVoiceContext               `json:"voiceContext"`
	VoiceContexts    []TTSVoiceContext             `json:"voiceContexts"`
	DefaultVoice     string                        `json:"defaultVoice"`
}

type TTSVoiceContext struct {
	ProviderKind string `json:"providerKind"`
	ProviderID   string `json:"providerId"`
	ModelID      string `json:"modelId"`
}

func TTSQuotaForUser(userID string) (TTSQuota, error) {
	q := TTSQuota{AutoSynthesis: TTSAutomaticEnabled(userID), VoiceContexts: []TTSVoiceContext{}}
	cfg := utils.GetConfig()
	var speech *utils.SpeechConfig
	if cfg != nil {
		speech = utils.NormalizeSpeechConfig(cfg.AI.Speech)
		q.Enabled = cfg.AI.Enabled && speech != nil && speech.Enabled
	}
	if speech != nil {
		q.Policy = speech.QuotaDefault
		q.Slots = speech.DefaultSlots
		q.Format = speech.Format
		q.DefaultVoice = speech.DefaultVoice
		for _, p := range speech.Providers {
			if spec, ok := ttsprovider.LookupModel(p.EffectiveProviderKind(), p.Model); p.Enabled && p.CredentialsReady() && ok && (spec.Capabilities.HTTPStreaming || spec.Capabilities.WebSocketStreaming) && p.SynthesisPriceConfirmed() {
				q.VoiceContexts = append(q.VoiceContexts, TTSVoiceContext{ProviderKind: p.EffectiveProviderKind(), ProviderID: p.ID, ModelID: p.Model})
			}
			if p.ID == speech.DefaultProvider {
				q.VoiceContext = TTSVoiceContext{ProviderKind: p.EffectiveProviderKind(), ProviderID: p.ID, ModelID: p.Model}
				q.DefaultModel = p.Model
				q.CharacterPrice = p.CharacterPrice
				q.PricingMode = p.EffectivePricingMode()
				q.InputTokenPrice, q.OutputTokenPrice = p.InputTokenPrice, p.OutputTokenPrice
				q.DesignPrice = p.DesignPrice
				q.ClonePrice = p.ClonePrice
			}
		}
	}
	var p model.TTSUserPolicy
	err := model.GetDB().Where("user_id = ? AND deleted_at IS NULL", userID).First(&p).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return q, err
	}
	if p.OverrideEnabled {
		q.Policy = utils.AIQuotaPolicyConfig{DailyLimit: p.DailyLimit, MonthlyLimit: p.MonthlyLimit, LifetimeLimit: p.LifetimeLimit}
	}
	if p.Slots != nil {
		q.Slots = *p.Slots
	}
	q.Usage, err = aiService.QueryQuotaUsageSnapshotForKind(model.GetDB(), model.QuotaKindSpeech, userID, time.Now())
	if err != nil {
		return q, err
	}
	err = model.GetDB().Model(&model.TTSVoice{}).Where("owner_user_id = ? AND lifecycle = ? AND deleted_at IS NULL", userID, "saved").Count(&q.Saved).Error
	return q, err
}

type sharedChannelIdentityTTSConfig struct {
	Disabled              bool    `json:"disabled"`
	VoiceID               string  `json:"voiceId"`
	SystemVoice           string  `json:"systemVoice"`
	SystemVoiceProvider   string  `json:"systemVoiceProvider"`
	SystemVoiceProviderID string  `json:"systemVoiceProviderId"`
	SystemVoiceModel      string  `json:"systemVoiceModel"`
	SpeechLanguage        string  `json:"speechLanguage"`
	Instruction           string  `json:"instruction"`
	Rate                  float64 `json:"rate"`
	Pitch                 float64 `json:"pitch"`
	Volume                int     `json:"volume"`
	Revision              int64   `json:"revision"`
}

func defaultChannelIdentityTTSConfig(identityID string) *model.ChannelIdentityTTSConfig {
	return &model.ChannelIdentityTTSConfig{IdentityID: identityID, Rate: 1, Pitch: 1, Volume: 50}
}

func sharedChannelIdentityTTSConfigFromData(raw, identityID string) (*model.ChannelIdentityTTSConfig, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, false, nil
	}
	document := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return nil, false, err
	}
	ttsRaw, ok := document["tts"]
	if !ok || len(ttsRaw) == 0 || string(ttsRaw) == "null" {
		return nil, false, nil
	}
	var shared sharedChannelIdentityTTSConfig
	if err := json.Unmarshal(ttsRaw, &shared); err != nil {
		return nil, false, err
	}
	return &model.ChannelIdentityTTSConfig{
		IdentityID:            identityID,
		Disabled:              shared.Disabled,
		VoiceID:               shared.VoiceID,
		SystemVoice:           shared.SystemVoice,
		SystemVoiceProvider:   shared.SystemVoiceProvider,
		SystemVoiceProviderID: shared.SystemVoiceProviderID,
		SystemVoiceModel:      shared.SystemVoiceModel,
		SpeechLanguage:        shared.SpeechLanguage,
		Instruction:           shared.Instruction,
		Rate:                  shared.Rate,
		Pitch:                 shared.Pitch,
		Volume:                shared.Volume,
		Revision:              shared.Revision,
	}, true, nil
}

func sharedChannelIdentityTTSData(previous string, role model.ChannelIdentityTTSConfig) (string, error) {
	document := map[string]json.RawMessage{}
	if strings.TrimSpace(previous) != "" {
		if err := json.Unmarshal([]byte(previous), &document); err != nil {
			return "", err
		}
	}
	shared := sharedChannelIdentityTTSConfig{
		Disabled: role.Disabled, VoiceID: role.VoiceID, SystemVoice: role.SystemVoice,
		SystemVoiceProvider: role.SystemVoiceProvider, SystemVoiceProviderID: role.SystemVoiceProviderID,
		SystemVoiceModel: role.SystemVoiceModel, SpeechLanguage: role.SpeechLanguage, Instruction: role.Instruction,
		Rate: role.Rate, Pitch: role.Pitch, Volume: role.Volume, Revision: role.Revision,
	}
	raw, err := json.Marshal(shared)
	if err != nil {
		return "", err
	}
	document["tts"] = raw
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func legacyChannelIdentityTTSConfigTx(conn *gorm.DB, identityID string, lock bool) (*model.ChannelIdentityTTSConfig, bool, error) {
	var role model.ChannelIdentityTTSConfig
	query := conn.Where("identity_id = ? AND deleted_at IS NULL", identityID)
	if lock {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := query.First(&role).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, nil
	}
	return &role, err == nil, err
}

func channelIdentityTTSConfigTx(conn *gorm.DB, identityID, sharedIdentityID string, lock bool) (*model.ChannelIdentityTTSConfig, bool, error) {
	if sharedIdentityID != "" {
		var template model.SharedChannelIdentityModel
		query := conn.Select("id", "source_identity_id", "shared_data_json").Where("id = ?", sharedIdentityID)
		if lock {
			query = query.Clauses(clause.Locking{Strength: "UPDATE"})
		}
		if err := query.Take(&template).Error; err != nil {
			return nil, false, err
		}
		role, found, err := sharedChannelIdentityTTSConfigFromData(template.SharedDataJSON, identityID)
		if err != nil || found {
			return role, found, err
		}
		if template.SourceIdentityID != "" {
			role, found, err = legacyChannelIdentityTTSConfigTx(conn, template.SourceIdentityID, lock)
			if err != nil || found {
				if role != nil {
					role.IdentityID = identityID
				}
				return role, found, err
			}
			if template.SourceIdentityID == identityID {
				return nil, false, nil
			}
		}
	}
	return legacyChannelIdentityTTSConfigTx(conn, identityID, lock)
}

func promoteChannelIdentityTTSConfigToSharedDataTx(tx *gorm.DB, identityID string, template *model.SharedChannelIdentityModel) error {
	role, found, err := legacyChannelIdentityTTSConfigTx(tx, identityID, true)
	if err != nil || !found {
		return err
	}
	template.SharedDataJSON, err = sharedChannelIdentityTTSData(template.SharedDataJSON, *role)
	return err
}

func ttsRoleIdentity(userID, identityID string) (*model.ChannelIdentityModel, error) {
	var identity model.ChannelIdentityModel
	if err := model.GetDB().Where("id = ? AND deleted_at IS NULL", identityID).First(&identity).Error; err != nil {
		return nil, err
	}
	actor, err := ResolveChannelIdentityActor(identity.ChannelID, userID, identity.UserID)
	if err != nil {
		return nil, err
	}
	if _, err = ValidateChannelIdentityActorIdentity(actor, identity.ChannelID, identityID); err != nil {
		return nil, err
	}
	return &identity, nil
}

func TTSRoleConfig(userID, identityID string) (*model.ChannelIdentityTTSConfig, error) {
	identity, err := ttsRoleIdentity(userID, identityID)
	if err != nil {
		return nil, err
	}
	role, found, err := channelIdentityTTSConfigTx(model.GetDB(), identity.ID, identity.SharedIdentityID, false)
	if err != nil {
		return nil, err
	}
	if !found {
		return defaultChannelIdentityTTSConfig(identityID), nil
	}
	return role, nil
}
func TTSSaveRoleConfig(userID, identityID string, input model.ChannelIdentityTTSConfig) error {
	identity, err := ttsRoleIdentity(userID, identityID)
	if err != nil {
		return err
	}
	// Delegation authorizes managing the identity, not reading a third party's
	// private voice. Enforce this independently of platform availability.
	if input.VoiceID != "" {
		if _, err := ttsAccessibleVoice(model.GetDB(), userID, input.VoiceID); err != nil {
			return err
		}
	}
	if !input.Disabled && (input.VoiceID != "" || input.SystemVoice != "" || input.SpeechLanguage != "") {
		s, err := ttsSnapshot(userID, TTSRequest{VoiceID: input.VoiceID, SystemVoice: input.SystemVoice, SystemVoiceProvider: input.SystemVoiceProvider, SystemVoiceProviderID: input.SystemVoiceProviderID, SystemVoiceModel: input.SystemVoiceModel, SpeechLanguage: input.SpeechLanguage, Instruction: input.Instruction, Rate: input.Rate, Pitch: input.Pitch, Volume: &input.Volume}, "role")
		if err != nil {
			return err
		}
		if input.SystemVoice != "" {
			input.SystemVoiceProvider = s.Provider.EffectiveProviderKind()
			input.SystemVoiceProviderID = s.Provider.ID
			input.SystemVoiceModel = s.Provider.Model
		}
	}
	if input.SystemVoice == "" {
		input.SystemVoiceProvider, input.SystemVoiceProviderID, input.SystemVoiceModel = "", "", ""
	}
	if identity.SharedIdentityID != "" {
		return model.GetDB().Transaction(func(tx *gorm.DB) error {
			var template model.SharedChannelIdentityModel
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Select("id", "user_id", "source_identity_id", "shared_data_json").
				Where("id = ? AND user_id = ?", identity.SharedIdentityID, identity.UserID).Take(&template).Error; err != nil {
				return err
			}
			old, found, err := sharedChannelIdentityTTSConfigFromData(template.SharedDataJSON, identity.ID)
			if err != nil {
				return err
			}
			if !found && template.SourceIdentityID != "" {
				old, found, err = legacyChannelIdentityTTSConfigTx(tx, template.SourceIdentityID, true)
				if err != nil {
					return err
				}
				if old != nil {
					old.IdentityID = identity.ID
				}
			}
			if !found && template.SourceIdentityID != identity.ID {
				old, found, err = legacyChannelIdentityTTSConfigTx(tx, identity.ID, true)
				if err != nil {
					return err
				}
			}
			if !found {
				old = defaultChannelIdentityTTSConfig(identity.ID)
			}
			if input.Revision != old.Revision {
				return ErrTTSConflict
			}
			input.IdentityID = identity.ID
			input.Revision = old.Revision + 1
			raw, err := sharedChannelIdentityTTSData(template.SharedDataJSON, input)
			if err != nil {
				return err
			}
			return tx.Model(&model.SharedChannelIdentityModel{}).Where("id = ? AND user_id = ?", template.ID, identity.UserID).
				Update("shared_data_json", raw).Error
		})
	}
	old, found, err := legacyChannelIdentityTTSConfigTx(model.GetDB(), identity.ID, false)
	if err != nil {
		return err
	}
	if !found {
		old = defaultChannelIdentityTTSConfig(identity.ID)
	}
	if input.Revision != old.Revision {
		return ErrTTSConflict
	}
	input.IdentityID = identity.ID
	input.Revision = old.Revision + 1
	if old.ID == "" {
		input.StringPKBaseModel = model.StringPKBaseModel{}
		return model.GetDB().Create(&input).Error
	}
	r := model.GetDB().Model(&model.ChannelIdentityTTSConfig{}).Where("id = ? AND revision = ?", old.ID, old.Revision).Updates(map[string]any{"disabled": input.Disabled, "voice_id": input.VoiceID, "system_voice": input.SystemVoice, "system_voice_provider": input.SystemVoiceProvider, "system_voice_provider_id": input.SystemVoiceProviderID, "system_voice_model": input.SystemVoiceModel, "speech_language": input.SpeechLanguage, "instruction": input.Instruction, "rate": input.Rate, "pitch": input.Pitch, "volume": input.Volume, "revision": input.Revision})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return ErrTTSConflict
	}
	return nil
}

func TTSUpdateVoice(userID, id string, input model.TTSVoice) error {
	if len(input.Name) > 200 || len(input.Tags) > 500 || len(input.Description) > 2000 {
		return TTSValidationError("音色元数据过长")
	}
	var params TTSRequest
	if input.Parameters != "" && json.Unmarshal([]byte(input.Parameters), &params) != nil {
		return TTSValidationError("无效的默认合成参数")
	}
	if (params.Rate != 0 && (params.Rate < 0.5 || params.Rate > 2)) || (params.Pitch != 0 && (params.Pitch < 0.5 || params.Pitch > 2)) || (params.Volume != nil && (*params.Volume < 0 || *params.Volume > 100)) || len([]rune(params.Instruction)) > 500 {
		return TTSValidationError("默认合成参数超出范围")
	}
	if input.Parameters != "" {
		// Persist only the supported local defaults, never arbitrary client fields.
		raw, err := json.Marshal(struct {
			Instruction string  `json:"instruction,omitempty"`
			Rate        float64 `json:"rate,omitempty"`
			Pitch       float64 `json:"pitch,omitempty"`
			Volume      *int    `json:"volume,omitempty"`
		}{params.Instruction, params.Rate, params.Pitch, params.Volume})
		if err != nil {
			return err
		}
		input.Parameters = string(raw)
	}
	return withTTSUserPolicy(model.GetDB(), userID, func(tx *gorm.DB, _ *model.TTSUserPolicy) error {
		r := tx.Model(&model.TTSVoice{}).Where("id = ? AND owner_user_id = ? AND lifecycle IN ? AND deleted_at IS NULL AND revision = ?", id, userID, []string{"saved", "preview"}, input.Revision).Updates(map[string]any{"name": input.Name, "tags": input.Tags, "description": input.Description, "parameters": input.Parameters, "is_public": input.IsPublic, "revision": gorm.Expr("revision + 1")})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return ErrTTSConflict
		}
		return nil
	})
}
func TTSDeleteVoice(userID, id string) error {
	return withTTSUserPolicy(model.GetDB(), userID, func(tx *gorm.DB, _ *model.TTSUserPolicy) error {
		r := tx.Model(&model.TTSVoice{}).Where("id = ? AND owner_user_id = ? AND deleted_at IS NULL", id, userID).Updates(map[string]any{"lifecycle": "delete_pending", "is_public": false, "revision": gorm.Expr("revision + 1")})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return ErrTTSDenied
		}
		return nil
	})
}

func TTSForceDeleteVoice(parent context.Context, userID, id string) error {
	if userID == "" || id == "" {
		return ErrTTSDenied
	}
	db := model.GetDB()
	var voice model.TTSVoice
	if err := db.Where("id = ? AND owner_user_id = ? AND lifecycle = ? AND deleted_at IS NULL", id, userID, "delete_pending").First(&voice).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrTTSDenied
		}
		return err
	}

	// Force delete is explicitly local-first semantics from the user's point of
	// view. Try the cloud deletion once, but never let a stuck provider prevent
	// the local record from being retired.
	if voice.ProviderVoiceID != "" {
		if cfg := utils.GetConfig(); cfg != nil && cfg.AI.Speech != nil {
			for _, p := range cfg.AI.Speech.Providers {
				if p.ID == voice.ProviderID && p.CredentialScope == voice.CredentialScope && p.Region == voice.Region && p.Workspace == voice.Workspace {
					ctx, cancel := context.WithTimeout(parent, 5*time.Second)
					_, _ = ttsProviderDeleteVoice(ctx, p, voice.ProviderVoiceID)
					cancel()
					break
				}
			}
		}
	}

	r := db.Model(&model.TTSVoice{}).
		Where("id = ? AND owner_user_id = ? AND lifecycle = ? AND deleted_at IS NULL", id, userID, "delete_pending").
		Updates(map[string]any{"lifecycle": "deleted", "deleted_at": time.Now(), "is_public": false, "revision": gorm.Expr("revision + 1")})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return ErrTTSConflict
	}
	if voice.Kind == "clone" {
		_ = ttsCleanupCloneSource(parent, voice.SourceResourceID)
	}
	return nil
}

func TTSSetPolicy(userID string, input model.TTSUserPolicy) error {
	if input.Slots != nil && *input.Slots < 0 {
		return TTSValidationError("槽位不能为负数")
	}
	for _, v := range []*float64{input.DailyLimit, input.MonthlyLimit, input.LifetimeLimit} {
		if v != nil && *v < 0 {
			return TTSValidationError("限制不能为负数")
		}
	}
	return withTTSUserPolicy(model.GetDB(), userID, func(tx *gorm.DB, _ *model.TTSUserPolicy) error {
		return tx.Model(&model.TTSUserPolicy{}).Where("user_id = ?", userID).Updates(map[string]any{"override_enabled": input.OverrideEnabled, "daily_limit": input.DailyLimit, "monthly_limit": input.MonthlyLimit, "lifetime_limit": input.LifetimeLimit, "slots": input.Slots}).Error
	})
}

func TTSResolveUnknown(actor, jobID, action, note string, units int64, tokenUsage ...ttsprovider.Result) error {
	if len(strings.TrimSpace(note)) < 3 {
		return TTSValidationError("请填写核对依据与供应商 request ID")
	}
	var owner model.TTSJob
	if err := model.GetDB().Select("payer_user_id, world_id").Where("id = ? AND status = ?", jobID, "usage_unknown").First(&owner).Error; err != nil {
		return err
	}
	var resolved model.TTSJob
	err := withTTSQuotaPolicies(model.GetDB(), owner.PayerUserID, owner.WorldID, func(tx *gorm.DB, _ *model.TTSUserPolicy, _ model.TTSWorldPolicy) error {
		var j model.TTSJob
		if err := tx.Where("id = ? AND status = ?", jobID, "usage_unknown").First(&j).Error; err != nil {
			return err
		}
		if action == "settle" {
			if (j.Operation == "design" || j.Operation == "clone") && units != 0 && units != 1 {
				return TTSValidationError("单个音色创建任务的确认次数只能为 0 或 1")
			}
			var usage *ttsprovider.Result
			if len(tokenUsage) == 1 {
				usage = &tokenUsage[0]
			}
			if err := ttsSettleUsageJobLocked(tx, j.ID, units, usage, time.Now()); err != nil {
				return err
			}
		} else if action == "release" {
			r := tx.Model(&model.TTSJob{}).Where("id = ? AND usage_status = ?", j.ID, "unknown").Update("usage_status", "released")
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected != 1 {
				return ErrTTSConflict
			}
			r = tx.Model(&model.AIQuotaReservationModel{}).Where("id = ? AND quota_kind = ? AND status = ?", j.ReservationID, "speech", "active").Update("status", "released")
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected != 1 {
				return ErrTTSConflict
			}
		} else {
			return ErrTTSConflict
		}
		if err := tx.Model(&model.TTSJob{}).Where("id = ?", j.ID).Updates(map[string]any{"status": "failed", "audit_actor": actor, "audit_note": note, "error_code": "admin_resolved"}).Error; err != nil {
			return err
		}
		if err := ttsRetireFailedCreationVoice(tx, &j, time.Now()); err != nil {
			return err
		}
		resolved = j
		return nil
	})
	if err == nil {
		ttsCleanupCloneJobSource(&resolved)
	}
	return err
}

// The platform lock serializes bounded channel queues and provider account slots.
func ttsCapacityLock(tx *gorm.DB) error {
	p := model.TTSUserPolicy{UserID: "__tts_capacity__"}
	if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, DoNothing: true}).Create(&p).Error; err != nil {
		return err
	}
	return tx.Model(&model.TTSUserPolicy{}).Where("user_id = ?", p.UserID).UpdateColumn("revision", gorm.Expr("revision + 1")).Error
}
