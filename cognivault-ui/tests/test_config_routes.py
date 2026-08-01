"""Route tests for ``GET`` / ``PUT /api/config`` (per-user settings overrides).

Covers:
* server mode: a user-editable key round-trips through ``PUT`` → ``GET``;
* admin-owned keys are dropped and reported in ``ignored``;
* every value-validation boundary (temperature, max_tokens, grader_threshold,
  strict booleans);
* tenant isolation: two bearer tokens → two buckets → two config files;
* prompt semantics: ``null`` and blank both reset to the built-in prompt;
* the non-blocking «Источник» warning;
* auth: ``GET`` stays public, ``PUT`` needs a bearer token in server mode;
* local mode still writes the global file (admin keys included) and validates.

pytest + Starlette ``TestClient`` (no real network, no real ``/data``).
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, rag, settings  # noqa: E402
from app.deps import user_bucket  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import config_routes  # noqa: E402

TOKEN_A = "token-alpha"
TOKEN_B = "token-beta"


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch, tmp_path):
    """Default every test to LOCAL mode with the global config file in tmp."""
    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(config.PATHS, "root", tmp_path / ".cognivault-ui")
    yield


def _server_mode(monkeypatch, tmp_path) -> None:
    """Flip to SERVER mode with ``UI_DATA_DIR`` pointed at ``tmp_path``."""
    monkeypatch.setattr(settings, "is_server", lambda: True)
    monkeypatch.setattr(settings, "data_root", lambda: tmp_path / "data")
    monkeypatch.setenv("GIGACHAT_MODEL_CONTEXT_TOKENS", "32768")
    monkeypatch.setenv("GIGACHAT_TEMPERATURE", "0.2")
    monkeypatch.setenv("GIGACHAT_BASE_URL", "https://admin.example/v1")


def _user_file(tmp_path, token: str):
    return tmp_path / "data" / "users" / user_bucket(token) / "config.json"


def _stored(tmp_path, token: str) -> dict:
    path = _user_file(tmp_path, token)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _auth(token: str = TOKEN_A) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _put(client: TestClient, body: dict, token: str = TOKEN_A):
    return client.put("/api/config", json=body, headers=_auth(token))


# --------------------------------------------------------------------------- #
# Server mode: persistence + allowlist
# --------------------------------------------------------------------------- #


def test_put_persists_editable_key_and_get_reflects_it(tmp_path, monkeypatch):
    """A user-editable key survives PUT and comes back on the next GET."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        put = _put(client, {"gigachat": {"temperature": 0.9}})
        get = client.get("/api/config", headers=_auth())

    assert put.status_code == 200
    assert put.json()["gigachat"]["temperature"] == 0.9
    assert get.json()["gigachat"]["temperature"] == 0.9
    assert _stored(tmp_path, TOKEN_A)["gigachat"]["temperature"] == 0.9


def test_admin_keys_are_ignored_not_saved(tmp_path, monkeypatch):
    """base_url / token / model_context_tokens are dropped and reported."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        resp = _put(
            client,
            {
                "gigachat": {
                    "base_url": "https://evil.example/v1",
                    "model_context_tokens": 999999,
                    "temperature": 0.5,
                },
                "cognivault": {"token": "stolen"},
            },
        )
        body = resp.json()

    assert resp.status_code == 200
    assert set(body["ignored"]) == {
        "gigachat.base_url",
        "gigachat.model_context_tokens",
        "cognivault.token",
    }
    assert body["gigachat"]["model_context_tokens"] == 32768
    assert body["gigachat"]["temperature"] == 0.5

    stored = _stored(tmp_path, TOKEN_A)
    assert stored == {"gigachat": {"temperature": 0.5}}


def test_locked_list_advertises_admin_paths(tmp_path, monkeypatch):
    """The public config tells the UI which paths it must render read-only."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        body = client.get("/api/config").json()

    assert body["mode"] == "server"
    assert "gigachat.model_context_tokens" in body["locked"]
    assert "gigachat.base_url" in body["locked"]
    assert "cognivault.token" in body["locked"]
    # No secrets leak into the public view.
    assert "cert_path" not in body["gigachat"]
    assert "key_passphrase" not in body["gigachat"]
    assert "cognivault" not in body


# --------------------------------------------------------------------------- #
# Value validation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "body",
    [
        {"gigachat": {"temperature": 2.1}},
        {"gigachat": {"temperature": -0.1}},
        {"gigachat": {"max_tokens": 40000}},
        {"gigachat": {"max_tokens": 0}},
        {"gigachat": {"model": ""}},
        {"rag": {"grader_threshold": 6}},
        {"rag": {"grader_threshold": 0}},
        {"rag": {"condense_enabled": "true"}},
        {"rag": {"grader_enabled": 1}},
        {"rag": {"default_on": "yes"}},
        {"rag": {"limit": 0}},
        {"rag": {"limit": 101}},
        {"rag": {"rerank_candidates": 101}},
        {"rag": {"grader_keep_top": 11}},
        {"rag": {"max_expanded_files": -1}},
        {"rag": {"max_context_chars": 499}},
        {"rag": {"max_context_chars": 200001}},
        {"rag": {"file_full_chars": 99}},
        {"rag": {"section_max_chars": 100001}},
        {"rag": {"min_score": 1.5}},
        {"rag": {"min_score": -0.1}},
        {"prompts": {"system": "x" * 20001}},
        {"ui": {"theme": "neon"}},
    ],
)
def test_out_of_range_values_are_rejected(tmp_path, monkeypatch, body):
    """Every documented bound answers 400 CONFIG_INVALID naming the key."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        resp = _put(client, body)

    assert resp.status_code == 400, body
    err = resp.json()["error"]
    assert err["code"] == "CONFIG_INVALID"
    section, leaf = next(iter(body.items()))
    assert f"{section}.{next(iter(leaf))}" in err["message"]
    assert not _user_file(tmp_path, TOKEN_A).is_file()


@pytest.mark.parametrize(
    "body",
    [
        {"gigachat": {"temperature": 2.0}},
        {"gigachat": {"temperature": 0.0}},
        {"gigachat": {"max_tokens": 32768}},
        {"gigachat": {"max_tokens": 1}},
        {"rag": {"grader_threshold": 1}},
        {"rag": {"grader_threshold": 5}},
        {"rag": {"grader_keep_top": 0}},
        {"rag": {"max_expanded_files": 0}},
        {"rag": {"min_score": None}},
        {"rag": {"min_score": 1.0}},
        {"rag": {"condense_enabled": False}},
        {"rag": {"max_context_chars": 500}},
        {"ui": {"theme": "dark"}},
    ],
)
def test_boundary_values_are_accepted(tmp_path, monkeypatch, body):
    """The inclusive edges of each range pass."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        resp = _put(client, body)

    assert resp.status_code == 200, resp.text
    section, leaf = next(iter(body.items()))
    key, value = next(iter(leaf.items()))
    assert _stored(tmp_path, TOKEN_A)[section][key] == value


def test_max_tokens_ceiling_follows_admin_context_window(tmp_path, monkeypatch):
    """The ceiling is the ADMIN's model_context_tokens, not a hard-coded number."""
    _server_mode(monkeypatch, tmp_path)
    monkeypatch.setenv("GIGACHAT_MODEL_CONTEXT_TOKENS", "8192")

    with TestClient(create_app()) as client:
        too_big = _put(client, {"gigachat": {"max_tokens": 8193}})
        exact = _put(client, {"gigachat": {"max_tokens": 8192}})

    assert too_big.status_code == 400
    assert "8192" in too_big.json()["error"]["message"]
    assert exact.status_code == 200


# --------------------------------------------------------------------------- #
# Tenant isolation
# --------------------------------------------------------------------------- #


def test_two_tokens_get_two_isolated_config_files(tmp_path, monkeypatch):
    """Different bearer tokens bucket to different dirs and never cross-read."""
    _server_mode(monkeypatch, tmp_path)
    assert user_bucket(TOKEN_A) != user_bucket(TOKEN_B)

    with TestClient(create_app()) as client:
        _put(client, {"gigachat": {"temperature": 0.1}}, token=TOKEN_A)
        _put(client, {"gigachat": {"temperature": 1.7}}, token=TOKEN_B)
        a = client.get("/api/config", headers=_auth(TOKEN_A)).json()
        b = client.get("/api/config", headers=_auth(TOKEN_B)).json()

    assert a["gigachat"]["temperature"] == 0.1
    assert b["gigachat"]["temperature"] == 1.7
    assert _user_file(tmp_path, TOKEN_A) != _user_file(tmp_path, TOKEN_B)
    assert _stored(tmp_path, TOKEN_A)["gigachat"]["temperature"] == 0.1
    assert _stored(tmp_path, TOKEN_B)["gigachat"]["temperature"] == 1.7


# --------------------------------------------------------------------------- #
# Prompts
# --------------------------------------------------------------------------- #


def test_prompt_null_resets_to_builtin_default(tmp_path, monkeypatch):
    """``None`` means "use the code's prompt", so improvements keep flowing."""
    _server_mode(monkeypatch, tmp_path)
    builtin = config_routes._default_prompts()["system"]

    with TestClient(create_app()) as client:
        custom = _put(client, {"prompts": {"system": "Мой промпт [Источник N]"}})
        reset = _put(client, {"prompts": {"system": None}})

    assert custom.json()["prompts"]["system"] == "Мой промпт [Источник N]"
    assert reset.json()["prompts"]["system"] == builtin
    assert _stored(tmp_path, TOKEN_A)["prompts"]["system"] is None


def test_blank_prompt_is_stored_as_null(tmp_path, monkeypatch):
    """An emptied textarea resets rather than persisting an empty prompt."""
    _server_mode(monkeypatch, tmp_path)
    builtin = config_routes._default_prompts()["context_reminder"]

    with TestClient(create_app()) as client:
        resp = _put(client, {"prompts": {"context_reminder": "   \n  "}})

    assert resp.status_code == 200
    assert _stored(tmp_path, TOKEN_A)["prompts"]["context_reminder"] is None
    assert resp.json()["prompts"]["context_reminder"] == builtin


def test_prompt_without_citation_marker_warns_but_saves(tmp_path, monkeypatch):
    """Dropping the citation rule is allowed — but the UI is told about it."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        default_warnings = client.get("/api/config").json()["warnings"]
        put = _put(client, {"prompts": {"system": "Отвечай кратко и без ссылок."}})
        get = client.get("/api/config", headers=_auth()).json()

    assert default_warnings == []
    assert put.status_code == 200
    assert any("Источник" in w for w in put.json()["warnings"])
    assert any("Источник" in w for w in get["warnings"])
    assert get["prompts"]["system"] == "Отвечай кратко и без ссылок."


def test_readonly_and_default_prompts_are_exposed(tmp_path, monkeypatch):
    """The contract carries built-in defaults + the uneditable pipeline prompts."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        body = client.get("/api/config").json()

    assert body["defaults"]["prompts"]["system"]
    assert body["defaults"]["prompts"]["context_reminder"]
    assert body["readonly"]["prompts"]["condense"]
    assert body["readonly"]["prompts"]["grader"]
    # Мета-ходом управляют два хардкодных промпта. Редактировать их нельзя —
    # но не видеть их пользователь тоже не должен: они решают, чем отвечается
    # вопрос про саму базу и про самого ассистента.
    assert body["readonly"]["prompts"]["meta"] == rag.META_SYSTEM_PROMPT
    assert body["readonly"]["prompts"]["meta_self"] == rag.META_SELF_SYSTEM_PROMPT
    assert "meta" not in settings.editable_leaves("prompts")
    assert set(body["defaults"]["rag"]) == set(settings.editable_leaves("rag"))


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #


def test_get_is_public_and_put_requires_token_in_server_mode(tmp_path, monkeypatch):
    """GET works anonymously (admin view); PUT without a bearer is 401."""
    _server_mode(monkeypatch, tmp_path)

    with TestClient(create_app()) as client:
        anon_get = client.get("/api/config")
        anon_put = client.put("/api/config", json={"gigachat": {"temperature": 0.4}})

    assert anon_get.status_code == 200
    assert anon_get.json()["gigachat"]["temperature"] == 0.2
    assert anon_put.status_code == 401
    assert anon_put.json()["error"]["code"] == "UNAUTHORIZED"
    assert not (tmp_path / "data" / "users").exists()


# --------------------------------------------------------------------------- #
# Local mode
# --------------------------------------------------------------------------- #


def test_local_mode_still_writes_admin_keys_to_the_global_file(tmp_path):
    """Locally the user IS the admin: cert paths and token keep saving."""
    payload = {
        "cognivault": {"base_url": "http://localhost:3000", "token": "local-tok"},
        "gigachat": {"cert_path": "/tmp/c.crt", "temperature": 0.7},
    }

    with TestClient(create_app()) as client:
        resp = client.put("/api/config", json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "local"
    assert body["ignored"] == []
    stored = json.loads(config.PATHS.config_file.read_text(encoding="utf-8"))
    assert stored["cognivault"]["token"] == "local-tok"
    assert stored["gigachat"]["cert_path"] == "/tmp/c.crt"
    assert stored["gigachat"]["temperature"] == 0.7


def test_local_mode_validates_editable_values(tmp_path):
    """The same value rules apply locally — a bad temperature is a 400."""
    with TestClient(create_app()) as client:
        resp = client.put("/api/config", json={"gigachat": {"temperature": 5}})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CONFIG_INVALID"
    assert not config.PATHS.config_file.exists()


def test_local_get_keeps_full_config_and_adds_contract_fields(tmp_path):
    """Local GET stays a superset: full config + prompts/defaults/locked."""
    with TestClient(create_app()) as client:
        client.put("/api/config", json={"gigachat": {"temperature": 0.3}})
        body = client.get("/api/config").json()

    assert body["mode"] == "local"
    assert body["gigachat"]["cert_path"]  # full config, not the narrow view
    assert body["env"]["pip_index_url"]
    assert body["prompts"]["system"] == config_routes._default_prompts()["system"]
    assert body["defaults"]["prompts"]["system"]
    assert body["warnings"] == []
