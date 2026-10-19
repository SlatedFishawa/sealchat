package service

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"path"
	"strings"
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"sealchat/model"
)

// New projects and releases without a bound style use this shipped builtin version.
const (
	logDefaultStyleID      = "sealchat-starter"
	logDefaultStyleVersion = "1.1.0"
)

// Canonical source artifacts: frontend reads the registered versions through REST.
//
//go:embed log_styles
var logBuiltinFiles embed.FS

// logCanonicalBuiltinIDs lists the builtin packages shipped by this build. A builtin
// retired from log_styles keeps its stored versions, so existing bindings, releases,
// forks and exports still resolve it, but it no longer appears in the style library.
var logCanonicalBuiltinIDs = sync.OnceValue(func() []string {
	ids := []string{}
	entries, _ := fs.ReadDir(logBuiltinFiles, "log_styles")
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		b, err := logBuiltinFiles.ReadFile("log_styles/" + entry.Name())
		if err != nil {
			continue
		}
		var p struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(b, &p) == nil && p.ID != "" {
			ids = append(ids, p.ID)
		}
	}
	return ids
})

func RegisterBuiltinLogStyles() error {
	entries, err := fs.ReadDir(logBuiltinFiles, "log_styles")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		b, err := logBuiltinFiles.ReadFile("log_styles/" + entry.Name())
		if err != nil {
			return err
		}
		var p LogStylePackage
		if err := logStrictJSON(b, &p); err != nil {
			return err
		}
		assets := map[string][]byte{}
		for _, a := range p.Assets {
			if !logAssetPath(a.Path) {
				return logTemplateError()
			}
			data, err := logBuiltinFiles.ReadFile(path.Join("log_styles", a.Path))
			if err != nil {
				return err
			}
			assets[a.ID] = data
		}
		if err := ValidateLogStyle(&p, assets); err != nil {
			return err
		}
		err = model.GetDB().Transaction(func(tx *gorm.DB) error {
			row := model.LogStylePackageModel{Name: p.Name, Builtin: true, LatestVersion: p.Version}
			row.Init()
			row.ID = p.ID
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
				return err
			}
			var stored model.LogStylePackageModel
			if err := tx.Where("id = ?", p.ID).Take(&stored).Error; err != nil {
				return err
			}
			if !stored.Builtin {
				return logError("VERSION_CONFLICT", "内置样式 "+p.ID+" 与已有非内置样式标识冲突")
			}
			var version model.LogStyleVersionModel
			err := tx.Where("package_id = ? AND version = ?", p.ID, p.Version).Take(&version).Error
			if err == nil {
				canonical, _ := json.Marshal(&p)
				if !bytes.Equal(canonical, []byte(version.PackageJSON)) {
					return logError("VERSION_CONFLICT", "内置样式 "+p.ID+"@"+p.Version+" 内容已变更，必须升级 version")
				}
				return nil
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err := logStoreStyle(tx, &p, assets); err != nil {
				return err
			}
			if stored.LatestVersion == p.Version || logVersionAfter(p.Version, stored.LatestVersion) {
				return tx.Model(&stored).Updates(map[string]any{"latest_version": p.Version, "name": p.Name}).Error
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
