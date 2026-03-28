/**
 * Split large text into memory-sized chunks at paragraph boundaries.
 * Chunks overlap slightly to preserve context across boundaries.
 */
export function chunkText(
  text: string,
  maxChars: number = 2000,
  overlap: number = 200
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Start next chunk with overlap from end of current
      const overlapText = current.slice(-overlap);
      current = overlapText + "\n\n" + para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If we still have chunks that are too long (single paragraph bigger than max),
  // split at sentence boundaries
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      // Split at sentence boundaries
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let sub = "";
      for (const sentence of sentences) {
        if (sub.length + sentence.length + 1 > maxChars && sub.length > 0) {
          result.push(sub.trim());
          sub = sentence;
        } else {
          sub += (sub ? " " : "") + sentence;
        }
      }
      if (sub.trim()) result.push(sub.trim());
    }
  }

  return result;
}
