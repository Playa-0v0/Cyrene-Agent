// 角色立绘头像映射：task 委托面板与朋友圈评论共用同一份静态资源。
// 文件名与昵称一一对应（昵称.png）；静态 import 保证资源进打包产物，
// 不在立绘池内的角色查不到头像，渲染层降级为无头像即可。
import fengjinUrl from "../tast/风堇.png";
import klyUrl from "../tast/刻律德菈.png";
import changyeyueUrl from "../tast/长夜月.png";
import xiadiUrl from "../tast/遐蝶.png";
import tibaoUrl from "../tast/缇宝.png";
import aglaiyaUrl from "../tast/阿格莱雅.png";
import baierUrl from "../tast/白厄.png";
import danhengUrl from "../tast/丹恒.png";
import hysUrl from "../tast/海瑟音.png";
import nakexiaUrl from "../tast/那刻夏.png";
import saifeierUrl from "../tast/赛飞儿.png";
import wandiUrl from "../tast/万敌.png";

/** 立绘文件名 → 打包后 url */
const portraitByAssetFileName: Readonly<Record<string, string>> = {
  "风堇.png": fengjinUrl,
  "刻律德菈.png": klyUrl,
  "长夜月.png": changyeyueUrl,
  "遐蝶.png": xiadiUrl,
  "缇宝.png": tibaoUrl,
  "阿格莱雅.png": aglaiyaUrl,
  "白厄.png": baierUrl,
  "丹恒.png": danhengUrl,
  "海瑟音.png": hysUrl,
  "那刻夏.png": nakexiaUrl,
  "赛飞儿.png": saifeierUrl,
  "万敌.png": wandiUrl,
};

/** 立绘文件名查头像；非立绘池资源返回 null */
export function getCharacterPortraitByAssetFileName(assetFileName: string): string | null {
  return portraitByAssetFileName[assetFileName] ?? null;
}

/** 角色昵称查头像（昵称即文件名主干）；查不到返回 null */
export function getCharacterPortrait(nickname: string): string | null {
  return getCharacterPortraitByAssetFileName(`${nickname}.png`);
}
