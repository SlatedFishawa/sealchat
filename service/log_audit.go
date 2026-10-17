package service

import "log"

// Audit only routing identifiers and counts; never bodies, queries or asset URLs.
func logAudit(action, actor, project, job, code string, version, count int64) {
	log.Printf("LOG action=%q actor=%q project=%q job=%q code=%q version=%d count=%d", action, actor, project, job, code, version, count)
}
