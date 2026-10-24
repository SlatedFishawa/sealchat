package service

import (
	"strings"

	"gorm.io/gorm"

	"sealchat/model"
)

// Resolve the root before changing any rows. A cycle/missing parent or an effect in a
// viewport tree rejects the whole caller transaction rather than persisting a mixed tree.
func theaterObjectTreeCoordinateSpaces(objects map[string]TheaterObjectSnapshot) (map[string]string, error) {
	spaces := make(map[string]string, len(objects))
	visiting := make(map[string]bool, len(objects))
	var resolve func(string) (string, error)
	resolve = func(id string) (string, error) {
		if space, ok := spaces[id]; ok {
			return space, nil
		}
		object, ok := objects[id]
		if !ok || visiting[id] {
			return "", theaterPayloadError("parent 不存在或循环")
		}
		visiting[id] = true
		space := normalizedTheaterObjectCoordinateSpace(object.CoordinateSpace)
		if parentID := derefString(object.ParentID); parentID != "" {
			var err error
			space, err = resolve(parentID)
			if err != nil {
				return "", err
			}
		}
		if object.Kind == "effect" {
			if space == TheaterObjectCoordinateSpaceViewport {
				return "", theaterPayloadError("特效不能加入屏幕固定对象树")
			}
			space = TheaterObjectCoordinateSpaceWorld
		}
		spaces[id] = space
		delete(visiting, id)
		return space, nil
	}
	for id := range objects {
		if _, err := resolve(id); err != nil {
			return nil, err
		}
	}
	return spaces, nil
}

func cloneTheaterObjectCoordinateMap(objects map[string]TheaterObjectSnapshot) map[string]TheaterObjectSnapshot {
	cloned := make(map[string]TheaterObjectSnapshot, len(objects))
	for id, object := range objects {
		cloned[id] = object
	}
	return cloned
}

func applyTheaterObjectCoordinateUpdates(objects map[string]TheaterObjectSnapshot, updates []theaterObjectUpdatePayload) {
	for _, update := range updates {
		object, ok := objects[update.ObjectID]
		if !ok {
			continue
		}
		if value, present := update.Fields["parentId"]; present {
			parentID, _ := value.(string)
			object.ParentID = optionalString(strings.TrimSpace(parentID))
		}
		if value, present := update.Fields["coordinateSpace"]; present {
			if space, ok := value.(string); ok {
				object.CoordinateSpace = space
			}
		}
		objects[object.ID] = object
	}
}

func validateTheaterObjectReparentTransitions(
	beforeObjects map[string]TheaterObjectSnapshot,
	afterObjects map[string]TheaterObjectSnapshot,
	updates []theaterObjectUpdatePayload,
) error {
	beforeSpaces, err := theaterObjectTreeCoordinateSpaces(beforeObjects)
	if err != nil {
		return err
	}
	afterSpaces, err := theaterObjectTreeCoordinateSpaces(afterObjects)
	if err != nil {
		return err
	}
	for _, update := range updates {
		if _, present := update.Fields["parentId"]; !present {
			continue
		}
		before, beforeOK := beforeObjects[update.ObjectID]
		after, afterOK := afterObjects[update.ObjectID]
		if !beforeOK || !afterOK || derefString(before.ParentID) == derefString(after.ParentID) {
			continue
		}
		beforeSpace, afterSpace := beforeSpaces[update.ObjectID], afterSpaces[update.ObjectID]
		if beforeSpace != afterSpace {
			return theaterPayloadError("reparent 不能跨 world/viewport 坐标空间；请先切换对象树坐标空间")
		}
		if requestedSpace, ok := update.Fields["coordinateSpace"].(string); ok && normalizedTheaterObjectCoordinateSpace(requestedSpace) != afterSpace {
			return theaterPayloadError("reparent 不能同时切换坐标空间")
		}

		requiredFields := []string{"x", "y", "rotation"}
		if derefString(after.ParentID) == "" && afterSpace == TheaterObjectCoordinateSpaceViewport {
			requiredFields = []string{"viewportX", "viewportY", "rotation"}
		}
		for _, field := range requiredFields {
			if _, ok := update.Fields[field]; !ok {
				return theaterPayloadError("reparent 必须提供完整目标姿态字段")
			}
		}
		if _, uniformScale := update.Fields["scale"]; !uniformScale {
			if _, ok := update.Fields["scaleX"]; !ok {
				return theaterPayloadError("reparent 必须提供完整目标姿态字段")
			}
			if _, ok := update.Fields["scaleY"]; !ok {
				return theaterPayloadError("reparent 必须提供完整目标姿态字段")
			}
		}
	}
	return nil
}

func loadTheaterObjectCoordinateMap(tx *gorm.DB, roomID string) (map[string]TheaterObjectSnapshot, error) {
	var rows []model.TheaterObjectModel
	if err := tx.Select("id", "parent_id", "kind", "coordinate_space").Where("room_id = ?", roomID).Find(&rows).Error; err != nil {
		return nil, err
	}
	objects := make(map[string]TheaterObjectSnapshot, len(rows))
	for _, row := range rows {
		objects[row.ID] = TheaterObjectSnapshot{
			ID: row.ID, ParentID: optionalString(row.ParentID), Kind: row.Kind, CoordinateSpace: row.CoordinateSpace,
		}
	}
	return objects, nil
}

func validateTheaterDBReparentTransitions(tx *gorm.DB, roomID string, updates []theaterObjectUpdatePayload) error {
	reparentIDs := []string{}
	for _, update := range updates {
		if _, present := update.Fields["parentId"]; present {
			reparentIDs = append(reparentIDs, update.ObjectID)
		}
	}
	if len(reparentIDs) == 0 {
		return nil
	}
	// Repair only source trees before evaluating a structural edit. This keeps legacy mixed
	// descendants from leaking stale coordinate_space values without touching unrelated trees.
	if err := normalizeTheaterObjectTreeCoordinateSpaces(tx, roomID, reparentIDs...); err != nil {
		return err
	}
	beforeObjects, err := loadTheaterObjectCoordinateMap(tx, roomID)
	if err != nil {
		return err
	}
	afterObjects := cloneTheaterObjectCoordinateMap(beforeObjects)
	applyTheaterObjectCoordinateUpdates(afterObjects, updates)
	return validateTheaterObjectReparentTransitions(beforeObjects, afterObjects, updates)
}

func theaterObjectCoordinateTreeRoot(tx *gorm.DB, roomID, objectID string) (*model.TheaterObjectModel, error) {
	seen := map[string]struct{}{}
	currentID := objectID
	for currentID != "" {
		if _, exists := seen[currentID]; exists {
			return nil, theaterPayloadError("parent 不存在或循环")
		}
		seen[currentID] = struct{}{}
		current, err := loadTheaterObject(tx, roomID, currentID)
		if err != nil {
			return nil, err
		}
		if current.ParentID == "" {
			return current, nil
		}
		currentID = current.ParentID
	}
	return nil, theaterPayloadError("parent 不存在或循环")
}

// Normalize only the final trees touched by a structural coordinate-space mutation.
// Ordinary x/y/name/visibility edits must not scan or rewrite unrelated object trees.
func normalizeTheaterObjectTreeCoordinateSpaces(tx *gorm.DB, roomID string, objectIDs ...string) error {
	roots := map[string]*model.TheaterObjectModel{}
	for _, objectID := range objectIDs {
		if objectID == "" {
			continue
		}
		root, err := theaterObjectCoordinateTreeRoot(tx, roomID, objectID)
		if err != nil {
			return err
		}
		roots[root.ID] = root
	}
	for _, root := range roots {
		space := normalizedTheaterObjectCoordinateSpace(root.CoordinateSpace)
		if root.Kind == "effect" {
			if space == TheaterObjectCoordinateSpaceViewport {
				return theaterPayloadError("特效不能加入屏幕固定对象树")
			}
			space = TheaterObjectCoordinateSpaceWorld
		}

		rows := []model.TheaterObjectModel{*root}
		frontier := []string{root.ID}
		for len(frontier) > 0 {
			var children []model.TheaterObjectModel
			if err := tx.Select("id", "parent_id", "kind", "coordinate_space").
				Where("room_id = ? AND parent_id IN ?", roomID, frontier).
				Find(&children).Error; err != nil {
				return err
			}
			frontier = frontier[:0]
			for _, child := range children {
				rows = append(rows, child)
				frontier = append(frontier, child.ID)
			}
		}

		changes := []string{}
		for _, row := range rows {
			if row.Kind == "effect" && space == TheaterObjectCoordinateSpaceViewport {
				return theaterPayloadError("特效不能加入屏幕固定对象树")
			}
			if row.CoordinateSpace != space {
				changes = append(changes, row.ID)
			}
		}
		if len(changes) > 0 {
			if err := tx.Model(&model.TheaterObjectModel{}).
				Where("room_id = ? AND id IN ?", roomID, changes).
				Update("coordinate_space", space).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeTheaterSnapshotCoordinateSpaces(snapshot *TheaterSharedSnapshot) error {
	objects := theaterDesignAllObjects(*snapshot)
	spaces, err := theaterObjectTreeCoordinateSpaces(objects)
	if err != nil {
		return err
	}
	for id, object := range objects {
		space := spaces[id]
		if space == TheaterObjectCoordinateSpaceWorld {
			if object.CoordinateSpace == "" && object.ViewportX == nil && object.ViewportY == nil {
				continue
			}
			object.CoordinateSpace, object.ViewportX, object.ViewportY = "", nil, nil
		} else {
			if object.CoordinateSpace == space {
				continue
			}
			object.CoordinateSpace = space
		}
		theaterDesignPutObject(snapshot, object)
	}
	return nil
}
