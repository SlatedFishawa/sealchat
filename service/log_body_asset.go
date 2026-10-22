package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"sealchat/model"
)

const (
	logBodyMessage    = "message"
	logBodyWorldClue  = "worldClue"
	logBodyStickyNote = "stickyNote"
	logBodyAvatar     = "identityAvatar"
	logBodyAssetAttr  = "log_body_asset_key"
)

// LogBodyAssetRef is transient LOG provenance, never a persisted attachment model.
// Only a server-built manifest can introduce one into a design read or release.
type LogBodyAssetRef struct {
	Key          string
	Kind         string
	AttachmentID string
	MessageID    string
	WorldID      string
	ClueID       string
	NoteID       string
}

func (b *logMessageBody) addAsset(m *model.MessageModel, ref LogBodyAssetRef) LogBodyAssetRef {
	ref.MessageID = m.ID
	ref.Key = ""
	raw, _ := json.Marshal(ref)
	ref.Key = logPublicKey(m.ID, "body:"+strconv.FormatInt(m.Version, 10), string(raw))
	if b.Assets == nil {
		b.Assets = map[string]LogBodyAssetRef{}
	}
	b.Assets[ref.Key] = ref
	return ref
}

// appendDocument copies the cached export document before marking image nodes.
// Provenance is assigned while the embed's source is still known, never inferred from HTML.
func (b *logMessageBody) appendDocument(m *model.MessageModel, doc AgentRichDocument, source LogBodyAssetRef) {
	b.Doc.Type = "document"
	b.Doc.Blocks = append(b.Doc.Blocks, b.markDocument(m, doc, source).Blocks...)
}

// markDocument returns a copy of doc whose SealChat images carry body asset keys.
func (b *logMessageBody) markDocument(m *model.MessageModel, doc AgentRichDocument, source LogBodyAssetRef) AgentRichDocument {
	var copyNodes func([]AgentRichNode) []AgentRichNode
	copyNodes = func(nodes []AgentRichNode) []AgentRichNode {
		out := make([]AgentRichNode, len(nodes))
		for i, n := range nodes {
			n.Marks = append([]AgentRichMark(nil), n.Marks...)
			attrs := make(map[string]string, len(n.Attrs)+1)
			for k, v := range n.Attrs {
				attrs[k] = v
			}
			n.Attrs = attrs
			// Ignore any user-supplied internal marker.
			delete(n.Attrs, logBodyAssetAttr)
			if n.Type == "image" {
				if id := logImageAttachmentID(n); id != "" {
					ref := source
					ref.AttachmentID = id
					n.Attrs[logBodyAssetAttr] = b.addAsset(m, ref).Key
				}
			}
			n.Children = copyNodes(n.Children)
			out[i] = n
		}
		return out
	}
	doc.Blocks = copyNodes(doc.Blocks)
	return doc
}

func logAvatarAsset(m *model.MessageModel) LogBodyAssetRef {
	return LogBodyAssetRef{Kind: logBodyAvatar, MessageID: m.ID, AttachmentID: strings.TrimSpace(m.SenderIdentityAvatarID)}
}

// logResolveBodyAsset shares source semantics between authenticated design reads
// and release snapshots. The caller must first authorize the source message.
func logResolveBodyAsset(display *messageDisplayResolver, m *model.MessageModel, ref LogBodyAssetRef) *model.AttachmentModel {
	if ref.MessageID != m.ID || ref.AttachmentID == "" || m.IsDeleted || m.IsRevoked {
		return nil
	}
	var a *model.AttachmentModel
	switch ref.Kind {
	case logBodyMessage:
		a = logPublishableAttachment(m, ref.AttachmentID)
	case logBodyStickyNote:
		r := display.forChannel(m.ChannelID).sticky
		if r == nil {
			return nil
		}
		note := r.load(ref.NoteID)
		if note == nil || note.ChannelID != m.ChannelID || !CanViewStickyNote(note, "") {
			return nil
		}
		// Rich/chat note uploads are ordinary attachments today, but retain the
		// note source so adding a dedicated resolver later will not change the wire format.
		a, _ = ResolveAttachmentAccessible(note.CreatorID, "", note.ChannelID, ref.AttachmentID)
		if a != nil && a.RootIDType == "world_clue" {
			return nil
		}
	case logBodyWorldClue:
		r := display.forChannel(m.ChannelID).clue
		if r.worldID != ref.WorldID {
			return nil
		}
		// Reuse WorldClueGet and the public presentation boundary in the export resolver.
		block := r.load(worldClueEmbedTarget{WorldID: ref.WorldID, ChannelID: m.ChannelID, ClueID: ref.ClueID}, true)
		if block == nil {
			return nil
		}
		a, _ = ResolveAttachment(ref.AttachmentID)
		if a == nil {
			return nil
		}
		if ref.AttachmentID == worldClueImageAttachmentToken(*block) {
			if a.RootIDType != "world_clue" || a.RootID != ref.WorldID {
				return nil
			}
		} else {
			// The rich editor uploads channel images, not additional world_clue
			// media. A foreign clue's protected attachment must never fall back here.
			if a.RootIDType == "world_clue" {
				return nil
			}
			var clue model.WorldClueModel
			if model.GetDB().Where("id = ? AND world_id = ?", ref.ClueID, ref.WorldID).Take(&clue).Error != nil {
				return nil
			}
			a, _ = ResolveAttachmentAccessible(clue.CreatorID, clue.UpdatedBy, m.ChannelID, ref.AttachmentID)
		}
	case logBodyAvatar:
		if ref.AttachmentID != strings.TrimSpace(m.SenderIdentityAvatarID) {
			return nil
		}
		a = logHistoricalAvatarAttachment(m)
	default:
		return nil
	}
	if a == nil || a.IsTTSManaged() || a.Size > 20<<20 {
		return nil
	}
	return a
}

func logHistoricalAvatarAttachment(m *model.MessageModel) *model.AttachmentModel {
	a, _ := ResolveAttachment(m.SenderIdentityAvatarID)
	if a == nil || a.RootIDType == "world_clue" || a.IsTTSManaged() {
		return nil
	}
	if normal := logPublishableAttachment(m, a.ID); normal != nil {
		return normal
	}
	// A saved avatar need not remain the identity's current avatar. Deleted
	// identities still establish its historical owner/channel; never substitute a new image.
	var identity model.ChannelIdentityModel
	if model.GetDB().Unscoped().Where("id = ? AND channel_id = ?", m.SenderIdentityID, m.ChannelID).Take(&identity).Error == nil {
		if owned, _ := ResolveAttachmentAccessible(identity.UserID, "", identity.ChannelID, a.ID); owned != nil {
			return owned
		}
	}
	sharedID := m.SenderSharedIdentityID
	if sharedID == "" {
		sharedID = identity.SharedIdentityID
	}
	if sharedID == "" {
		return nil
	}
	var channel model.ChannelModel
	var shared model.SharedChannelIdentityModel
	if model.GetDB().Where("id = ?", m.ChannelID).Take(&channel).Error != nil || channel.WorldID == "" ||
		model.GetDB().Unscoped().Where("id = ? AND world_id = ?", sharedID, channel.WorldID).Take(&shared).Error != nil {
		return nil
	}
	if owned, _ := ResolveAttachmentAccessible(shared.UserID, "", "", a.ID); owned != nil {
		return owned
	}
	var source model.ChannelModel
	if model.GetDB().Unscoped().Where("id = ? AND world_id = ?", shared.SourceChannelID, channel.WorldID).Take(&source).Error != nil {
		return nil
	}
	owned, _ := ResolveAttachmentAccessible("", "", source.ID, a.ID)
	return owned
}

type LogBodyAssetBytes struct {
	Data []byte
	MIME string
}

// Read authorized image bytes through current storage first, then the attachment subsystem's
// historical compatibility path. Callers must resolve/authorize the attachment before reaching here.
func logReadBodyAsset(ctx context.Context, a *model.AttachmentModel) (*LogBodyAssetBytes, error) {
	if a == nil || GetStorageManager() == nil {
		return nil, logBodyAssetNotFound()
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := OpenAttachmentReadCompatible(ctx, a)
	if err != nil {
		return nil, logBodyAssetNotFound()
	}
	defer r.Close()
	b, err := io.ReadAll(io.LimitReader(r, (20<<20)+1))
	if err != nil || len(b) == 0 || len(b) > 20<<20 {
		return nil, logBodyAssetNotFound()
	}
	mimeType := logBodyImageMIME(a.MimeType, b)
	if mimeType == "" {
		return nil, logBodyAssetNotFound()
	}
	return &LogBodyAssetBytes{Data: b, MIME: mimeType}, nil
}

func logBodyImageMIME(stored string, data []byte) string {
	for _, value := range []string{stored, http.DetectContentType(data)} {
		mimeType := strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
		if mimeType == "image/jpg" {
			mimeType = "image/jpeg"
		}
		switch mimeType {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif":
			return mimeType
		}
	}
	return ""
}

func logBodyAssetNotFound() error { return logError("NOT_FOUND", "正文资源不可用") }

// GetLogBodyAsset rebuilds the authorized message's manifest. An attachment ID
// supplied in place of a key cannot introduce a resource into this manifest.
func GetLogBodyAsset(ctx context.Context, projectID, sectionID, messageID, key, userID string) (*LogBodyAssetBytes, error) {
	if userID == "" {
		return nil, logError("UNAUTHENTICATED", "请先登录")
	}
	p, _, err := loadLogProjectForDesign(projectID, userID)
	if err != nil {
		return nil, logBodyAssetNotFound()
	}
	s, _, err := logSection(p, sectionID)
	if err != nil {
		return nil, logBodyAssetNotFound()
	}
	var m model.MessageModel
	if len(key) != 32 || logSourceQuery(p, s, userID).Where("id = ?", messageID).Take(&m).Error != nil {
		return nil, logBodyAssetNotFound()
	}
	// Rebuild the same archival projection used by the design window so images
	// inside authorized World Clue private sections resolve from the manifest too.
	display := newMessageDisplayResolver(m.ChannelID, userID, messageDisplayLogArchive)
	body := logMessageBodyOf(display, &m)
	if m.SenderIdentityAvatarID != "" {
		body.addAsset(&m, logAvatarAsset(&m))
	}
	ref, ok := body.Assets[key]
	if !ok {
		return nil, logBodyAssetNotFound()
	}
	return logReadBodyAsset(ctx, logResolveBodyAsset(display, &m, ref))
}
