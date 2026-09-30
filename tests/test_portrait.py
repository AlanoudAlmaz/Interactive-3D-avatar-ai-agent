import json
from pathlib import Path

ASSET = Path(__file__).resolve().parents[1] / "static" / "avatar" / "zayed.json"


def test_portrait_asset_is_consistent():
    data = json.loads(ASSET.read_text())
    count = len(data["vertices"]) // 2
    assert len(data["vertices"]) == len(data["uv"]) == count * 2
    assert len(data["head"]) == count
    assert set(data["bases"]) == {"jaw", "wide", "round", "blinkL", "blinkR"}
    assert all(len(basis) == count * 2 for basis in data["bases"].values())
    triangles = data["triangles"]
    assert len(triangles) % 3 == 0 and 0 <= min(triangles) and max(triangles) < count
    mouth = set(data["mouth"]["upper"] + data["mouth"]["lower"])
    assert all(i < count for i in mouth)
    assert (ASSET.with_suffix(".webp")).stat().st_size > 0


def test_default_avatar_is_portrait(monkeypatch):
    monkeypatch.delenv("ZAYED_AVATAR_URL", raising=False)
    from zayed.config import Settings

    assert Settings().avatar_url == "/static/avatar/zayed.json"
