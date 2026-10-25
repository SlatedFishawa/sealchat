package service

import (
	"regexp"
	"strings"
)

var ttsURLPattern = regexp.MustCompile(`(?i)\b(?:https?://|ftp://|www\.)[^\s<>"'，。！？；：、（）【】《》]+`)

// ttsStripURLs removes web URLs from spoken text while preserving sentence
// punctuation immediately following a link.
func ttsStripURLs(text string) string {
	return ttsURLPattern.ReplaceAllStringFunc(text, func(match string) string {
		trimmed := strings.TrimRight(match, ".,!?;:)]}")
		return match[len(trimmed):]
	})
}
