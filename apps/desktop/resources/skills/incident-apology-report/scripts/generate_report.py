#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《故障/异常情况说明及致歉报告》Word 文档。

用法:
    python3 generate_report.py content.json -o 报告.docx

content.json 的结构见 references/content-schema.md。

缺少 python-docx 时自动降级：输出同名 .md 而非 .docx，退出码仍为 0。
本技能随 Cortex Desktop 内置分发，而 macOS 12.3+ 已不自带 python3、python-docx
更需 pip 单独安装——故障场景往往很急，给一份能直接粘进邮件的 Markdown，
远好过甩用户一个 ModuleNotFoundError。降级提示里带修复命令，装一次即可长期生效。
"""
import argparse
import json
import os
import sys

# python-docx 缺席时不能让 import 直接炸：置 DOCX_AVAILABLE=False 走 Markdown 降级。
# 注意 add_para 的默认参数原本引用 WD_ALIGN_PARAGRAPH.JUSTIFY，那是 def 时求值的，
# 缺库时会在函数定义处就抛 NameError——故默认值改为 None，在函数体内再回落到 JUSTIFY。
try:
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor

    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

CN_NUMS = "一二三四五六七八九十"

BODY_FONT = "宋体"
HEADING_FONT = "黑体"


def cn_index(i: int) -> str:
    """1 -> 一, 11 -> 十一 (足够覆盖章节数)。"""
    if i <= 10:
        return CN_NUMS[i - 1]
    return "十" + CN_NUMS[i - 11]


def set_font(run, name=BODY_FONT, size=12, bold=False, color=None):
    run.font.name = "Times New Roman"
    run.font.size = Pt(size)
    run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = rPr.makeelement(qn("w:rFonts"), {})
        rPr.append(rFonts)
    rFonts.set(qn("w:eastAsia"), name)


def add_para(doc, text, font=BODY_FONT, size=12, bold=False,
             align=None, indent=True,
             space_before=0, space_after=6):
    p = doc.add_paragraph()
    # align=None 表示「用默认的两端对齐」。不能把 WD_ALIGN_PARAGRAPH.JUSTIFY 写进默认参数——
    # 默认参数在 def 时求值，缺 python-docx 时该名字不存在，函数定义本身就会失败。
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY if align is None else align
    pf = p.paragraph_format
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.5
    if indent:
        pf.first_line_indent = Pt(size * 2)  # 首行缩进2字符
    run = p.add_run(text)
    set_font(run, font, size, bold)
    return p


def add_timeline_table(doc, timeline):
    table = doc.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    widths = (Cm(4.2), Cm(11.0))
    hdr = table.rows[0].cells
    for cell, text in zip(hdr, ("时间", "处理情况")):
        cell.width = widths[0] if text == "时间" else widths[1]
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(text)
        set_font(run, HEADING_FONT, 11, bold=True)
    for item in timeline:
        row = table.add_row().cells
        for cell, text, w, center in (
            (row[0], item.get("time", ""), widths[0], True),
            (row[1], item.get("event", ""), widths[1], False),
        ):
            cell.width = w
            p = cell.paragraphs[0]
            p.alignment = (WD_ALIGN_PARAGRAPH.CENTER if center
                           else WD_ALIGN_PARAGRAPH.LEFT)
            run = p.add_run(text)
            set_font(run, BODY_FONT, 11)
    # 表格后留白
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = 1.0
    r = spacer.add_run("")
    set_font(r, BODY_FONT, 6)


def build(data: dict, out_path: str):
    doc = Document()
    # 页面边距 (A4 默认, 调整边距接近公文)
    for section in doc.sections:
        section.top_margin = Cm(2.8)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.8)
        section.right_margin = Cm(2.6)

    # 标题
    add_para(doc, data["title"], font=HEADING_FONT, size=16, bold=True,
             align=WD_ALIGN_PARAGRAPH.CENTER, indent=False,
             space_before=6, space_after=12)

    # 编号（可选）
    if data.get("doc_number"):
        add_para(doc, data["doc_number"], size=10.5,
                 align=WD_ALIGN_PARAGRAPH.RIGHT, indent=False,
                 space_after=10)

    # 称呼
    add_para(doc, data["salutation"], size=12, indent=False, space_after=4)

    # 首段
    add_para(doc, data["opening"], size=12, space_after=8)

    # 章节
    for i, sec in enumerate(data.get("sections", []), start=1):
        add_para(doc, f"{cn_index(i)}、{sec['heading']}",
                 font=HEADING_FONT, size=13, bold=True, indent=False,
                 align=WD_ALIGN_PARAGRAPH.LEFT,
                 space_before=8, space_after=4)
        for para in sec.get("paragraphs", []) or []:
            add_para(doc, para, size=12)
        if sec.get("items"):
            for j, item in enumerate(sec["items"], start=1):
                add_para(doc, f"{j}. {item}", size=12)
        if sec.get("timeline"):
            add_timeline_table(doc, sec["timeline"])

    # 落款
    sig = data["signature"]
    add_para(doc, sig["company"], size=12, bold=False,
             align=WD_ALIGN_PARAGRAPH.RIGHT, indent=False,
             space_before=18, space_after=2)
    for line in sig.get("extra", []) or []:
        add_para(doc, line, size=11,
                 align=WD_ALIGN_PARAGRAPH.RIGHT, indent=False, space_after=2)
    add_para(doc, sig["date"], size=12,
             align=WD_ALIGN_PARAGRAPH.RIGHT, indent=False, space_after=0)

    doc.save(out_path)
    print(f"已生成: {out_path}")


def render_markdown(data: dict) -> str:
    """把同一份 content.json 渲染成 Markdown（缺 python-docx 时的降级产物）。

    章节顺序、中文序号、时间线表格、落款次序都与 Word 版一致，只是丢掉了公文排版
    （字体/行距/缩进/页边距）——保证用户拿到的内容一字不少，可直接粘进邮件。
    """
    out = [f"# {data['title']}", ""]
    if data.get("doc_number"):
        out += [data["doc_number"], ""]
    out += [data["salutation"], "", data["opening"], ""]

    for i, sec in enumerate(data.get("sections", []), start=1):
        out += [f"## {cn_index(i)}、{sec['heading']}", ""]
        for para in sec.get("paragraphs", []) or []:
            out += [para, ""]
        if sec.get("items"):
            for j, item in enumerate(sec["items"], start=1):
                out.append(f"{j}. {item}")
            out.append("")
        if sec.get("timeline"):
            out += ["| 时间 | 处理情况 |", "| --- | --- |"]
            for row in sec["timeline"]:
                # 单元格内的竖线会破坏 Markdown 表格结构，转义掉。
                time = str(row.get("time", "")).replace("|", "\\|")
                event = str(row.get("event", "")).replace("|", "\\|")
                out.append(f"| {time} | {event} |")
            out.append("")

    sig = data["signature"]
    out += ["---", "", sig["company"]]
    for line in sig.get("extra", []) or []:
        out.append(line)
    out += [sig["date"], ""]
    return "\n".join(out)


def build_markdown_fallback(data: dict, out_path: str) -> str:
    """降级出 Markdown，返回实际落盘路径（把 .docx 后缀换成 .md）。"""
    base, ext = os.path.splitext(out_path)
    md_path = f"{base}.md" if ext.lower() == ".docx" else f"{out_path}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_markdown(data))
    return md_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("content", help="content.json 路径")
    ap.add_argument("-o", "--output", default="故障情况说明及致歉报告.docx")
    args = ap.parse_args()

    with open(args.content, encoding="utf-8") as f:
        data = json.load(f)

    missing = [k for k in ("title", "salutation", "opening", "signature")
               if k not in data]
    if missing:
        sys.exit(f"content.json 缺少必填字段: {', '.join(missing)}")
    if not data.get("sections"):
        sys.exit("content.json 至少需要一个章节 (sections)")

    # 降级路径以退出码 0 结束：内容已完整交付，缺的只是 Word 排版。调用方（agent）
    # 须把下面这段提示原样转达用户，不要假装交付了 .docx。
    if not DOCX_AVAILABLE:
        md_path = build_markdown_fallback(data, args.output)
        print(f"已生成: {md_path}")
        print("未检测到 python-docx，已输出 Markdown 版本；"
              "如需 Word 文档请执行 `pip3 install python-docx` 后重跑。")
        return

    build(data, args.output)


if __name__ == "__main__":
    main()
