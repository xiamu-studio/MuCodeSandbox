// UTF-16 units match browser textarea and server validation; never truncate drafts.
export const TRANSLATION_INPUT_LIMIT = 16000;
export const TRANSLATION_OUTPUT_LIMIT = 64000;
export const TRANSLATION_MAX_TOKENS = 32768;
export const TRANSLATION_RESPONSE_BYTES = 524288;
export const TRANSLATION_TIMEOUT_SECONDS = 90;
export const TRANSLATION_MODEL = 'deepseek-flash';
export type TranslationDirection = 'auto' | 'en' | 'zh';
export type TranslationTarget = 'en' | 'zh';
export interface TranslationSettingsStatus { configured: boolean; provider: 'DeepSeek'; model: string }
export interface TextTranslation { text: string; provider: 'DeepSeek'; target: TranslationTarget; model: string }
export function translationTarget(text: string, direction: TranslationDirection): TranslationTarget {
  return direction === 'auto' ? /\p{Script=Han}/u.test(text) ? 'en' : 'zh' : direction;
}
