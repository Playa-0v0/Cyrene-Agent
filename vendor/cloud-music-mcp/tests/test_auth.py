import json
import os
import tempfile
import pytest
from cloud_music_mcp import auth


@pytest.fixture(autouse=True)
def tmp_storage(monkeypatch):
    d = tempfile.mkdtemp()
    monkeypatch.setenv("CYRENE_MUSIC_STORAGE_DIR", d)
    # Block any accidental write to the legacy package-local cookie file
    # if the production code regresses to calling save_session(). Tests
    # only ever assert against the env-controlled runtime dir.
    monkeypatch.setattr(auth, "save_session", lambda: None)
    auth._reset_for_tests()
    yield d


def _cookies_file(storage_dir: str) -> str:
    return os.path.join(storage_dir, "cookies.json")


def test_begin_login_returns_session_and_qr_text(monkeypatch):
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "abc-unikey"},
    )
    out = auth.begin_login()
    assert "loginSessionId" in out
    assert out["qrContent"] == "https://music.163.com/login?codekey=abc-unikey"
    assert out["pollIntervalMs"] == 2000
    assert out["expiresAt"] > 0


def test_begin_login_when_already_active_returns_login_already_active(monkeypatch):
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "u1"},
    )
    first = auth.begin_login()
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "u2"},
    )
    second = auth.begin_login()
    assert second["status"] == "login_already_active"
    assert second["activeSessionId"] == first["loginSessionId"]


def test_check_login_maps_pyncm_codes(monkeypatch):
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "u3"},
    )
    begin = auth.begin_login()
    sid = begin["loginSessionId"]

    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeCheck",
        lambda unikey, type=1: {"code": 801},
    )
    assert auth.check_login(sid)["status"] == "waiting_scan"

    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeCheck",
        lambda unikey, type=1: {"code": 802},
    )
    assert auth.check_login(sid)["status"] == "waiting_confirm"

    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeCheck",
        lambda unikey, type=1: {"code": 800},
    )
    out = auth.check_login(sid)
    assert out["status"] == "expired"


def test_check_login_authorized_returns_credential_revision_and_persists(
    monkeypatch, tmp_storage
):
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "u4"},
    )
    begin = auth.begin_login()
    sid = begin["loginSessionId"]

    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeCheck",
        lambda unikey, type=1: {"code": 803, "cookie": "a=1; b=2"},
    )
    monkeypatch.setattr(auth.apis.login, "WriteLoginInfo", lambda c: None)

    # Populate the in-process pyncm session with non-empty cookies so
    # the 803 path reads them and atomic-writes them to the runtime dir.
    fake_cookies = {
        "MUSIC_U": "fake-music-u",
        "__csrf": "fake-csrf",
    }
    sess = auth.GetCurrentSession()
    sess.cookies.set("MUSIC_U", "fake-music-u")
    sess.cookies.set("__csrf", "fake-csrf")

    monkeypatch.setattr(
        auth.apis.login,
        "GetCurrentLoginStatus",
        lambda: {"code": 200, "profile": {"nickname": "alice", "userId": 42}},
    )

    out = auth.check_login(sid)
    assert out["status"] == "authorized"
    assert out["credentialsPersisted"] is True
    assert out["credentialRevision"] >= 1
    assert out["profile"]["nickname"] == "alice"

    # The cookies must be persisted into the env-controlled runtime dir
    # (single source of truth), not the legacy package-local STORAGE_DIR.
    cookies_file = _cookies_file(tmp_storage)
    assert os.path.exists(cookies_file), (
        f"cookies.json was not written to {cookies_file}; runtime dir is "
        f"the single source of truth and must contain the persisted cookies"
    )
    with open(cookies_file, "r", encoding="utf-8") as f:
        persisted = json.load(f)
    assert persisted == fake_cookies


def test_cancel_login_is_idempotent(monkeypatch):
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeUnikey",
        lambda dtype=1: {"code": 200, "unikey": "u5"},
    )
    begin = auth.begin_login()
    sid = begin["loginSessionId"]
    auth.cancel_login(sid)
    auth.cancel_login(sid)  # must not raise
    monkeypatch.setattr(
        auth.apis.login,
        "LoginQrcodeCheck",
        lambda unikey, type=1: {"code": 801},
    )
    out = auth.check_login(sid)
    # Once cancelled, the session is gone, so check_login reports expired.
    assert out["status"] in ("expired", "cancelled")


def test_validate_session_three_state_reads_runtime_dir(monkeypatch, tmp_storage):
    """Startup validation must read cookies from the env-controlled
    runtime dir, not the legacy package-local file."""
    cookies_file = _cookies_file(tmp_storage)
    with open(cookies_file, "w", encoding="utf-8") as f:
        json.dump({"MUSIC_U": "x", "__csrf": "y"}, f)

    monkeypatch.setattr(auth.apis.login, "GetCurrentLoginStatus", lambda: {
        "code": 200,
        "profile": {"nickname": "alice", "userId": 42},
    })
    out = auth.validate_session_three_state()
    assert out["state"] == "valid"
    assert out["profile"]["nickname"] == "alice"


def test_validate_session_three_state_no_cookies_file(tmp_storage):
    """When no cookies.json exists, report invalid_credentials (not an
    exception)."""
    out = auth.validate_session_three_state()
    assert out == {"state": "invalid_credentials"}


def test_validate_session_three_state_does_not_leak_exception_text(
    monkeypatch, tmp_storage
):
    """The 'reason' field must never echo raw exception text — only
    stable error codes, since exception messages can contain bearer tokens
    or cookie values leaked into the API response."""
    cookies_file = _cookies_file(tmp_storage)
    with open(cookies_file, "w", encoding="utf-8") as f:
        json.dump({"MUSIC_U": "x"}, f)

    def boom():
        raise RuntimeError("MUSIC_U=leaked-bearer-token-in-trace")

    monkeypatch.setattr(auth.apis.login, "GetCurrentLoginStatus", boom)
    out = auth.validate_session_three_state()
    assert out["state"] == "temporarily_unavailable"
    # The exception text MUST NOT appear in the response payload.
    assert "leaked-bearer-token-in-trace" not in str(out)
    assert "MUSIC_U=leaked" not in str(out)
    assert out["reason"] in {"api_unreachable", "storage_read_failed"}


def test_check_login_atomicity_cancel_after_803_cannot_run(monkeypatch, tmp_storage):
    """cancel_login must not be able to interleave with check_login once
    the 803 lock is held. We simulate by making cancel_login a no-op
    while the lock is implicitly held by check_login; since the lock is
    re-entrant only on the same thread, the realistic guarantee is that
    by the time 803 returns, the pending entry is gone — prove it via
    state inspection."""
    monkeypatch.setattr(auth.apis.login, "LoginQrcodeUnikey", lambda dtype=1: {"code": 200, "unikey": "u6"})
    begin = auth.begin_login()
    sid = begin["loginSessionId"]
    monkeypatch.setattr(auth.apis.login, "LoginQrcodeCheck", lambda unikey, type=1: {"code": 803, "cookie": "x=1"})
    monkeypatch.setattr(auth.apis.login, "WriteLoginInfo", lambda c: None)
    sess = auth.GetCurrentSession()
    sess.cookies.set("MUSIC_U", "x")
    monkeypatch.setattr(auth.apis.login, "GetCurrentLoginStatus", lambda: {"code": 200, "profile": {"nickname": "x"}})
    auth.check_login(sid)
    # After 803, the pending session must have been popped.
    cancel_out = auth.cancel_login(sid)
    assert cancel_out["status"] == "no_op"
