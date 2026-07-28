#!/usr/bin/env python3
"""Render a Markdown contract report into a self-contained HTML file.

优先使用 pandoc（--standalone --embed-resources）；缺少 pandoc 时自动降级：
1) Python `markdown` 库（含表格/目录扩展），CSS 内联，仍为自包含单文件；
2) 两者都不可用时，输出转义后的 <pre> 保底版本，保证内容不丢失。
任何情况下都不修改 Markdown 原稿。
"""
from __future__ import annotations

import argparse
import html
import shutil
import subprocess
import sys
from pathlib import Path

HTML_SHELL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body><div class="container">
<h1>{title}</h1>
{body}
</div></body>
</html>
"""


def render_with_pandoc(pandoc: str, args: argparse.Namespace) -> int:
    command = [
        pandoc, str(args.input), "--standalone", "--embed-resources",
        f"--css={args.css}", "--metadata", f"title={args.title}",
        "-o", str(args.output),
    ]
    completed = subprocess.run(command, text=True, capture_output=True)
    if completed.returncode:
        sys.stderr.write(completed.stderr)
    return completed.returncode


def render_with_python(args: argparse.Namespace) -> int:
    text = args.input.read_text(encoding="utf-8")
    css = args.css.read_text(encoding="utf-8") if args.css.is_file() else ""
    try:
        import markdown  # type: ignore

        body = markdown.markdown(
            text, extensions=["tables", "fenced_code", "toc", "sane_lists"]
        )
        note = ""
    except ImportError:
        body = "<pre>{}</pre>".format(html.escape(text))
        note = "fallback: python-markdown unavailable, emitted escaped <pre> version\n"
    args.output.write_text(
        HTML_SHELL.format(title=html.escape(args.title), css=css, body=body),
        encoding="utf-8",
    )
    if note:
        sys.stderr.write(note)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default="合同风险审查与优化报告")
    parser.add_argument(
        "--css", type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "report.css",
    )
    args = parser.parse_args()

    if not args.input.is_file():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)

    pandoc = shutil.which("pandoc")
    if pandoc:
        code = render_with_pandoc(pandoc, args)
        if code:
            print("pandoc failed, falling back to python renderer", file=sys.stderr)
            code = render_with_python(args)
    else:
        print("pandoc not found, using python renderer", file=sys.stderr)
        code = render_with_python(args)
    if code:
        return code

    if not args.output.is_file() or args.output.stat().st_size == 0:
        print("rendered HTML is empty", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
