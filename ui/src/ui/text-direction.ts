/**
 * RTL (Right-to-Left) text direction detection.
 * Detects Hebrew, Arabic, Syriac, Thaana, Nko, Samaritan, Mandaic, Adlam,
 * Phoenician, and Lydian scripts using Unicode Script Properties.
 */

const RTL_CHAR_REGEX =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\u08A0-\u08FF\u{10900}-\u{1091F}\u{10920}-\u{1093F}\u{1E900}-\u{1E95F}]/u;

const DEFAULT_SKIP_PATTERN = /[\s!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/;

/**
 * Detect text direction from the first significant character.
 * @param text - The text to check
 * @param skipPattern - Characters to skip when looking for the first significant char.
 *   Defaults to whitespace and Unicode punctuation/symbols.
 */
export function detectTextDirection(
  text: string | null,
  skipPattern: RegExp = DEFAULT_SKIP_PATTERN,
): "rtl" | "ltr" {
  if (!text) {
    return "ltr";
  }
  for (const char of text) {
    if (skipPattern.test(char)) {
      continue;
    }
    return RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
  }
  return "ltr";
}
