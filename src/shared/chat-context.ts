export interface TurnModelContextInput {
  fileHints?: string[];
  documentContextLines?: string[];
  imageCaptionLines?: string[];
  directImageLines?: string[];
}

export function buildTurnModelContext(input: TurnModelContextInput): string | undefined {
  const contextParts: string[] = [];

  if (input.fileHints?.length) {
    contextParts.push("【本轮文件】\n" + input.fileHints.join("\n"));
  }

  if (input.documentContextLines?.length) {
    contextParts.push("【文档内容】\n" + input.documentContextLines.join("\n\n"));
  }

  if (input.imageCaptionLines?.length) {
    contextParts.push(
      "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n" +
      input.imageCaptionLines.join("\n"),
    );
  }

  if (input.directImageLines?.length) {
    contextParts.push(
      "【图片附件】\n以下图片已随本轮消息直接发送给主模型，请直接结合图片内容回答。\n" +
      input.directImageLines.join("\n"),
    );
  }

  return contextParts.length > 0 ? contextParts.join("\n\n") : undefined;
}
