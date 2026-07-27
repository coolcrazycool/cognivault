"""Unit tests for app.confluence.store and the GET /config secret guarantee."""

from __future__ import annotations

import asyncio
import os
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import AppPaths  # noqa: E402
from app.confluence import store  # noqa: E402


def _paths(tmp_path) -> AppPaths:
    return AppPaths(root=tmp_path / ".cognivault-ui")


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #


def test_load_config_defaults(tmp_path):
    cfg = store.load_config(_paths(tmp_path))
    assert cfg == store.DEFAULT_CONFLUENCE_CONFIG
    # a fresh copy, not the module-level default
    assert cfg is not store.DEFAULT_CONFLUENCE_CONFIG


def test_save_config_merges_and_persists(tmp_path):
    paths = _paths(tmp_path)
    store.save_config(paths, {"base_url": "https://c.example.com", "auth_mode": "pat"})
    store.save_config(paths, {"root_url": "https://c.example.com/x?pageId=1"})
    cfg = store.load_config(paths)
    assert cfg["base_url"] == "https://c.example.com"
    assert cfg["auth_mode"] == "pat"
    assert cfg["root_url"] == "https://c.example.com/x?pageId=1"
    # untouched defaults still present
    assert cfg["verify_ssl"] is True


# --------------------------------------------------------------------------- #
# secret: 0600 + roundtrip
# --------------------------------------------------------------------------- #


def test_save_secret_file_mode_0600(tmp_path):
    paths = _paths(tmp_path)
    store.save_secret(paths, {"pat": "tok"})
    secret_file = paths.confluence_dir / "secret.json"
    assert secret_file.is_file()
    mode = stat.S_IMODE(os.stat(secret_file).st_mode)
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_secret_roundtrip(tmp_path):
    paths = _paths(tmp_path)
    store.save_secret(paths, {"password": "p@ss", "pat": ""})
    assert store.load_secret(paths) == {"password": "p@ss", "pat": ""}


def test_load_secret_missing_is_empty(tmp_path):
    assert store.load_secret(_paths(tmp_path)) == {}


# --------------------------------------------------------------------------- #
# manifest
# --------------------------------------------------------------------------- #


def test_manifest_roundtrip(tmp_path):
    paths = _paths(tmp_path)
    assert store.load_manifest(paths) == {}
    store.save_manifest(paths, {"meta": {"page_count": 3, "root_title": "R"}})
    assert store.load_manifest(paths)["meta"]["page_count"] == 3


# --------------------------------------------------------------------------- #
# redact
# --------------------------------------------------------------------------- #


def test_redact_masks_secrets():
    line = "url=https://token:s3cr3t@host/path pat=abc123"
    out = store.redact(line, "s3cr3t", "abc123", "")
    assert "s3cr3t" not in out
    assert "abc123" not in out
    assert out.count("***") == 2


# --------------------------------------------------------------------------- #
# GET /config never returns the secret
# --------------------------------------------------------------------------- #


def test_get_config_route_never_returns_secret(tmp_path, monkeypatch):
    from app import settings
    from app.routes import confluence_routes

    paths = _paths(tmp_path)
    store.save_config(paths, {"base_url": "https://c.example.com", "login": "alice"})
    store.save_secret(paths, {"password": "topsecret", "pat": "patsecret"})

    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(confluence_routes, "resolve_paths", lambda request: paths)

    public = asyncio.run(confluence_routes.get_config(request=None))

    assert public["has_password"] is True
    assert public["has_pat"] is True
    assert "password" not in public
    assert "pat" not in public
    assert "topsecret" not in str(public)
    assert "patsecret" not in str(public)
    assert public["base_url"] == "https://c.example.com"
    assert public["login"] == "alice"
