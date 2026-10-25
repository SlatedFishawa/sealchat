package pdfruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Merger identifies a probed PDF merge tool.
type Merger struct {
	Path    string
	Kind    string
	Version string
}

// PDFMerger concatenates complete PDFs in order.
type PDFMerger interface {
	Merge(ctx context.Context, inputs []string, output string) error
}

// CLIMerger runs pdfunite or qpdf with an argument array.
type CLIMerger struct {
	Merger Merger
	Runner CommandRunner
}

// MergeArgs returns the argument list for merging inputs into output.
func MergeArgs(kind string, inputs []string, output string) ([]string, error) {
	switch kind {
	case MergerPDFUnite:
		args := append([]string{}, inputs...)
		return append(args, output), nil
	case MergerQPDF:
		args := []string{"--empty", "--pages"}
		args = append(args, inputs...)
		return append(args, "--", output), nil
	default:
		return nil, fmt.Errorf("不支持的 PDF 合并工具")
	}
}

func (m *CLIMerger) runner() CommandRunner {
	if m.Runner != nil {
		return m.Runner
	}
	return ExecRunner{}
}

func (m *CLIMerger) Merge(ctx context.Context, inputs []string, output string) error {
	if len(inputs) == 0 {
		return errors.New("没有可合并的 PDF")
	}
	for _, in := range inputs {
		// Inputs are adapter-owned absolute paths; refuse anything that a tool could
		// parse as an option.
		if !filepath.IsAbs(in) || strings.HasPrefix(filepath.Base(in), "-") {
			return errors.New("合并输入路径无效")
		}
	}
	if !filepath.IsAbs(output) {
		return errors.New("合并输出路径无效")
	}
	args, err := MergeArgs(m.Merger.Kind, inputs, output)
	if err != nil {
		return err
	}
	out, err := m.runner().Run(ctx, m.Merger.Path, args...)
	if err != nil {
		// qpdf exits with 3 when it succeeded with warnings.
		if code, ok := exitCodeOf(err); ok && code == 3 && m.Merger.Kind == MergerQPDF && ValidatePDFFile(output) == nil {
			return nil
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("PDF 合并超时")
		}
		if msg := summarizeOutput(out); msg != "" {
			return fmt.Errorf("PDF 合并失败: %v（%s）", err, msg)
		}
		return fmt.Errorf("PDF 合并失败: %w", err)
	}
	return ValidatePDFFile(output)
}

func mergerVersionArgs(kind string) []string {
	if kind == MergerPDFUnite {
		return []string{"-v"}
	}
	return []string{"--version"}
}

// ProbeMerger checks a merger candidate: its version command and a real merge of
// two generated one-page PDFs.
func ProbeMerger(ctx context.Context, runner CommandRunner, c Candidate, workDir string) (Merger, error) {
	m := Merger{Path: c.Path, Kind: c.Kind}
	if m.Kind == "" {
		return m, errors.New("无法识别的合并工具（仅支持 pdfunite / qpdf）")
	}
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	out, err := runner.Run(vctx, c.Path, mergerVersionArgs(m.Kind)...)
	cancel()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return m, errors.New("版本探测超时")
		}
		return m, fmt.Errorf("版本命令失败: %v", err)
	}
	m.Version = firstLine(out)
	if !strings.Contains(strings.ToLower(m.Version), m.Kind) {
		return m, fmt.Errorf("版本输出不符合 %s", m.Kind)
	}
	if workDir == "" {
		workDir = os.TempDir()
	}
	// MkdirTemp preserves relative paths, but the merger requires absolute inputs.
	workDir, err = filepath.Abs(workDir)
	if err != nil {
		return m, fmt.Errorf("解析 PDF 合并探测目录: %w", err)
	}
	dir, err := os.MkdirTemp(workDir, "merge-smoke-")
	if err != nil {
		return m, err
	}
	defer os.RemoveAll(dir)
	a, b := filepath.Join(dir, "a.pdf"), filepath.Join(dir, "b.pdf")
	if err := os.WriteFile(a, MinimalPDF("SealChat merge smoke A"), 0o600); err != nil {
		return m, err
	}
	if err := os.WriteFile(b, MinimalPDF("SealChat merge smoke B"), 0o600); err != nil {
		return m, err
	}
	sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	merger := &CLIMerger{Merger: m, Runner: runner}
	if err := merger.Merge(sctx, []string{a, b}, filepath.Join(dir, "out.pdf")); err != nil {
		return m, fmt.Errorf("合并冒烟测试失败: %v", err)
	}
	return m, nil
}

func firstLine(out []byte) string {
	s := strings.TrimSpace(string(out))
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return strings.TrimSpace(s)
}
