package service

// Chunk planning for background LOG PDF export. Large LOGs are split before they
// reach Chromium so no single browser instance lays out the whole document.
// Boundaries prefer chapters, then sections, and only then a cut inside an
// oversize section (after page breaks / before headings, else at a speaker change).

const (
	// logPDFChunkTarget is the preferred render-node budget of one chunk (messages
	// plus LOG elements). It is far below the HTML export slice size: every node
	// becomes paginated DOM with images and fonts in one Chromium page.
	logPDFChunkTarget = 800
	// logPDFChunkMax allows a whole chapter or section to stay in one chunk up to this size.
	logPDFChunkMax = 1200
	// logPDFMaxNodes bounds one PDF job; larger LOGs should be exported in parts.
	logPDFMaxNodes  = 60000
	logPDFMaxChunks = 200
)

// Cut scores for "cut before message i".
const (
	logPDFCutHard    = 0
	logPDFCutSpeaker = 1
	logPDFCutBreak   = 3
)

type logPDFSectionCost struct {
	ID         string
	ChapterKey string
	// Weights[i] is the node cost of message i including elements anchored to it.
	// Only needed for sections that might be sliced; len(Weights) must equal Messages then.
	Messages int
	// Fixed is the cost of sectionStart / sectionEnd elements.
	Fixed   int
	Weights []int
	// Scores[i] rates cutting before message i (index 0 unused).
	Scores []int
}

func (c logPDFSectionCost) total() int {
	if len(c.Weights) == c.Messages && c.Messages > 0 {
		sum := c.Fixed
		for _, w := range c.Weights {
			sum += w
		}
		return sum
	}
	return c.Fixed + c.Messages
}

type logPDFPart struct {
	SectionID  string
	Slice      int
	SliceCount int
	// Start and End are message indexes [Start, End) within the section.
	Start int
	End   int
	Nodes int
}

type logPDFChunkPlan struct {
	Parts []logPDFPart
	Nodes int
}

// planLogPDFChunks groups sections into ordered chunks.
func planLogPDFChunks(sections []logPDFSectionCost, target, max int) []logPDFChunkPlan {
	if target < 1 {
		target = logPDFChunkTarget
	}
	if max < target {
		max = target
	}
	type unit struct {
		parts []logPDFPart
		nodes int
	}
	units := []unit{}
	for i := 0; i < len(sections); {
		j := i
		chapterNodes := 0
		for j < len(sections) && sections[j].ChapterKey == sections[i].ChapterKey {
			chapterNodes += sections[j].total()
			j++
		}
		if chapterNodes <= max {
			u := unit{nodes: chapterNodes}
			for k := i; k < j; k++ {
				u.parts = append(u.parts, logPDFPart{SectionID: sections[k].ID, Slice: 0, SliceCount: 1, Start: 0, End: sections[k].Messages, Nodes: sections[k].total()})
			}
			units = append(units, u)
		} else {
			for k := i; k < j; k++ {
				s := sections[k]
				if s.total() <= max {
					units = append(units, unit{parts: []logPDFPart{{SectionID: s.ID, Slice: 0, SliceCount: 1, Start: 0, End: s.Messages, Nodes: s.total()}}, nodes: s.total()})
					continue
				}
				for _, p := range sliceLogPDFSection(s, target) {
					units = append(units, unit{parts: []logPDFPart{p}, nodes: p.Nodes})
				}
			}
		}
		i = j
	}
	chunks := []logPDFChunkPlan{}
	var cur logPDFChunkPlan
	for _, u := range units {
		if len(cur.Parts) > 0 && cur.Nodes+u.nodes > target {
			chunks = append(chunks, cur)
			cur = logPDFChunkPlan{}
		}
		cur.Parts = append(cur.Parts, u.parts...)
		cur.Nodes += u.nodes
	}
	if len(cur.Parts) > 0 {
		chunks = append(chunks, cur)
	}
	return chunks
}

// sliceLogPDFSection cuts one oversize section into consecutive parts whose node
// cost stays within target, choosing the best-scored boundary near the ideal size.
func sliceLogPDFSection(s logPDFSectionCost, target int) []logPDFPart {
	n := s.Messages
	weight := func(i int) int {
		if len(s.Weights) == n {
			return s.Weights[i]
		}
		return 1
	}
	score := func(i int) int {
		if len(s.Scores) == n && i > 0 {
			return s.Scores[i]
		}
		return logPDFCutHard
	}
	total := s.total()
	pieces := (total + target - 1) / target
	if pieces < 2 {
		pieces = 2
	}
	ideal := total / pieces
	if ideal < 1 {
		ideal = 1
	}
	cuts := []int{}
	start := 0
	// Section-level fixed elements are attributed to the first and last slice.
	acc := s.Fixed / 2
	for start < n {
		remaining := 0
		for i := start; i < n; i++ {
			remaining += weight(i)
		}
		if acc+remaining <= target {
			break
		}
		// Window [lo, hi]: hi keeps the slice within target, lo is ~70% of the ideal.
		sum := acc
		lo, hi := -1, -1
		for i := start; i < n; i++ {
			sum += weight(i)
			if lo < 0 && sum >= ideal*7/10 {
				lo = i + 1
			}
			if sum > target {
				break
			}
			hi = i + 1
		}
		if hi <= start {
			hi = start + 1 // a single huge message still advances
		}
		if lo < 0 || lo > hi {
			lo = hi
		}
		if lo <= start {
			lo = start + 1
		}
		best, bestScore, bestDist := hi, -1, 1<<30
		run := acc
		idealPos := -1
		for i := start; i < hi; i++ {
			run += weight(i)
			if idealPos < 0 && run >= ideal {
				idealPos = i + 1
			}
		}
		if idealPos < 0 {
			idealPos = hi
		}
		for c := lo; c <= hi && c < n; c++ {
			sc := score(c)
			dist := c - idealPos
			if dist < 0 {
				dist = -dist
			}
			if sc > bestScore || (sc == bestScore && dist < bestDist) {
				best, bestScore, bestDist = c, sc, dist
			}
		}
		if best >= n {
			break
		}
		cuts = append(cuts, best)
		start = best
		acc = 0
	}
	bounds := append([]int{0}, cuts...)
	bounds = append(bounds, n)
	parts := make([]logPDFPart, 0, len(bounds)-1)
	for i := 0; i+1 < len(bounds); i++ {
		nodes := 0
		for k := bounds[i]; k < bounds[i+1]; k++ {
			nodes += weight(k)
		}
		parts = append(parts, logPDFPart{SectionID: s.ID, Slice: i, Start: bounds[i], End: bounds[i+1], Nodes: nodes})
	}
	if len(parts) > 0 {
		parts[0].Nodes += s.Fixed / 2
		parts[len(parts)-1].Nodes += s.Fixed - s.Fixed/2
	}
	for i := range parts {
		parts[i].SliceCount = len(parts)
	}
	return parts
}

// logPDFCutScores rates boundaries inside a section from message metadata and
// the elements anchored to its messages.
func logPDFCutScores(speakers []string, ids []string, elements []LogElement, sectionID string) []int {
	breakAfter := map[string]bool{}
	breakBefore := map[string]bool{}
	for _, e := range elements {
		if e.Anchor.SectionID != sectionID || e.Anchor.Kind != "message" {
			continue
		}
		switch {
		case e.Type == "pageBreak" && e.Anchor.Side == "after":
			breakAfter[e.Anchor.MessageID] = true
		case (e.Type == "heading" || e.Type == "pageBreak" || e.Type == "cover") && e.Anchor.Side == "before":
			breakBefore[e.Anchor.MessageID] = true
		}
	}
	scores := make([]int, len(ids))
	for i := 1; i < len(ids); i++ {
		switch {
		case breakAfter[ids[i-1]] || breakBefore[ids[i]]:
			scores[i] = logPDFCutBreak
		case speakers[i] != speakers[i-1]:
			scores[i] = logPDFCutSpeaker
		}
	}
	return scores
}
