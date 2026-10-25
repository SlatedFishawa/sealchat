//go:build windows

package pdfruntime

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func configureProcess(cmd *exec.Cmd) {
	// Start suspended: Chromium cannot create helpers before it belongs to our Job.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
}

func startProcess(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	closeJob := func() {
		mu.Lock()
		defer mu.Unlock()
		if job != 0 {
			_ = windows.CloseHandle(job) // KILL_ON_JOB_CLOSE includes surviving helpers.
			job = 0
		}
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		closeJob()
		return nil, err
	}
	cmd.Cancel = func() error {
		mu.Lock()
		defer mu.Unlock()
		if job == 0 {
			return os.ErrProcessDone
		}
		return windows.TerminateJobObject(job, 1)
	}
	// CommandContext may cancel immediately after Start. Serialize that callback
	// with assignment/resume so it cannot terminate an empty Job and miss the child.
	mu.Lock()
	if err := cmd.Start(); err != nil {
		mu.Unlock()
		closeJob()
		return nil, err
	}
	fail := func(err error) (func(), error) {
		// Assignment/resume errors must never leave an unowned suspended process.
		_ = cmd.Process.Kill()
		mu.Unlock()
		closeJob()
		_ = cmd.Wait()
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fail(err)
	}
	err = windows.AssignProcessToJobObject(job, process)
	_ = windows.CloseHandle(process)
	if err != nil {
		return fail(fmt.Errorf("assign process to PDF Job Object: %w", err))
	}
	if err := resumeProcessThread(uint32(cmd.Process.Pid)); err != nil {
		return fail(err)
	}
	mu.Unlock()
	return closeJob, nil
}

// exec.Cmd owns the process handle; Toolhelp obtains the initial thread handle
// that Go closes during Start. The process is still suspended and has no helpers.
func resumeProcessThread(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		_ = windows.CloseHandle(thread)
		return err
	}
	return fmt.Errorf("find suspended PDF process thread: %w", err)
}
