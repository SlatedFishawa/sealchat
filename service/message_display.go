package service

import (
	"strings"

	"sealchat/model"
)

// messageDisplayResolver reads a raw chat message the way a reader sees it: a
// message that is wholly an internal embed (sticky note / world clue links)
// shows the embedded content, and a whisper names its targets. The standard
// export pipeline and LOG share it so both interpret messages identically;
// each output only decides how to render the projection.
type messageDisplayResolver struct {
	channelID string
	viewerID  string
	audience  messageDisplayAudience
	identity  *identityResolver
	sticky    *stickyNoteExportResolver
	clue      *worldClueExportResolver
}

type messageDisplayAudience int

const (
	// messageDisplayViewer expands everything the viewer may read (private exports).
	messageDisplayViewer messageDisplayAudience = iota
	// messageDisplayPublic expands only content every reader may see.
	messageDisplayPublic
	// messageDisplayLogArchive keeps the public embed boundary, but lets an
	// authorized LOG viewer include World Clue member-private sections in the
	// design/release snapshot. It must not broaden sticky-note visibility.
	messageDisplayLogArchive
)

const (
	messageEmbedStickyNote = "stickyNote"
	messageEmbedWorldClue  = "worldClue"
)

func newMessageDisplayResolver(channelID, viewerID string, audience messageDisplayAudience) *messageDisplayResolver {
	r := &messageDisplayResolver{
		channelID: strings.TrimSpace(channelID),
		viewerID:  strings.TrimSpace(viewerID),
		audience:  audience,
		identity:  newIdentityResolver(channelID),
		sticky:    newStickyNoteExportResolver(channelID),
		clue:      newWorldClueExportResolver(channelID, viewerID),
	}
	if audience == messageDisplayPublic || audience == messageDisplayLogArchive {
		if r.sticky != nil {
			r.sticky.publicOnly = true
		}
		r.clue.publicOnly = true
		if audience == messageDisplayLogArchive {
			r.clue.includePrivateSections = true
		}
	}
	return r
}

// forChannel returns a resolver for the message's own channel; embeds only expand within it.
func (r *messageDisplayResolver) forChannel(channelID string) *messageDisplayResolver {
	if r != nil && r.channelID == strings.TrimSpace(channelID) {
		return r
	}
	viewerID, audience := "", messageDisplayViewer
	if r != nil {
		viewerID, audience = r.viewerID, r.audience
	}
	return newMessageDisplayResolver(channelID, viewerID, audience)
}

// messageEmbedExpansion is the content of a message that consists only of internal embed links.
type messageEmbedExpansion struct {
	Kind        string
	Plain       string
	HTML        string
	Rich        *AgentRichDocument
	WorldClues  []WorldClueExportBlock
	StickyNotes []stickyNoteRichPart
}

// expandEmbed keeps the existing export boundary: only a message made entirely of
// embed links expands; links inside ordinary text stay links. richOnly skips the
// export HTML of sticky notes and builds their rich document instead.
func (r *messageDisplayResolver) expandEmbed(content string, includeImages, richOnly bool) (messageEmbedExpansion, bool) {
	if r == nil {
		return messageEmbedExpansion{}, false
	}
	if expanded, ok := r.sticky.render(content, includeImages, richOnly); ok {
		return messageEmbedExpansion{Kind: messageEmbedStickyNote, Plain: expanded.Plain, HTML: expanded.HTML, Rich: expanded.Rich, StickyNotes: expanded.Parts}, true
	}
	if expanded, ok := r.clue.render(content, includeImages); ok {
		return messageEmbedExpansion{Kind: messageEmbedWorldClue, Plain: expanded.Plain, HTML: expanded.HTML, WorldClues: expanded.Blocks}, true
	}
	return messageEmbedExpansion{}, false
}

// document returns the expansion as one rich document. Sticky notes need an
// expansion made with richOnly.
func (e messageEmbedExpansion) document(includeImages bool) AgentRichDocument {
	if e.Rich != nil {
		return *e.Rich
	}
	docs := make([]AgentRichDocument, 0, len(e.WorldClues))
	for _, block := range e.WorldClues {
		docs = append(docs, worldClueRichDocument(block, includeImages))
	}
	return MergeAgentRichDocuments(docs)
}

// MessageWhisperTarget is one recipient of a whisper. Key is stable per recipient
// (the user ID when known, otherwise the display name).
type MessageWhisperTarget struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

func (r *messageDisplayResolver) whisperTargetNames(msg *model.MessageModel) []string {
	if r == nil {
		return extractWhisperTargets(msg, "", nil)
	}
	return extractWhisperTargets(msg, r.channelID, r.identity)
}

// whisperTargets names the recipients exactly like the export ("对 A、B"), keeping
// each recipient separate. Callers must already be allowed to see the whisper.
func (r *messageDisplayResolver) whisperTargets(msg *model.MessageModel) []MessageWhisperTarget {
	names := r.whisperTargetNames(msg)
	if len(names) == 0 {
		return nil
	}
	ids := msg.WhisperTargetUserIDs()
	targets := make([]MessageWhisperTarget, 0, len(names))
	for i, name := range names {
		key := name
		// Names come from the same ordered recipients unless a fallback path produced them.
		if len(ids) == len(names) {
			key = ids[i]
		}
		targets = append(targets, MessageWhisperTarget{Key: key, Name: name})
	}
	return targets
}
