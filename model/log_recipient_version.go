package model

// Recipient changes affect design visibility even when whisper_to (the first
// recipient) remains unchanged. Updating the message and channel versions is
// part of the recipient statement, including raw SQL and bulk replacements.
func logRecipientTriggerSQL(dialect string) []string {
	bump := func(ref string) string {
		id := ref + ".message_id"
		guard := "EXISTS (SELECT 1 FROM messages WHERE id = " + id + " AND version >= 9007199254740991)"
		var sql string
		switch dialect {
		case "sqlite":
			sql = "SELECT CASE WHEN " + guard + " THEN RAISE(ABORT, 'LOG version overflow') END; "
		case "postgres":
			sql = "IF " + guard + " THEN RAISE EXCEPTION 'LOG version overflow'; END IF; "
		case "mysql":
			sql = "IF " + guard + " THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LOG version overflow'; END IF; "
		}
		sql += "UPDATE messages SET version = version + 1 WHERE id = " + id + "; "
		sql += "INSERT INTO log_channel_versions (channel_id, version) SELECT channel_id, 1 FROM messages WHERE id = " + id + " "
		if dialect == "mysql" {
			return sql + "ON DUPLICATE KEY UPDATE version = version + 1; "
		}
		return sql + "ON CONFLICT (channel_id) DO UPDATE SET version = log_channel_versions.version + 1; "
	}
	if dialect == "postgres" {
		return []string{
			`CREATE OR REPLACE FUNCTION log_recipient_source_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF TG_OP = 'INSERT' THEN ` + bump("NEW") + ` RETURN NEW; END IF;
			IF TG_OP = 'DELETE' THEN ` + bump("OLD") + ` RETURN OLD; END IF;
			IF OLD.message_id IS DISTINCT FROM NEW.message_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN ` + bump("OLD") + ` IF OLD.message_id IS DISTINCT FROM NEW.message_id THEN ` + bump("NEW") + ` END IF; END IF; RETURN NEW; END $$`,
			`DROP TRIGGER IF EXISTS log_recipient_source_v1 ON message_whisper_recipients`,
			`CREATE TRIGGER log_recipient_source_v1 AFTER INSERT OR UPDATE OR DELETE ON message_whisper_recipients FOR EACH ROW EXECUTE FUNCTION log_recipient_source_v1()`,
		}
	}
	out := []string{}
	for _, event := range []struct{ name, operation, ref string }{{"insert", "INSERT", "NEW"}, {"delete", "DELETE", "OLD"}, {"update", "UPDATE", "OLD"}} {
		name := "log_recipient_" + event.name + "_v1"
		body := bump(event.ref)
		when := ""
		if event.operation == "UPDATE" {
			if dialect == "sqlite" {
				when = " WHEN OLD.message_id IS NOT NEW.message_id OR OLD.user_id IS NOT NEW.user_id"
				// An UPDATE of message_id is not used by existing writers. The new
				// message still needs invalidation if a raw SQL writer moves a row.
				body += `SELECT CASE WHEN EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id AND OLD.message_id IS NOT NEW.message_id AND version >= 9007199254740991) THEN RAISE(ABORT, 'LOG version overflow') END;
				UPDATE messages SET version = version + 1 WHERE id = NEW.message_id AND OLD.message_id IS NOT NEW.message_id;
				INSERT INTO log_channel_versions (channel_id, version) SELECT channel_id, 1 FROM messages WHERE id = NEW.message_id AND OLD.message_id IS NOT NEW.message_id ON CONFLICT (channel_id) DO UPDATE SET version = log_channel_versions.version + 1;`
			} else {
				body = "IF NOT (OLD.message_id <=> NEW.message_id) OR NOT (OLD.user_id <=> NEW.user_id) THEN " + body + " IF NOT (OLD.message_id <=> NEW.message_id) THEN " + bump("NEW") + " END IF; END IF;"
			}
		}
		if dialect == "sqlite" {
			out = append(out, "CREATE TRIGGER IF NOT EXISTS "+name+" AFTER "+event.operation+" ON message_whisper_recipients"+when+" BEGIN "+body+" END")
		} else {
			out = append(out, "DROP TRIGGER IF EXISTS "+name, "CREATE TRIGGER "+name+" AFTER "+event.operation+" ON message_whisper_recipients FOR EACH ROW BEGIN "+body+" END")
		}
	}
	return out
}
