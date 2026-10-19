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
	return p.Embed == nil && p.Whisper == nil && p.Quote == nil
}

// logMessageBody is a message's LOG body before its image references are resolved.
type logMessageBody struct {
	Doc       AgentRichDocument
	EmbedKind string
}

func logMessageBodyOf(display *messageDisplayResolver, m *model.MessageModel) logMessageBody {
	if expanded, ok := display.forChannel(m.ChannelID).expandEmbed(m.Content, true, true); ok {
		return logMessageBody{Doc: expanded.document(true), EmbedKind: expanded.Kind}
	}
	return logMessageBody{Doc: buildRichDocumentForExport(m.Content, true)}
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
// source; images without a resolvable SealChat attachment are dropped.
func logResolveBody(doc *AgentRichDocument, resolve func(attachmentID string) (string, error)) error {
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
				if id := logImageAttachmentID(*n); id != "" {
					var err error
					if src, err = resolve(id); err != nil {
						return err
					}
				}
				n.Attrs = map[string]string{}
				if src != "" {
					n.Attrs["src"] = src
				}
			}
			if err := walk(n.Children, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(doc.Blocks, 0)
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
	if err != nil || a == nil || a.IsTTSManaged() || a.Size > 20<<20 {
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
func logDesignPresentations(viewerID string, messages []*model.MessageModel) (map[string]*LogMessagePresentation, error) {
	if err := hydrateWhisperTargetsForExport(messages); err != nil {
		return nil, err
	}
	display := newMessageDisplayResolver("", viewerID, messageDisplayPublic)
	out := map[string]*LogMessagePresentation{}
	for _, m := range messages {
		display = display.forChannel(m.ChannelID)
		p := &LogMessagePresentation{}
		if body := logMessageBodyOf(display, m); body.EmbedKind != "" {
			// Mirrors the release: only attachments it could snapshot are shown.
			err := logResolveBody(&body.Doc, func(id string) (string, error) {
				if a := logPublishableAttachment(m, id); a != nil {
					return "/api/v1/attachment/" + url.PathEscape(a.ID), nil
				}
				return "", nil
			})
			if err != nil {
				return nil, err
			}
			p.Embed = &LogMessageEmbed{Kind: body.EmbedKind, BodyHTML: body.html(), PlainText: body.plainText()}
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
