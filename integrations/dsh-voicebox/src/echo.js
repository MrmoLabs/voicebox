// This checks a clear text match, not acoustic echo or semantic intent.
const comparable = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function isPlaybackEcho(text, reference) {
  const input = comparable(text);
  return [...input].length >= 8 && comparable(reference).includes(input);
}
