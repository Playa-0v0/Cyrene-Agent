import os
import sys
import time
import json
import subprocess
from pyncm import apis
from pyncm import GetCurrentSession, SetCurrentSession
import qrcode
from PIL import Image

# 定义 Session 存储路径
STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage")
COOKIE_FILE = os.path.join(STORAGE_DIR, "cookies.json")

def ensure_storage_dir():
    if not os.path.exists(STORAGE_DIR):
        os.makedirs(STORAGE_DIR)

def load_session():
    """尝试加载本地 Cookies"""
    ensure_storage_dir()
    if os.path.exists(COOKIE_FILE):
        try:
            with open(COOKIE_FILE, 'r') as f:
                cookies = json.load(f)
                # 更新当前 Session 的 cookies
                GetCurrentSession().cookies.update(cookies)
            
            # 验证 Session 是否有效 (获取用户信息)
            user_info = apis.login.GetCurrentLoginStatus()
            
            if user_info['code'] == 200 and user_info['profile']:
                return True, user_info['profile']['nickname']
            else:
                return False, None
        except Exception as e:
            return False, None
    return False, None

def save_session():
    """保存当前 Cookies 到文件"""
    ensure_storage_dir()
    try:
        # 获取字典格式的 cookies
        cookies = GetCurrentSession().cookies.get_dict()
        with open(COOKIE_FILE, 'w') as f:
            json.dump(cookies, f)
        return True
    except Exception as e:
        return False

def check_login_status():
    """检查当前是否已登录"""
    is_logged_in, nickname = load_session()
    return {
        "logged_in": is_logged_in,
        "nickname": nickname
    }

def login_via_qrcode():
    """执行扫码登录流程"""
    try:
        # 1. 获取 UUID (Unikey)
        result = apis.login.LoginQrcodeUnikey(1)
        if result['code'] != 200:
            return {"success": False, "message": "获取二维码失败"}
        
        uuid = result['unikey']
        
        # 2. 生成二维码链接和图片
        qr_content = f"https://music.163.com/login?codekey={uuid}"
        
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(qr_content)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        
        qr_path = os.path.join(STORAGE_DIR, "login_qrcode.png")
        img.save(qr_path)
        
        # 3. 弹窗显示二维码
        if sys.platform == 'win32':
            os.startfile(qr_path)
        else:
            subprocess.run(["open", qr_path])
        
        # 4. 轮询检查状态
        max_retries = 60 # 2分钟超时
        for _ in range(max_retries):
            result = apis.login.LoginQrcodeCheck(uuid)
            code = result['code']
            
            if code == 800:
                return {"success": False, "message": "二维码已过期，请重试"}
            elif code == 803:
                # 重要: 确保 cookies 被正确捕获
                # 如果返回结果里有 cookie，先写入
                if 'cookie' in result:
                     apis.login.WriteLoginInfo(result['cookie'])
                
                save_session()
                
                try:
                    user_info = apis.login.GetCurrentLoginStatus()
                    nickname = user_info['profile']['nickname'] if user_info.get('profile') else "用户"
                    return {"success": True, "message": f"登录成功！欢迎回来，{nickname}", "nickname": nickname}
                except Exception as e:
                    return {"success": True, "message": "登录成功，但无法获取用户信息", "nickname": "用户"}
            
            time.sleep(2)
            
        return {"success": False, "message": "登录超时"}
        
    except Exception as e:
        return {"success": False, "message": f"错误: {str(e)}"}

# === Cyrene non-blocking login interface (vendored patch) ===

import logging
import threading

_PENDING_SESSIONS: dict = {}
_PENDING_LOCK = threading.Lock()
_REVISION = 0

# Local logger used by the Cyrene non-blocking interface. The legacy
# `login_via_qrcode()` function above never defined one, so we create a
# module-scoped logger here that is sanitized by `_sanitize()` before emit.
_logger = logging.getLogger("cloud_music_mcp.cyrene")


def _reset_for_tests() -> None:
    """Test-only: clear in-process state."""
    with _PENDING_LOCK:
        _PENDING_SESSIONS.clear()
    global _REVISION
    _REVISION = 0


def _storage_dir() -> str:
    env = os.environ.get("CYRENE_MUSIC_STORAGE_DIR")
    if env:
        os.makedirs(env, exist_ok=True)
        return env
    # Fallback to legacy package-local storage
    ensure_storage_dir()
    return STORAGE_DIR


def _atomic_write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _write_session_cookies(cookies: dict) -> None:
    """Atomically write cookies into the runtime storage directory."""
    sd = _storage_dir()
    target = os.path.join(sd, "cookies.json")
    _atomic_write_json(target, cookies)


def ensure_runtime_session() -> bool:
    """Hydrate the one shared pyncm Session from Cyrene runtime cookies.

    Login-aware NetEase APIs call this instead of the legacy package-local
    ``load_session`` path. It performs no network request; the API call itself
    remains authoritative for expired credentials.
    """
    session = GetCurrentSession()
    current = session.cookies.get_dict()
    if current.get("MUSIC_U"):
        return True

    cookies_path = os.path.join(_storage_dir(), "cookies.json")
    try:
        with open(cookies_path, "r", encoding="utf-8") as f:
            cookies = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    if not isinstance(cookies, dict) or not cookies.get("MUSIC_U"):
        return False
    session.cookies.update(cookies)
    return True


def _sanitize(value: str) -> str:
    """Sanitize log lines: redact cookies, MUSIC_U, CSRF."""
    import re
    patterns = [
        (re.compile(r"\bMUSIC_U=[^;\s]+"), "MUSIC_U=<redacted>"),
        (re.compile(r"\b__csrf=[^;\s]+"), "__csrf=<redacted>"),
        (re.compile(r"(?i)authorization:\s*bearer\s+\S+"), "Authorization: Bearer <redacted>"),
    ]
    out = value
    for pat, repl in patterns:
        out = pat.sub(repl, out)
    return out


def begin_login() -> dict:
    """Create a new QR login session. Returns a structured dict (no PNG, no startfile)."""
    with _PENDING_LOCK:
        if _PENDING_SESSIONS:
            oldest = next(iter(_PENDING_SESSIONS))
            return {"status": "login_already_active", "activeSessionId": oldest}

        result = apis.login.LoginQrcodeUnikey(1)
        if result.get("code") != 200:
            return {"status": "failed", "errorCode": "E_UNIKEY_FAILED"}
        uuid = result["unikey"]
        sid = uuid
        _PENDING_SESSIONS[sid] = {"uuid": uuid, "started_at": time.time()}
        qr_content = f"https://music.163.com/login?codekey={uuid}"
        return {
            "loginSessionId": sid,
            "qrContent": qr_content,
            "expiresAt": int(time.time() * 1000) + 120_000,
            "pollIntervalMs": 2000,
        }


def check_login(session_id: str) -> dict:
    """Single check on an existing session. Returns structured status.

    The lock is held across the whole check transaction so that
    cancel_login() cannot interleave with an in-flight 803 authorization.
    We expect at most one active session, so serializing network calls
    via the shared lock is acceptable.
    """
    with _PENDING_LOCK:
        info = _PENDING_SESSIONS.get(session_id)
        if not info:
            return {"status": "expired", "errorCode": "E_SESSION_UNKNOWN"}
        if time.time() - info["started_at"] > 120:
            _PENDING_SESSIONS.pop(session_id, None)
            return {"status": "expired", "errorCode": "E_TIMEOUT"}

        try:
            result = apis.login.LoginQrcodeCheck(info["uuid"])
        except Exception as e:  # noqa: BLE001
            _logger.warning(_sanitize(f"check_login network error: {e}"))
            return {"status": "failed", "errorCode": "E_NETWORK"}

        code = result.get("code")
        if code == 800:
            _PENDING_SESSIONS.pop(session_id, None)
            return {"status": "expired", "errorCode": "E_QR_EXPIRED"}
        if code == 801:
            return {"status": "waiting_scan"}
        if code == 802:
            return {"status": "waiting_confirm"}
        if code == 803:
            # 803 confirms the authorization. Read cookies out of the
            # in-process pyncm session (LoginQrcodeCheck already populates
            # it on success) and atomically persist them into the
            # env-controlled runtime dir. Single source of truth: the
            # legacy save_session() / STORAGE_DIR writes are intentionally
            # removed so they cannot shadow the runtime dir.
            persisted_ok = False
            try:
                cookies = GetCurrentSession().cookies.get_dict()
                _write_session_cookies(cookies)
                persisted_ok = True
            except Exception as e:  # noqa: BLE001
                _logger.warning(
                    _sanitize(f"failed to write runtime cookies: {e}")
                )

            global _REVISION
            _REVISION += 1

            profile_payload = {"userId": "", "nickname": "user"}
            try:
                ui = apis.login.GetCurrentLoginStatus()
                profile = ui.get("profile") or {}
                profile_payload = {
                    "userId": str(
                        profile.get("userId") or profile.get("id") or ""
                    ),
                    "nickname": profile.get("nickname") or "user",
                    "avatarUrl": profile.get("avatarUrl"),
                }
            except Exception:  # noqa: BLE001
                pass

            # Only drop the pending session if persistence actually
            # succeeded. A false-success would leave the caller believing
            # credentials are durable while they are not.
            if persisted_ok:
                _PENDING_SESSIONS.pop(session_id, None)

            return {
                "status": "authorized",
                "credentialsPersisted": persisted_ok,
                "credentialRevision": _REVISION,
                "profile": profile_payload,
            }
        return {"status": "failed", "errorCode": f"E_UNKNOWN_CODE_{code}"}


def cancel_login(session_id: str) -> dict:
    """Cancel a pending login session. Idempotent."""
    with _PENDING_LOCK:
        existed = _PENDING_SESSIONS.pop(session_id, None)
    return {"status": "cancelled" if existed else "no_op"}


def validate_session_three_state() -> dict:
    """Startup-time session validation.

    Reads cookies from the env-controlled runtime dir
    (``<CYRENE_MUSIC_STORAGE_DIR>/cookies.json``) directly via
    ``_write_session_cookies``'s mirror logic, then pings the upstream
    API to confirm they're still accepted. Never echoes raw exception
    text in the response — only stable error codes.
    """
    cookies_path = os.path.join(_storage_dir(), "cookies.json")
    try:
        with open(cookies_path, "r", encoding="utf-8") as f:
            cookies = json.load(f)
    except FileNotFoundError:
        return {"state": "invalid_credentials"}
    except Exception as e:  # noqa: BLE001
        _logger.warning(_sanitize(f"validate_session read error: {e}"))
        return {"state": "temporarily_unavailable", "reason": "storage_read_failed"}
    if not cookies:
        return {"state": "invalid_credentials"}

    try:
        GetCurrentSession().cookies.update(cookies)
        user_info = apis.login.GetCurrentLoginStatus()
    except Exception as e:  # noqa: BLE001
        _logger.warning(_sanitize(f"validate_session transient error: {e}"))
        return {"state": "temporarily_unavailable", "reason": "api_unreachable"}

    code = user_info.get("code")
    if code == 200 and user_info.get("profile"):
        profile = user_info["profile"]
        return {
            "state": "valid",
            "profile": {
                "userId": str(
                    profile.get("userId") or profile.get("id") or ""
                ),
                "nickname": profile.get("nickname") or "",
            },
        }
    if code == 200 or code in {301, 302, 400, 401, 403}:
        return {"state": "invalid_credentials"}
    return {"state": "temporarily_unavailable", "reason": "api_unreachable"}
