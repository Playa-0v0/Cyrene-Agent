#!/usr/bin/env python3
import os
import sys
import logging

# 彻底静音：将 stderr 重定向到 devnull
# 这样可以消除 FastMCP 的 Banner 以及所有第三方库的日志干扰
sys.stderr = open(os.devnull, "w")

# 在导入 FastMCP 之前设置环境变量以抑制日志和 Banner
os.environ["LOGURU_LEVEL"] = "WARNING"
os.environ["CI"] = "true"

from fastmcp import FastMCP
import subprocess
import json
import base64

# 确保能导入同级模块
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from cloud_music_mcp.log import setup_logging
from cloud_music_mcp.prompts import load_prompt
from cloud_music_mcp.auth import check_login_status, login_via_qrcode
from cloud_music_mcp.api import (
    get_daily_recommendations,
    get_user_playlists,
    search,
    get_playlist_detail,
    create_playlist,
    add_to_playlist,
    get_album_info,
    get_artist_info,
    get_my_subscriptions,
)

# 配置日志 (初始化)
logger = setup_logging("main")

# 抑制 FastMCP 和相关库的日志
logging.getLogger("fastmcp").setLevel(logging.WARNING)
logging.getLogger("mcp").setLevel(logging.WARNING)
logging.getLogger("uvicorn").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

# 抑制 pyncm 的日志输出，防止溢出到 LLM client
logging.getLogger("pyncm").setLevel(logging.WARNING)
logging.getLogger("pyncm.api").setLevel(logging.WARNING)
logging.getLogger("pyncm.helper").setLevel(logging.WARNING)

# 初始化 MCP Server
mcp = FastMCP("Cloud-Music-MCP")


@mcp.tool(description=load_prompt("cloud_music_status"))
def cloud_music_status():
    logger.info("Calling cloud_music_status")
    status = check_login_status()
    if status["logged_in"]:
        return f"已登录，当前用户: {status['nickname']}"
    else:
        return "未登录，请使用 cloud_music_login 进行扫码登录"


@mcp.tool(description=load_prompt("cloud_music_login"))
def cloud_music_login():
    logger.info("Calling cloud_music_login")
    return login_via_qrcode()


@mcp.tool(description=load_prompt("cloud_music_get_daily_recommend"))
def cloud_music_get_daily_recommend():
    logger.info("Calling cloud_music_get_daily_recommend")
    result = get_daily_recommendations()
    if result["success"]:
        # 格式化输出以便阅读
        text = f"📅 今日推荐 ({len(result['songs'])}首):\n"
        for i, song in enumerate(result["songs"][:10], 1):  # 只展示前10首
            text += f"{i}. {song['name']} - {song['artist']} (ID: {song['id']})\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_my_playlists"))
def cloud_music_my_playlists():
    logger.info("Calling cloud_music_my_playlists")
    result = get_user_playlists()
    if result["success"]:
        text = "我的歌单:\n"
        for pl in result["playlists"]:
            mark = (
                "❤️ " if "喜欢" in pl["name"] else ("👤 " if pl["is_mine"] else "收藏 ")
            )
            text += f"{mark} {pl['name']} (ID: {pl['id']}, {pl['count']}首)\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_search"))
def cloud_music_search(keyword: str, category: str = "song"):
    logger.info(f"Calling cloud_music_search with keyword: {keyword}, category: {category}")
    result = search(keyword, category=category)
    if result["success"]:
        return result["items"]
    else:
        return f"搜索失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_playlist_detail"))
def cloud_music_playlist_detail(playlist_id: int):
    logger.info(f"Calling cloud_music_playlist_detail with playlist_id: {playlist_id}")
    result = get_playlist_detail(playlist_id)
    if result["success"]:
        text = f"📋 歌单: {result['name']} ({result['count']}首)\n"
        for i, song in enumerate(result["songs"], 1):
            text += f"{i}. {song['name']} - {song['artist']} (ID: {song['id']})\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_create_playlist"))
def cloud_music_create_playlist(name: str, privacy: bool = False):
    logger.info(f"Calling cloud_music_create_playlist with name: {name}")
    result = create_playlist(name, privacy)
    if result["success"]:
        return f"歌单创建成功: {result['name']} (ID: {result['playlist_id']})"
    else:
        return f"创建失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_add_to_playlist"))
def cloud_music_add_to_playlist(playlist_id: int, track_ids: list[int]):
    logger.info(f"Calling cloud_music_add_to_playlist with playlist_id: {playlist_id}, track_ids: {track_ids}")
    result = add_to_playlist(playlist_id, track_ids)
    if result["success"]:
        return f"成功添加 {result['added_count']} 首歌曲到歌单 {playlist_id}"
    else:
        return f"添加失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_album_info"))
def cloud_music_album_info(album_id: int):
    logger.info(f"Calling cloud_music_album_info with album_id: {album_id}")
    result = get_album_info(album_id)
    if result["success"]:
        album = result["album"]
        text = f"💿 专辑: {album['name']} - {album['artist']}\n"
        text += f"📅 发行日期: {album['publish_date']} | 共 {album['size']} 首\n"
        for i, song in enumerate(result["songs"], 1):
            text += f"{i}. {song['name']} - {song['artist']} (ID: {song['id']})\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_artist_info"))
def cloud_music_artist_info(artist_id: int):
    logger.info(f"Calling cloud_music_artist_info with artist_id: {artist_id}")
    result = get_artist_info(artist_id)
    if result["success"]:
        artist = result["artist"]
        text = f"🎤 歌手: {artist['name']} (ID: {artist['id']})\n"
        text += f"📊 专辑 {artist['album_count']} 张 | 歌曲 {artist['song_count']} 首\n"
        if artist["description"]:
            text += f"📝 {artist['description']}\n"
        text += "\n🔥 热门歌曲:\n"
        for i, song in enumerate(result["songs"], 1):
            text += f"{i}. {song['name']} (ID: {song['id']})\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_my_subscriptions"))
def cloud_music_my_subscriptions(category: str = "artists"):
    logger.info(f"Calling cloud_music_my_subscriptions with category: {category}")
    result = get_my_subscriptions(category)
    if result["success"]:
        type_name = "歌手" if category == "artists" else "专辑"
        text = f"📌 收藏的{type_name} ({len(result['items'])}个):\n"
        for i, item in enumerate(result["items"], 1):
            if category == "albums":
                text += f"{i}. {item['name']} - {item['artist']} (ID: {item['id']})\n"
            else:
                text += f"{i}. {item['name']} (ID: {item['id']})\n"
        return text
    else:
        return f"获取失败: {result.get('error')}"


@mcp.tool(description=load_prompt("cloud_music_play"))
def cloud_music_play(id: str, type: str = "song"):
    logger.info(f"Calling cloud_music_play with id: {id}, type: {type}")
    try:
        # 构造 JSON 指令
        command = {"type": type, "id": str(id), "cmd": "play"}

        # 序列化并 Base64 编码
        json_str = json.dumps(command, separators=(",", ":"))
        encoded = base64.b64encode(json_str.encode("utf-8")).decode("utf-8")

        # 生成客户端 URL Scheme
        app_url = f"orpheus://{encoded}"
        logger.info(f"Generated App URL: {app_url}")

        # 尝试唤起客户端
        try:
            if sys.platform == "win32":
                os.startfile(app_url)
            else:
                # macOS open 命令，检查返回码
                ret = subprocess.run(["open", app_url], capture_output=True)
                if ret.returncode != 0:
                    raise FileNotFoundError("macOS open failed")

            return f"已发送播放指令: {type} {id}"

        except (OSError, FileNotFoundError, subprocess.CalledProcessError) as e:
            logger.warning(f"无法唤起客户端: {e}，尝试使用网页版")

            # 构造网页版 URL
            # 单曲: https://music.163.com/#/song?id=123
            # 歌单: https://music.163.com/#/playlist?id=123
            web_type = "song" if type == "song" else "playlist"
            web_url = f"https://music.163.com/#/{web_type}?id={id}"

            if sys.platform == "win32":
                os.startfile(web_url)
            else:
                subprocess.run(["open", web_url])

            return f"⚠️ 未检测到客户端，已在浏览器中播放: {web_url}"

    except Exception as e:
        logger.error(f"播放失败: {e}")
        return f"播放失败: {e}"


if __name__ == "__main__":
    mcp.run()
