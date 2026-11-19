/**
 * Orders a key's available models for the assistant: newest stable Flash-Lite first (cheap,
 * ~1 s answers, rarely overloaded), then stable Flash (newest first), then the `-latest`
 * aliases, then other Flash variants. Pro, image, audio and embedding models are left out.
 */
export function rankGeminiModels(ids: string[]): string[] {
  const version = (id: string) => Number(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const byVersion = (a: string, b: string) => version(b) - version(a);
  const stableLite = ids.filter((m) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(m)).sort(byVersion);
  const stableFlash = ids.filter((m) => /^gemini-\d+(\.\d+)?-flash$/.test(m)).sort(byVersion);
  const aliases = ["gemini-flash-lite-latest", "gemini-flash-latest"].filter((m) => ids.includes(m));
  const ranked = [...stableLite, ...stableFlash, ...aliases];
  const others = ids
    .filter(
      (m) =>
        /^gemini-[\d.]+-flash/.test(m) &&
        !/image|tts|audio|live|embed|thinking|exp/.test(m) &&
        !ranked.includes(m),
    )
    .sort(byVersion);
  return [...ranked, ...others];
}
