// 角色头像映射：朋友圈评论与互动通知用这份小头像（用户提供的方形头像），
// task 委托面板的立绘头像是另一套资源（character-portraits.ts），两者用途不同。
// 静态 import 保证资源进打包产物；头像池之外的角色查不到，渲染层降级为无头像。
import fengjinUrl from "./avatars/风堇.png";
import klyUrl from "./avatars/刻律德菈.png";
import changyeyueUrl from "./avatars/长夜月.png";
import xiadiUrl from "./avatars/遐蝶.png";
import tibaoUrl from "./avatars/缇宝.png";
import aglaiyaUrl from "./avatars/阿格莱雅.png";
import baierUrl from "./avatars/白厄.png";
import danhengUrl from "./avatars/丹恒.png";
import hysUrl from "./avatars/海瑟音.png";
import nakexiaUrl from "./avatars/那刻夏.png";
import saifeierUrl from "./avatars/赛飞儿.png";
import wandiUrl from "./avatars/万敌.png";
import cyreneUrl from "./avatars/昔涟.png";

/** 昵称 → 头像 url */
const avatarByNickname: Readonly<Record<string, string>> = {
  "风堇": fengjinUrl,
  "刻律德菈": klyUrl,
  "长夜月": changyeyueUrl,
  "遐蝶": xiadiUrl,
  "缇宝": tibaoUrl,
  "阿格莱雅": aglaiyaUrl,
  "白厄": baierUrl,
  "丹恒": danhengUrl,
  "海瑟音": hysUrl,
  "那刻夏": nakexiaUrl,
  "赛飞儿": saifeierUrl,
  "万敌": wandiUrl,
  "昔涟": cyreneUrl,
};

/** 角色昵称查头像；池外角色返回 null */
export function getCharacterAvatar(nickname: string): string | null {
  return avatarByNickname[nickname] ?? null;
}
