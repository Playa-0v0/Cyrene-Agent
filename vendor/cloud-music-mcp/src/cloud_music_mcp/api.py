from pyncm import apis
from auth import load_session

def get_daily_recommendations():
    """获取每日推荐歌曲"""
    # 确保已登录
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    
    try:
        # 定义内部函数并使用 WeapiCryptoRequest 装饰
        @apis.WeapiCryptoRequest
        def GetDailyRecommendInternal():
            return "/weapi/v1/discovery/recommend/songs", {"limit": 30, "offset": 0, "total": True}
        
        # 调用内部函数 (session 会被自动注入)
        result = GetDailyRecommendInternal()
        
        if result['code'] == 200:
            songs = []
            for song in result['recommend']:
                songs.append({
                    "id": song['id'],
                    "name": song['name'],
                    "artist": song['artists'][0]['name'] if song['artists'] else "未知",
                    "album": song['album']['name'] if song['album'] else ""
                })
            return {"success": True, "songs": songs}
        else:
            return {"success": False, "error": f"API 错误: {result.get('message', '未知错误')}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_user_playlists():
    """获取用户的歌单"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录"}
    
    try:
        # 获取当前用户 ID
        user_info = apis.login.GetCurrentLoginStatus()
        uid = user_info['profile']['userId']
        
        result = apis.user.GetUserPlaylists(uid)
        if result['code'] == 200:
            playlists = []
            for pl in result['playlist']:
                playlists.append({
                    "id": pl['id'],
                    "name": pl['name'],
                    "count": pl['trackCount'],
                    "creator": pl['creator']['nickname'],
                    "is_mine": pl['creator']['userId'] == uid
                })
            return {"success": True, "playlists": playlists}
        else:
            return {"success": False, "error": "API 请求失败"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def search(keyword, category="song", limit=5):
    """搜索歌曲/专辑/歌手/歌单"""
    # 搜索不需要登录，但登录后结果更准
    load_session()
    try:
        # category 到搜索类型(stype)数字的映射
        stype_map = {
            "song": 1,        # 歌曲
            "album": 10,      # 专辑
            "artist": 100,    # 歌手
            "playlist": 1000,  # 歌单
        }
        stype = stype_map.get(category, 1)
        result = apis.cloudsearch.GetSearchResult(keyword, stype=stype, limit=limit)

        if result.get('code') != 200:
            return {"success": False, "error": "API 请求失败"}

        res = result.get('result', {})
        items = []

        if category == "song":
            for song in res.get('songs', []):
                items.append({
                    "id": song.get('id'),
                    "name": song.get('name'),
                    "artist": song['ar'][0]['name'] if song.get('ar') else "未知"
                })
        elif category == "album":
            for album in res.get('albums', []):
                items.append({
                    "id": album.get('id'),
                    "name": album.get('name'),
                    "artist": album.get('artist', {}).get('name', '未知')
                })
        elif category == "artist":
            for artist in res.get('artists', []):
                items.append({
                    "id": artist.get('id'),
                    "name": artist.get('name')
                })
        elif category == "playlist":
            for pl in res.get('playlists', []):
                items.append({
                    "id": pl.get('id'),
                    "name": pl.get('name'),
                    "count": pl.get('trackCount', 0)
                })

        if not items:
            return {"success": False, "error": "未找到结果"}
        return {"success": True, "category": category, "items": items}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_playlist_detail(playlist_id):
    """获取歌单详情（含完整歌曲列表）"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        result = apis.playlist.GetPlaylistInfo(playlist_id)
        playlist = result.get('playlist', {})

        songs = []
        for track in playlist.get('tracks', []):
            songs.append({
                "id": track.get('id'),
                "name": track.get('name'),
                "artist": track['ar'][0]['name'] if track.get('ar') else "未知",
                "album": track.get('al', {}).get('name', '')
            })
        return {
            "success": True,
            "name": playlist.get('name', ''),
            "count": playlist.get('trackCount', len(songs)),
            "songs": songs
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_playlist(name, privacy=False):
    """创建新歌单"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        result = apis.playlist.SetCreatePlaylist(name, privacy)
        playlist = result.get('playlist', {})
        return {
            "success": True,
            "playlist_id": playlist.get('id'),
            "name": playlist.get('name', name)
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def add_to_playlist(playlist_id, track_ids):
    """添加歌曲到歌单"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        # 确保 track_ids 为列表类型
        if not isinstance(track_ids, list):
            track_ids = [track_ids]
        result = apis.playlist.SetManipulatePlaylistTracks(
            trackIds=track_ids, playlistId=playlist_id, op="add"
        )
        if result.get('code') == 200:
            return {"success": True, "added_count": len(track_ids)}
        return {"success": False, "error": result.get('message', '添加失败')}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_album_info(album_id):
    """获取专辑详情（含歌曲列表）"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        result = apis.album.GetAlbumInfo(album_id)
        album = result.get('album', {})

        # publishTime 是毫秒时间戳，转为日期字符串
        publish_ts = album.get('publishTime', 0)
        publish_date = ''
        if publish_ts:
            from datetime import datetime
            publish_date = datetime.fromtimestamp(publish_ts / 1000).strftime('%Y-%m-%d')

        songs = []
        for song in result.get('songs', []):
            songs.append({
                "id": song.get('id'),
                "name": song.get('name'),
                "artist": song['ar'][0]['name'] if song.get('ar') else "未知"
            })
        return {
            "success": True,
            "album": {
                "name": album.get('name', ''),
                "artist": album.get('artist', {}).get('name', '未知'),
                "publish_date": publish_date,
                "size": album.get('size', len(songs))
            },
            "songs": songs
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_artist_info(artist_id):
    """获取歌手详情和热门歌曲"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        # 获取歌手基本信息
        detail = apis.artist.GetArtistDetails(artist_id)
        artist = detail.get('data', {}).get('artist', {})

        # 获取热门歌曲 Top 10
        tracks_resp = apis.artist.GetArtistTracks(artist_id, limit=10)
        songs = []
        for song in tracks_resp.get('songs', []):
            songs.append({
                "id": song.get('id'),
                "name": song.get('name')
            })

        return {
            "success": True,
            "artist": {
                "name": artist.get('name', ''),
                "id": artist.get('id'),
                "album_count": artist.get('albumSize', 0),
                "song_count": artist.get('musicSize', 0),
                "description": (artist.get('briefDesc') or '')[:200]
            },
            "songs": songs
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_my_subscriptions(category="artists"):
    """获取我收藏的歌手或专辑"""
    if not load_session()[0]:
        return {"success": False, "error": "未登录，请先调用 login 工具"}
    try:
        if category == "albums":
            result = apis.user.GetUserAlbumSubs(limit=50)
        else:
            result = apis.user.GetUserArtistSubs(limit=50)

        items = []
        for item in result.get('data', []):
            entry = {"id": item.get('id'), "name": item.get('name')}
            if category == "albums":
                entry["artist"] = item.get('artists', [{}])[0].get('name', '未知')
            items.append(entry)

        return {"success": True, "category": category, "items": items}
    except Exception as e:
        return {"success": False, "error": str(e)}
