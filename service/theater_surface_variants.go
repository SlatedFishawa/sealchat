package service

import (
	"encoding/json"
	"math"
	"strings"

	"sealchat/utils"
)

func validateTheaterSurfaceVariants(input any) error {
	type slot struct {
		ID    string           `json:"id"`
		Name  string           `json:"name"`
		Image *TheaterMCPImage `json:"image"`
	}
	type group struct {
		Slots      []slot  `json:"slots"`
		ActiveID   *string `json:"activeId"`
		Transition struct {
			Type       string  `json:"type"`
			DurationMS float64 `json:"durationMs"`
		} `json:"transition"`
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return theaterPayloadError("surfaceVariants 无效")
	}
	var groups map[string]group
	if err := decodeStrictJSON(raw, &groups); err != nil || groups == nil {
		return theaterPayloadError("surfaceVariants 无效")
	}
	for target, value := range groups {
		if target != "background" && target != "foreground" {
			return theaterPayloadError("surfaceVariants 图层无效")
		}
		ids := map[string]bool{}
		for _, item := range value.Slots {
			if strings.TrimSpace(item.ID) == "" || len(item.ID) > 128 || ids[item.ID] || strings.TrimSpace(item.Name) == "" || len([]rune(item.Name)) > 128 {
				return theaterPayloadError("surfaceVariants 槽位无效")
			}
			ids[item.ID] = true
			if item.Image != nil && (strings.TrimSpace(item.Image.URL) == "" || item.Image.LoopCount < 0 || item.Image.LoopCount > 65535) {
				return theaterPayloadError("surfaceVariants 图片无效")
			}
		}
		if value.ActiveID != nil && !ids[*value.ActiveID] {
			return theaterPayloadError("surfaceVariants activeId 无效")
		}
		phase := value.Transition
		if !map[string]bool{"none": true, "fade": true, "slide": true, "dissolve": true, "zoom": true, "blur": true}[phase.Type] || math.IsNaN(phase.DurationMS) || math.IsInf(phase.DurationMS, 0) || phase.DurationMS < 20 || phase.DurationMS > 5000 || math.Trunc(phase.DurationMS) != phase.DurationMS {
			return theaterPayloadError("surfaceVariants 槽位切换配置无效")
		}
	}
	return nil
}

// Existing MCP surface edits replace only the active image, preserving every
// inactive variant and shared webpage/style setting. Hidden surfaces get a new
// slot when an image is explicitly assigned.
func updateTheaterSurfaceVariantImage(state map[string]any, target string, image any) {
	variants, _ := state["surfaceVariants"].(map[string]any)
	group, _ := variants[target].(map[string]any)
	if group == nil {
		return
	}
	slots, _ := group["slots"].([]any)
	activeID, _ := group["activeId"].(string)
	for _, raw := range slots {
		item, _ := raw.(map[string]any)
		if activeID != "" && item["id"] == activeID {
			item["image"] = image
			return
		}
	}
	if image != nil {
		id := utils.NewID()
		group["slots"] = append(slots, map[string]any{"id": id, "name": "默认", "image": image})
		group["activeId"] = id
	}
}
