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
