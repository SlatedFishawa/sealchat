#!/usr/bin/env python3
"""Validate SealChat LOG StylePackage files with the backend validator."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from textwrap import dedent

GO_HELPER = dedent(
    r"""
    package main

    import (
        "encoding/json"
        "flag"
        "fmt"
        "io"
        "os"
        "path/filepath"
        "strings"

        "sealchat/service"
    )

    func main() {
        schema := flag.Bool("schema", false, "print generated package JSON Schema")
        file := flag.String("file", "", "full StylePackage JSON file; assets relative to its directory")
        flag.Parse()
        if *schema {
            b, err := service.LogStyleJSONSchema()
            check(err)
            fmt.Println(string(b))
            return
        }
        if *file == "" {
            fmt.Fprintln(os.Stderr, "usage: log-style-validate -file package.json | -schema")
            os.Exit(2)
        }
        f, err := os.Open(*file)
        check(err)
        defer f.Close()
        b, err := io.ReadAll(io.LimitReader(f, (50<<20)+1))
        check(err)
        if len(b) > 50<<20 {
            check(fmt.Errorf("package too large"))
        }
        var p service.LogStylePackage
        d := json.NewDecoder(strings.NewReader(string(b)))
        d.DisallowUnknownFields()
        check(d.Decode(&p))
        var extra any
        if d.Decode(&extra) != io.EOF {
            check(fmt.Errorf("trailing JSON"))
        }
        if len(p.Assets) > 200 {
            check(fmt.Errorf("too many assets"))
        }
        assets := map[string][]byte{}
        total := 0
        for _, a := range p.Assets {
            if !strings.HasPrefix(a.Path, "assets/") || strings.Contains(a.Path, "..") || strings.ContainsAny(a.Path, "\\:") {
                check(fmt.Errorf("invalid asset path"))
            }
            assetPath := filepath.Join(filepath.Dir(*file), a.Path)
            info, err := os.Lstat(assetPath)
            check(err)
            if !info.Mode().IsRegular() || info.Size() > int64((50<<20)-total) {
                check(fmt.Errorf("invalid asset or size limit"))
            }
            b, err := os.ReadFile(assetPath)
            check(err)
            total += len(b)
            if total > 50<<20 {
                check(fmt.Errorf("assets too large"))
            }
            assets[a.ID] = b
        }
        check(service.ValidateLogStyle(&p, assets))
        fmt.Println("valid")
    }

    func check(err error) {
        if err != nil {
            fmt.Fprintln(os.Stderr, err)
            os.Exit(1)
        }
    }
    """
).lstrip()


def repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here, *here.parents):
        if (candidate / "go.mod").is_file():
            return candidate
    raise RuntimeError("cannot find repository root (go.mod)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a SealChat LOG StylePackage with service.ValidateLogStyle."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-schema", "--schema", action="store_true", help="print generated package JSON Schema")
    group.add_argument("-file", "--file", metavar="PATH", help="validate a full StylePackage JSON file")
    args = parser.parse_args()

    root = repo_root()
    helper_path: Path | None = None
    try:
        fd, helper_name = tempfile.mkstemp(prefix="log_style_validate_", suffix=".go", dir=root)
        os.close(fd)
        helper_path = Path(helper_name)
        helper_path.write_text(GO_HELPER, encoding="utf-8")

        helper_args = ["-schema"] if args.schema else ["-file", str(Path(args.file).resolve())]
        try:
            completed = subprocess.run(
                ["go", "run", str(helper_path), *helper_args],
                cwd=root,
                check=False,
            )
        except FileNotFoundError:
            print("go executable not found", file=sys.stderr)
            return 1
        return completed.returncode
    finally:
        if helper_path is not None:
            try:
                helper_path.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
