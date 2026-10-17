package model

import (
	"fmt"
	"strings"

	"gorm.io/gorm"
)

// The database tracks every writer, including imports, bulk SQL and legacy
// clients. Triggers run in the source statement's transaction even when GORM's
// SkipDefaultTransaction is enabled. TTS/reactions/pins are deliberately absent.
type LogChannelVersionModel struct {
	ChannelID string `gorm:"primaryKey;size:100"`
	Version   int64  `gorm:"not null;default:1"`
}

func (*LogChannelVersionModel) TableName() string { return "log_channel_versions" }

const logSafeVersion = 9007199254740991

var logSourceColumns = []string{
	"content", "created_at", "channel_id", "user_id", "quote_id", "display_order", "is_revoked", "is_deleted", "is_whisper", "whisper_to", "ic_mode", "is_archived",
	"sender_member_name", "sender_identity_id", "sender_shared_identity_id", "sender_identity_variant_id", "sender_identity_name", "sender_identity_color", "sender_identity_avatar_id", "sender_identity_decoration", "sender_theater_presentation", "sender_identity_is_temporary", "sender_role_id",
}

func MigrateLogSourceVersions(db *gorm.DB) error {
	if err := db.AutoMigrate(&LogChannelVersionModel{}); err != nil {
		return err
	}
	if err := RunSchemaMigration(db, "log_message_versions_backfill_v1", func() error {
		return db.Model(&MessageModel{}).Where("version IS NULL OR version < 1").UpdateColumn("version", 1).Error
	}); err != nil {
		return err
	}
	// Trigger definitions are a versioned schema migration, not request-time DDL.
	install := func() error {
		statements, err := logSourceTriggerSQL(db.Dialector.Name())
		if err != nil {
			return err
		}
		if db.Migrator().HasTable(&MessageWhisperRecipientModel{}) {
			statements = append(statements, logRecipientTriggerSQL(db.Dialector.Name())...)
		}
		for _, sql := range statements {
			if err := db.Exec(sql).Error; err != nil {
				return err
			}
		}
		return nil
	}
	// SQLite AutoMigrate may rebuild messages and discard its triggers. Restore
	// missing schema objects on every startup without repeating historical data work.
	if db.Dialector.Name() == "sqlite" {
		return install()
	}
	return RunSchemaMigration(db, "log_source_version_triggers_v1", install)
}

func logSourceTriggerSQL(dialect string) ([]string, error) {
	var changes []string
	for _, column := range logSourceColumns {
		switch dialect {
		case "sqlite":
			changes = append(changes, "OLD."+column+" IS NOT NEW."+column)
		case "postgres":
			changes = append(changes, "OLD."+column+" IS DISTINCT FROM NEW."+column)
		case "mysql":
			changes = append(changes, "NOT (OLD."+column+" <=> NEW."+column+")")
		default:
			return nil, fmt.Errorf("unsupported LOG database dialect: %s", dialect)
		}
	}
	changed := strings.Join(changes, " OR ")
	bump := func(ref string) string {
		base := "INSERT INTO log_channel_versions (channel_id, version) VALUES (" + ref + ".channel_id, 1) "
		if dialect == "mysql" {
			return base + "ON DUPLICATE KEY UPDATE version = version + 1;"
		}
		return base + "ON CONFLICT (channel_id) DO UPDATE SET version = log_channel_versions.version + 1;"
	}
	switch dialect {
	case "sqlite":
		return []string{
			`CREATE TRIGGER IF NOT EXISTS log_message_insert_v1 AFTER INSERT ON messages BEGIN ` + bump("NEW") + ` END`,
			`CREATE TRIGGER IF NOT EXISTS log_message_update_v1 AFTER UPDATE OF ` + strings.Join(logSourceColumns, ",") + ` ON messages WHEN ` + changed + ` BEGIN
			SELECT CASE WHEN OLD.version >= 9007199254740991 THEN RAISE(ABORT, 'LOG version overflow') END;
			UPDATE messages SET version = OLD.version + 1 WHERE id = NEW.id; ` + bump("NEW") + `
			INSERT INTO log_channel_versions (channel_id, version) SELECT OLD.channel_id, 1 WHERE OLD.channel_id IS NOT NEW.channel_id ON CONFLICT (channel_id) DO UPDATE SET version = log_channel_versions.version + 1; END`,
			`CREATE TRIGGER IF NOT EXISTS log_message_delete_v1 AFTER DELETE ON messages BEGIN ` + bump("OLD") + ` END`,
			`CREATE TRIGGER IF NOT EXISTS log_channel_version_guard_v1 BEFORE UPDATE ON log_channel_versions WHEN NEW.version > 9007199254740991 BEGIN SELECT RAISE(ABORT, 'LOG source version overflow'); END`,
		}, nil
	case "postgres":
		return []string{
			`CREATE OR REPLACE FUNCTION log_message_version_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ` + changed + ` THEN IF OLD.version >= 9007199254740991 THEN RAISE EXCEPTION 'LOG version overflow'; END IF; NEW.version := OLD.version + 1; END IF; RETURN NEW; END $$`,
			`CREATE OR REPLACE FUNCTION log_message_source_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF TG_OP = 'DELETE' THEN ` + bump("OLD") + ` RETURN OLD; END IF;
			IF TG_OP = 'INSERT' THEN ` + bump("NEW") + ` RETURN NEW; END IF;
			IF ` + changed + ` THEN ` + bump("NEW") + ` IF OLD.channel_id IS DISTINCT FROM NEW.channel_id THEN ` + bump("OLD") + ` END IF; END IF; RETURN NEW; END $$`,
			`CREATE OR REPLACE FUNCTION log_source_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version > 9007199254740991 THEN RAISE EXCEPTION 'LOG source version overflow'; END IF; RETURN NEW; END $$`,
			`DROP TRIGGER IF EXISTS log_message_version_v1 ON messages`,
			`CREATE TRIGGER log_message_version_v1 BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION log_message_version_v1()`,
			`DROP TRIGGER IF EXISTS log_message_source_v1 ON messages`,
			`CREATE TRIGGER log_message_source_v1 AFTER INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION log_message_source_v1()`,
			`DROP TRIGGER IF EXISTS log_source_guard_v1 ON log_channel_versions`,
			`CREATE TRIGGER log_source_guard_v1 BEFORE UPDATE ON log_channel_versions FOR EACH ROW EXECUTE FUNCTION log_source_guard_v1()`,
		}, nil
	case "mysql":
		return []string{
			`DROP TRIGGER IF EXISTS log_message_insert_v1`,
			`CREATE TRIGGER log_message_insert_v1 AFTER INSERT ON messages FOR EACH ROW BEGIN ` + bump("NEW") + ` END`,
			`DROP TRIGGER IF EXISTS log_message_update_v1`,
			`CREATE TRIGGER log_message_update_v1 BEFORE UPDATE ON messages FOR EACH ROW BEGIN IF ` + changed + ` THEN IF OLD.version >= 9007199254740991 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LOG version overflow'; END IF; SET NEW.version = OLD.version + 1; ` + bump("NEW") + ` IF NOT (OLD.channel_id <=> NEW.channel_id) THEN ` + bump("OLD") + ` END IF; END IF; END`,
			`DROP TRIGGER IF EXISTS log_message_delete_v1`,
			`CREATE TRIGGER log_message_delete_v1 AFTER DELETE ON messages FOR EACH ROW BEGIN ` + bump("OLD") + ` END`,
			`DROP TRIGGER IF EXISTS log_source_guard_v1`,
			`CREATE TRIGGER log_source_guard_v1 BEFORE UPDATE ON log_channel_versions FOR EACH ROW BEGIN IF NEW.version > 9007199254740991 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LOG source version overflow'; END IF; END`,
		}, nil
	}
	return nil, fmt.Errorf("unsupported LOG database dialect: %s", dialect)
}
