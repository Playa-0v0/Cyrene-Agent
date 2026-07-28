export type StructuredErrorLayer = "transport" | "format" | "schema" | "business";

export type StructuredErrorDisposition =
  | "repair"
  | "ask_user"
  | "refresh_state"
  | "execution_policy"
  | "fail_closed";

export interface StructuredValidationError {
  layer: StructuredErrorLayer;
  code: string;
  disposition: StructuredErrorDisposition;
  path?: string;
}

