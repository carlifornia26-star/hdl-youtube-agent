// Pure YouTube upload preflight. No API calls, truncation, substitutions or mutation.
// Limits: https://developers.google.com/youtube/v3/docs/videos
export function validateUploadMetadata({ title, description, localizations = {} }) {
  function text(value, path, { titleField = false } = {}) {
    if (typeof value !== "string") throw new Error(`Invalid YouTube metadata ${path}: expected a string`);
    if (titleField && !value.trim()) throw new Error(`Invalid YouTube metadata ${path}: blank title`);
    if (/[<>]/u.test(value)) throw new Error(`Invalid YouTube metadata ${path}: prohibited angle bracket`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`Invalid YouTube metadata ${path}: control character`);
    for (const char of value) {
      const point = char.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) throw new Error(`Invalid YouTube metadata ${path}: unpaired surrogate`);
    }
    if (titleField && Array.from(value).length > 100) throw new Error(`Invalid YouTube metadata ${path}: title exceeds 100 characters`);
    if (!titleField && Buffer.byteLength(value, "utf8") > 5000) throw new Error(`Invalid YouTube metadata ${path}: description exceeds 5000 UTF-8 bytes`);
  }
  text(title, "snippet.title", { titleField: true });
  text(description, "snippet.description");
  if (!localizations || typeof localizations !== "object" || Array.isArray(localizations)) throw new Error("Invalid YouTube metadata localizations: expected an object");
  for (const [language, entry] of Object.entries(localizations)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid YouTube metadata localizations.${language}: expected an object`);
    text(entry.title, `localizations.${language}.title`, { titleField: true });
    text(entry.description, `localizations.${language}.description`);
  }
  return true;
}
