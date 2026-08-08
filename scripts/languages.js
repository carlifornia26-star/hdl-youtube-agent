// One video/day, English narration only. These 15 languages get a translated caption track AND
// a translated title/description (via YouTube's `localizations` field) on that one video.
//
// This is the "top 15 most spoken languages" list (Ethnologue, 2026), with two substitutions:
// Nigerian Pidgin and Egyptian Arabic aren't supported as distinct languages by the translation
// model (m2m100), so they're swapped for Swahili and Vietnamese — the next-largest languages the
// model actually covers, keeping the list at a genuine 15.
export const CAPTION_LANGUAGES = [
  "zh", // Mandarin Chinese
  "hi", // Hindi
  "es", // Spanish
  "ar", // Standard Arabic
  "fr", // French
  "bn", // Bengali
  "pt", // Portuguese
  "id", // Indonesian
  "ur", // Urdu
  "ru", // Russian
  "de", // German
  "ja", // Japanese
  "sw", // Swahili (substitute for Nigerian Pidgin)
  "vi", // Vietnamese (substitute for Egyptian Arabic)
];
// English itself is the video's base language, not in this list — 14 translated + English = 15 total.
