export type AskFieldType = "single_select" | "multi_select" | "text";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskMissingField {
  field: string;
  reason: string;
  required: boolean;
  questionHint?: string;
  typeHint?: AskFieldType;
  allowedOptions?: AskOption[];
  candidateHints?: string[];
  allowCustom?: boolean;
}

export interface TrustedAskUserProfile {
  callPreference?: string;
  nickname?: string;
  gender?: "male" | "female" | "nonbinary" | "unknown" | "secret";
}

export interface AskClarificationInput {
  userRequest: string;
  missingFields: AskMissingField[];
  trustedUserProfile?: TrustedAskUserProfile;
  recentAddressedUser?: boolean;
}

export interface AskQuestion {
  field: string;
  question: string;
  type: AskFieldType;
  options: AskOption[];
  allowCustom: boolean;
  freeTextPlaceholder: string;
}

export interface AskClarificationOutput {
  intro: string;
  questions: AskQuestion[];
  deferredFields: string[];
}

export interface AskClarificationCard {
  intro: string;
  questions: AskQuestion[];
  deferredFields: string[];
}

export interface AskUserAnswer {
  requestId: string;
  answers: Array<{
    field: string;
    selectedValues?: string[];
    customText?: string;
  }>;
}
