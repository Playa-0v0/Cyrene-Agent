/**
 * Manifest 纯数据校验入口。
 *
 * 宿主与 SDK 共用同一份自动生成的 manifest.schema.json：结构、类型、
 * 枚举（deps 能力名单）和必填字段都在 Schema 里定义，加载器不再维护
 * 第二份字段白名单。Schema 校验不了的内容——入口文件存在性、符号
 * 链接越界、icon 规则、apiVersion 兼容性、id/SemVer 格式——仍由
 * loader.ts 的文件系统与格式校验完成，两层必须同时保留。
 */
import Ajv from "ajv";
import type { PluginManifestInput } from "./types";
import manifestSchema from "./manifest.schema.json";

const ajv = new Ajv({ strict: false });
const validate = ajv.compile(manifestSchema);

export interface ManifestValidationResult {
  ok: boolean;
  /** 校验通过时的规范化纯数据（defaultEnabled 保留可选语义）。 */
  value?: PluginManifestInput;
  /** 校验失败时的第一条人读错误，用于扫描日志。 */
  error?: string;
}

export function validateManifestData(data: unknown): ManifestValidationResult {
  if (!validate(data)) {
    const first = validate.errors?.[0];
    const instancePath = first?.instancePath ? `${first.instancePath} ` : "";
    return { ok: false, error: `manifest 结构不合法: ${instancePath}${first?.message ?? "未知错误"}` };
  }
  return { ok: true, value: data as PluginManifestInput };
}
