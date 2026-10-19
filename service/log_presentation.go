package service

import (
	"encoding/json"
	"net/url"
	"strings"

	"sealchat/model"
	"sealchat/protocol"
)

// LOG reads messages through the shared display semantics with the public
// audience, in the design window and in the published release alike. The raw
// message.content stays the only editable source; nothing here is written back.

// LogMessagePresentation is the read-only projection a design window adds to a raw message.
type LogMessagePresentation struct {
	// Embed replaces the body when the whole message is internal embed links.
	Embed   *LogMessageEmbed   `json:"embed,omitempty"`
	Whisper *LogMessageWhisper `json:"whisper,omitempty"`
	Quote   *LogMessageQuote   `json:"quote,omitempty"`
	// A present empty token explicitly suppresses an unsafe/unavailable avatar.
	AvatarToken *string `json:"avatarToken,omitempty"`
}

type LogMessageEmbed struct {
	Kind      string `json:"kind"`
	BodyHTML  string `json:"bodyHtml"`
	PlainText string `json:"plainText"`
}

// LogMessageWhisper is orthogonal to the message type: an IC, OOC or dice message may be a whisper.
type LogMessageWhisper struct {
	Targets []MessageWhisperTarget `json:"targets"`
}

type LogMessageQuote struct {
	SpeakerName string `json:"speakerName"`
	Text        string `json:"text"`
}

func (p *LogMessagePresentation) empty() bool {
	return p.Embed == nil && p.Whisper == nil && p.Quote == nil && p.AvatarToken == nil
}

// logMessageBody is a message's LOG body before its image references are resolved.
type logMessageBody struct {
	Doc       AgentRichDocument
	EmbedKind string
	Assets    map[string]LogBodyAssetRef
}

func logMessageBodyOf(display *messageDisplayResolver, m *model.MessageModel) logMessageBody {
	body := logMessageBody{}
	if m.IsDeleted || m.IsRevoked {
		return body
	}
	if expanded, ok := display.forChannel(m.ChannelID).expandEmbed(m.Content, true, true); ok {
		body.EmbedKind = expanded.Kind
		switch expanded.Kind {
		case messageEmbedWorldClue:
			for _, block := range expanded.WorldClues {
				body.appendDocument(m, worldClueRichDocument(block, true), LogBodyAssetRef{Kind: logBodyWorldClue, WorldID: block.WorldID, ClueID: block.ClueID})
			}
		case messageEmbedStickyNote:
			for _, part := range expanded.StickyNotes {
				body.appendDocument(m, part.Doc, LogBodyAssetRef{Kind: logBodyStickyNote, NoteID: part.NoteID})
			}
		}
		return body
	}
	body.appendDocument(m, buildRichDocumentForExport(m.Content, true), LogBodyAssetRef{Kind: logBodyMessage})
	return body
}

// html renders the body; an expanded embed gets a wrapper that styles can target.
func (b logMessageBody) html() string {
	out := RenderAgentRichDocumentHTML(b.Doc, true)
	switch b.EmbedKind {
	case messageEmbedStickyNote:
		return `<div class="log-embed log-embed--sticky-note">` + out + `</div>`
	case messageEmbedWorldClue:
		return `<div class="log-embed log-embed--world-clue">` + out + `</div>`
	}
	return out
}

func (b logMessageBody) plainText() string {
	return AgentRichDocumentPlainText(b.Doc)
}

// logResolveBody keeps only http(s) links and points every image at resolve's
// source; unavailable and external images become plain placeholders. Internal
// source attributes are cleared before any HTML leaves the service.
func logResolveBody(body *logMessageBody, resolve func(LogBodyAssetRef) (string, error)) error {
	count := 0
	var walk func([]AgentRichNode, int) error
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
				src := ""
				missingText := "外链图片未嵌入"
				if ref, ok := body.Assets[n.Attrs[logBodyAssetAttr]]; ok {
					missingText = "图片不可用"
					var err error
					if src, err = resolve(ref); err != nil {
						return err
					}
				}
				n.Attrs = map[string]string{}
				if src != "" {
					n.Attrs["src"] = src
				} else {
					n.Type, n.Text = "text", missingText
				}
			}
			if err := walk(n.Children, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(body.Doc.Blocks, 0)
}

// logImageAttachmentID accepts only SealChat attachment references (explicit attribute,
// id:<ID> or an attachment URL); external images never become LOG assets.
func logImageAttachmentID(n AgentRichNode) string {
	if id := strings.TrimSpace(n.Attrs["attachment_id"]); id != "" {
		return id
	}
	src := strings.TrimSpace(n.Attrs["src"])
	if strings.HasPrefix(src, "id:") || strings.Contains(src, "/api/v1/attachment/") {
		return extractAttachmentToken(src)
	}
	return ""
}

// logPublishableAttachment is the attachment a release may snapshot for the message, or nil.
func logPublishableAttachment(m *model.MessageModel, attachmentID string) *model.AttachmentModel {
	a, err := ResolveAttachmentAccessible(m.UserID, m.UserID, m.ChannelID, attachmentID)
	if err != nil || a == nil || a.RootIDType == "world_clue" || a.IsTTSManaged() || a.Size > 20<<20 {
		return nil
	}
	return a
}

func logMessageType(m *model.MessageModel) string {
	if strings.TrimSpace(m.DiceVisualJSON) != "" {
		var payload protocol.DiceVisualPayload
		if json.Unmarshal([]byte(m.DiceVisualJSON), &payload) == nil && len(payload.Groups) > 0 {
			return "dice"
		}
	}
	if m.User != nil && m.User.IsBot {
		return "bot"
	}
	if m.ICMode == "ooc" {
		return "ooc"
	}
	return "ic"
}

func logSpeakerName(m *model.MessageModel) string {
	if m.SenderIdentityName != "" {
		return m.SenderIdentityName
	}
	if m.SenderMemberName != "" {
		return m.SenderMemberName
	}
	return "匿名"
}

func logQuoteOf(speakerName, plainText string) *LogMessageQuote {
	text := strings.Join(strings.Fields(plainText), " ")
	if runes := []rune(text); len(runes) > 60 {
		text = string(runes[:60]) + "…"
	}
	if text == "" {
		return nil
	}
	return &LogMessageQuote{SpeakerName: speakerName, Text: text}
}

// logDesignPresentations projects one design window. The window was loaded through the
// section query, so the viewer may already read every whisper and quote in it.
func logDesignPresentations(viewerID, sectionID string, messages []*model.MessageModel) (map[string]*LogMessagePresentation, error) {
	if err := hydrateWhisperTargetsForExport(messages); err != nil {
		return nil, err
	}
	display := newMessageDisplayResolver("", viewerID, messageDisplayPublic)
	out := map[string]*LogMessagePresentation{}
	for _, m := range messages {
		display = display.forChannel(m.ChannelID)
		p := &LogMessagePresentation{}
		body := logMessageBodyOf(display, m)
		// Only server-expanded embeds replace the design body. Ordinary messages keep
		// the chat frontend's full TipTap renderer; otherwise merely containing an
		// image would downgrade unrelated marks/nodes to AgentRich's export subset.
		if body.EmbedKind != "" {
			err := logResolveBody(&body, func(ref LogBodyAssetRef) (string, error) {
				if logResolveBodyAsset(display, m, ref) != nil {
					return "/__log_body_asset/" + sectionID + "/" + url.PathEscape(m.ID) + "/" + ref.Key, nil
				}
				return "", nil
			})
			if err != nil {
				return nil, err
			}
			p.Embed = &LogMessageEmbed{Kind: body.EmbedKind, BodyHTML: body.html(), PlainText: body.plainText()}
		}
		if m.SenderIdentityAvatarID != "" {
			token := ""
			ref := body.addAsset(m, logAvatarAsset(m))
			if logResolveBodyAsset(display, m, ref) != nil {
				token = "body:" + sectionID + "/" + m.ID + "/" + ref.Key
			}
			p.AvatarToken = &token
		}
		if m.IsWhisper {
			if targets := display.whisperTargets(m); len(targets) > 0 {
				p.Whisper = &LogMessageWhisper{Targets: targets}
			}
		}
		// A release never shows a quoted whisper; the design window only does inside whispers.
		if q := m.Quote; q != nil && (!q.IsWhisper || m.IsWhisper) {
			p.Quote = logQuoteOf(logSpeakerName(q), logMessageBodyOf(display, q).plainText())
		}
		if !p.empty() {
			out[m.ID] = p
		}
	}
	return out, nil
}
