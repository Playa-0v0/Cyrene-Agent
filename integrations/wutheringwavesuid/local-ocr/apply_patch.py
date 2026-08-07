"""將國際服插件切換為昔漣的 macOS Vision OCR。

這支安裝腳本只修改列出的固定程式片段；找不到片段時會停止，避免在上游改版後
悄悄產生不完整的隱私保護。
"""

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"找不到待修改片段：{label}")
    return text.replace(old, new, 1)


root = Path(sys.argv[1]).resolve()
plugin = root / "gsuid_core/plugins/WutheringWavesUID/WutheringWavesUID/wutheringwaves_analyzecard"
ocr_path = plugin / "ocrspace.py"
card_path = plugin / "cardOCR.py"
cost_path = plugin / "char_fetterDetail.py"
logger_path = root / "gsuid_core/logger.py"
resource_path = root / "gsuid_core/utils/resource_manager.py"
config_path = root / "data/WutheringWavesUID/config.json"

ocr = ocr_path.read_text(encoding="utf-8")
ocr = replace_once(
    ocr,
    "from ..wutheringwaves_config import WutheringWavesConfig\n",
    "from ..wutheringwaves_config import WutheringWavesConfig\nfrom .local_ocr import recognize_images\n",
    "載入本機 OCR",
)
start = ocr.index("async def ocrspace(")
end = ocr.index("async def images_ocrspace(", start)
local_function = '''async def ocrspace(
    cropped_images: list[Image.Image],
    bot: Bot,
    at_sender: bool,
    language: str = "cht",
    isTable: bool = True,
    need_all_pass: bool = False,
) -> list | str:
    """使用 macOS Vision 在本機辨識，不上傳圖片或辨識文字。"""
    ocr_results = await recognize_images(cropped_images)
    error_msg = "[鳴潮] 本機 OCR 辨識失敗，請確認圖片清晰且使用遊戲內繁體中文介面。\\n"
    if not ocr_results:
        logger.warning(error_msg)
        return error_msg
    passed = all(result.get("error") is None for result in ocr_results) if need_all_pass else any(
        result.get("error") is None for result in ocr_results
    )
    if not passed:
        logger.warning(error_msg)
        return error_msg
    logger.success("[鳴潮] 本機 OCR 辨識成功（圖片未離開這台電腦）")
    return ocr_results


'''
ocr = ocr[:start] + local_function + ocr[end:]
ocr = ocr.replace('.startswith("http")', '.startswith(("http", "base64://", "data:image/"))', 2)
ocr = replace_once(
    ocr,
    '    logger.debug(f"[鸣潮]获取图片res: {res}")',
    '    logger.debug(f"[鳴潮] 已取得 {len(res)} 張待分析圖片")',
    "遮蔽圖片網址",
)
decode_block = '''        if url.startswith("base64://"):
            try:
                image_data = base64.b64decode(url[9:], validate=True)
                images.append(Image.open(BytesIO(image_data)))
                success = True
            except Exception as e:
                logger.warning(f"[鳴潮] 無法解碼本機圖片：{e}")
            continue
        if url.startswith("data:image/"):
            try:
                image_data = base64.b64decode(url.split(",", 1)[1], validate=True)
                images.append(Image.open(BytesIO(image_data)))
                success = True
            except Exception as e:
                logger.warning(f"[鳴潮] 無法解碼本機圖片：{e}")
            continue

'''
ocr = replace_once(
    ocr,
    '        logger.info(f"[鸣潮]卡片分析上传链接：{url}")\n\n',
    decode_block,
    "本機 base64 圖片",
)
ocr_path.write_text(ocr, encoding="utf-8")

card = card_path.read_text(encoding="utf-8")
if "def extract_local_echo_entries" not in card:
    card = replace_once(
        card,
        "\n\nasync def async_ocr(bot: Bot, ev: Event):",
        '''

def extract_local_echo_entries(text: str) -> list[tuple[str, str]]:
    """解析 macOS Vision 常見的「屬性欄在前、數值欄在後」辨識結果。"""
    from .ScoreQuery import check_in, clean_ocr_num, valid_keys

    attributes: list[str] = []
    values: list[str] = []
    for raw_line in text.splitlines():
        line = re.sub(r"\\s+", "", raw_line).strip()
        if not line:
            continue

        attribute_text = cc.convert(re.sub(r"[0-9０-９.%％]+", "", line))
        attribute = check_in(attribute_text, valid_keys)
        if not attribute:
            attribute = check_in(f"{attribute_text}加成", valid_keys)
        if attribute:
            attributes.append(attribute)

        number_text = clean_ocr_num(line)
        number_match = re.fullmatch(r"[^0-9]*([0-9]+(?:\\.[0-9]+)?%?)[^0-9%]*", number_text)
        if number_match:
            values.append(number_match.group(1))

    if len(attributes) == len(values) and 2 <= len(attributes) <= 7:
        return list(zip(attributes, values))
    return []


async def async_ocr(bot: Bot, ev: Event):''',
        "Vision 聲骸欄位解析",
    )
    card = replace_once(
        card,
        "\n        # 分配主副属性\n",
        '''
        local_entries = extract_local_echo_entries(text)
        if local_entries:
            valid_entries = local_entries

        # 分配主副属性
''',
        "採用 Vision 聲骸欄位",
    )
if "RM.discard(image_id)" not in card:
    card = replace_once(
        card,
        "    bool_i, images = await get_upload_img(ev)\n",
        '''    bool_i, images = await get_upload_img(ev)
    # 取得 PIL 圖片後立刻清除 GsCore 記憶體快取。
    try:
        from gsuid_core.utils.resource_manager import RM

        for image_id in ev.image_id_list:
            RM.discard(image_id)
    except Exception:
        pass
''',
        "清除原圖記憶體快取",
    )
card = replace_once(
    card,
    '''    set_cache_analyze_card(ev.user_id, True)  # 设置时限
    ocr_results = await ocrspace(cropped_images, bot, at_sender, need_all_pass=True)
    set_cache_analyze_card(ev.user_id, False)  # 清除时限
''',
    '''    set_cache_analyze_card(ev.user_id, True)  # 设置时限
    try:
        ocr_results = await ocrspace(cropped_images, bot, at_sender, need_all_pass=True)
    finally:
        set_cache_analyze_card(ev.user_id, False)  # 無論成功或失敗都清除時限
''',
    "失敗時清除分析鎖定",
)
card = replace_once(
    card,
    "    await save_card_dict_to_json(bot, ev, final_result)\n",
    '''    try:
        await save_card_dict_to_json(bot, ev, final_result)
    except Exception:
        logger.exception("[鳴潮][OCR] 卡片資料整理失敗")
        await bot.send(
            "[鳴潮] 圖片已讀取，但部分資料無法完成整理。請使用原始卡片圖片重試；若仍失敗，請通知管理員查看本機日誌。\\n",
            at_sender,
        )
''',
    "卡片整理失敗回覆",
)
card = replace_once(
    card,
    '    logger.info(f" [鸣潮][dc卡片识别] 最终提取内容:\\n{final_result}")',
    '    logger.info("[鳴潮][OCR] 卡片文字已完成本機整理（詳細內容不寫入日誌）")',
    "遮蔽辨識結果日誌",
)
card_path.write_text(card, encoding="utf-8")

cost = cost_path.read_text(encoding="utf-8")
cost = replace_once(
    cost,
    '''    key = mainProps_first[0]["attributeName"]
    value = float(mainProps_first[0]["attributeValue"].strip("%"))
    key_little = mainProps_first[1]["attributeName"]  # 小词条
''',
    '''    if not mainProps_first:
        logger.warning("[鳴潮][OCR] 聲骸主屬性為空，暫以 1 Cost 處理")
        return ECHO_ID_COST_ONE, 1

    try:
        key = mainProps_first[0]["attributeName"]
        value = float(mainProps_first[0]["attributeValue"].strip("%"))
    except (KeyError, TypeError, ValueError):
        logger.warning("[鳴潮][OCR] 聲骸主屬性格式不完整，暫以 1 Cost 處理")
        return ECHO_ID_COST_ONE, 1

    # 本機 OCR 偶爾會漏掉第二行固定屬性。暴擊、屬性傷害等仍可只靠
    # 第一行安全判斷 Cost；基礎屬性才需要用第二行協助區分。
    key_little = mainProps_first[1].get("attributeName", "") if len(mainProps_first) > 1 else ""
''',
    "聲骸第二主屬性容錯",
)
cost_path.write_text(cost, encoding="utf-8")

config = config_path.read_text(encoding="utf-8")
card_img_start = config.index('"CardImgCheck"')
card_img_end = config.index("}", card_img_start)
card_img_section = config[card_img_start:card_img_end]
if '"data": false' in card_img_section:
    config = config[:card_img_start] + card_img_section.replace('"data": false', '"data": true', 1) + config[card_img_end:]
config_path.write_text(config, encoding="utf-8")

resource = resource_path.read_text(encoding="utf-8")
resource = replace_once(
    resource,
    "        return data\n\n    async def start_cleanup_loop",
    '''        return data

    def discard(self, resource_id: str) -> bool:
        """立即移除不再需要的暫存資源。"""
        return self._store.pop(resource_id, None) is not None

    async def start_cleanup_loop''',
    "即時刪除資源",
)
resource_path.write_text(resource, encoding="utf-8")

logger = logger_path.read_text(encoding="utf-8")
logger = replace_once(
    logger,
    '''        if isinstance(message, dict):
            data = message.get("data")
        else:
            data = getattr(message, "data", None)

        if data:
            dd = str(data)
            if len(dd) >= 500:
                try:
                    truncated = dd[:100]
                    if isinstance(message, dict):
                        message["data"] = truncated
                    else:
                        message.data = truncated
''',
    '''        if isinstance(message, dict):
            message_type = message.get("type")
            data = message.get("data")
        else:
            message_type = getattr(message, "type", None)
            data = getattr(message, "data", None)

        if data:
            dd = str(data)
            if message_type in {"image", "img", "file", "record", "video"} or len(dd) >= 500:
                try:
                    redacted = f"<{message_type or 'payload'} omitted; {len(dd)} chars>"
                    if isinstance(message, dict):
                        message["data"] = redacted
                    else:
                        message.data = redacted
''',
    "日誌附件遮罩",
)
logger = replace_once(
    logger,
    '''    if isinstance(value, str) and len(value) > 256:
        return f"<{len(value)} chars omitted>"
    return value
''',
    '''    if isinstance(value, str):
        if value.startswith(("base64://", "data:image/")) or "cdn.discordapp.com/attachments/" in value:
            return "<image omitted>"
        if len(value) > 256:
            return f"<{len(value)} chars omitted>"
    return value
''',
    "日誌圖片網址遮罩",
)
logger = replace_once(
    logger,
    '''                    file=_shorten_b64(value.file),
                    image=_shorten_b64(value.image),
''',
    '''                    file=_shorten_b64(value.file),
                    image=_shorten_b64(value.image),
                    image_list=["<image omitted>" for _ in value.image_list],
''',
    "事件圖片清單遮罩",
)
logger_path.write_text(logger, encoding="utf-8")
