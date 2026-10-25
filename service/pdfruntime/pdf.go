// Package pdfruntime drives optional external PDF tools: a Chromium-family browser
// (preferably chrome-headless-shell) for rendering and pdfunite/qpdf for merging.
// Nothing here is bundled or downloaded; every binary is configured by a platform
// administrator or discovered on the local machine, and always executed through an
// argument array (never a shell).
package pdfruntime

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// MinPDFSize is the smallest file accepted as a real PDF; anything shorter is
// treated as truncated output.
const MinPDFSize = 200

var (
	ErrPDFMissing   = errors.New("PDF 文件不存在")
	ErrPDFTooSmall  = errors.New("PDF 文件过小")
	ErrPDFNotPDF    = errors.New("文件不是 PDF")
	ErrPDFTruncated = errors.New("PDF 文件不完整（缺少 %%EOF）")
)

// ValidatePDFFile performs the minimal structural check required before a file is
// renamed into place: it exists, has a plausible size, starts with %PDF- and has
// %%EOF near its end. It is not a full parser.
func ValidatePDFFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrPDFMissing
		}
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return ErrPDFMissing
	}
	size := info.Size()
	if size < MinPDFSize {
		return ErrPDFTooSmall
	}
	head := make([]byte, 5)
	if _, err := io.ReadFull(f, head); err != nil {
		return ErrPDFNotPDF
	}
	if string(head) != "%PDF-" {
		return ErrPDFNotPDF
	}
	tailSize := int64(2048)
	if size < tailSize {
		tailSize = size
	}
	tail := make([]byte, tailSize)
	if _, err := f.ReadAt(tail, size-tailSize); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if !bytes.Contains(tail, []byte("%%EOF")) {
		return ErrPDFTruncated
	}
	return nil
}

// MinimalPDF builds a small, valid single-page PDF. It is used for merger smoke
// tests so that probing never depends on the browser.
func MinimalPDF(text string) []byte {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '(' || r == ')' || r == '\\' {
			return ' '
		}
		return r
	}, text)
	stream := fmt.Sprintf("BT /F1 18 Tf 72 720 Td (%s) Tj ET", text)
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for i, obj := range objects {
		offsets[i] = buf.Len()
		buf.WriteString(strconv.Itoa(i+1) + " 0 obj\n" + obj + "\nendobj\n")
	}
	xref := buf.Len()
	buf.WriteString(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", len(objects)+1))
	for _, off := range offsets {
		buf.WriteString(fmt.Sprintf("%010d 00000 n \n", off))
	}
	buf.WriteString(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref))
	return buf.Bytes()
}
