import pytest
from conftest import make_docx, make_pptx, make_xlsx

from zayed.documents import UnsupportedDocument, extract, kind_for


def test_kind_for():
    assert kind_for("a.PDF") == "pdf"
    assert kind_for("deck.pptx") == "pptx"
    assert kind_for("x.csv") == "sheet"
    assert kind_for("photo.JPG") == "image"
    with pytest.raises(UnsupportedDocument):
        kind_for("malware.exe")


def test_docx_sections_follow_headings():
    doc = extract(
        make_docx([("h1", "Overview"), ("p", "Alpha text."), ("h1", "Details"), ("p", "Beta text.")]), "r.docx"
    )
    assert doc.kind == "docx"
    labels = [s.label for s in doc.sections]
    assert "Overview" in labels and "Details" in labels
    assert "<p>" in doc.preview["html"]


def test_pptx_one_section_per_slide():
    doc = extract(make_pptx(["Intro", "Roadmap"]), "d.pptx")
    assert doc.kind == "pptx"
    assert len(doc.preview["slides"]) == 2
    assert "Roadmap" in doc.sections[1].text


def test_xlsx_and_csv_tables():
    doc = extract(make_xlsx([["Dept", "Q1"], ["IT", 200]]), "b.xlsx")
    assert doc.preview["sheets"][0]["name"] == "Budget"
    assert "IT" in doc.text
    csv = extract(b"name,value\nfoo,1\n", "t.csv")
    assert csv.preview["sheets"][0]["rows"][1] == ["foo", "1"]


def test_text_markdown_and_json():
    assert "hello" in extract(b"hello world", "a.txt").text
    md = extract(b"# Title\n\nBody", "a.md")
    assert "<h1>" in md.preview["html"]
    js = extract(b'{"a": 1}', "a.json")
    assert '"a"' in js.text


def test_image_has_no_text():
    doc = extract(b"\x89PNG\r\n\x1a\n" + b"0" * 20, "p.png")
    assert doc.kind == "image" and not doc.text.strip()
