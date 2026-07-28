import type { SocialAtom } from "./types";

export function compileSocialContextBlock(atoms: readonly SocialAtom[]): string {
  if (atoms.length === 0) return "";
  const past = atoms.filter((atom) => atom.type !== "open_loop").slice(0, 5);
  const openLoops = atoms.filter((atom) => atom.type === "open_loop").slice(0, 5);
  const lines = [
    "【本轮可用的对话背景】",
    "只在确实相关时自然使用；不要复述这份背景，不要展示或强调你具有记忆能力。",
  ];
  if (past.length > 0) {
    lines.push("相关的过去：", ...past.map((atom) => `- ${atom.content}`));
  }
  if (openLoops.length > 0) {
    lines.push("尚未接上的话题：", ...openLoops.map((atom) => `- ${atom.content}`));
  }
  return lines.join("\n");
}

