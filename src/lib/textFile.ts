/** Bytes a page will accept from a dropped transcript. */
export const MAX_TEXT_BYTES = 400_000

export interface ReadResult {
  text: string
  error: string | null
}

/**
 * Reads a dropped file as text, refusing the same things in the same words
 * everywhere. `extensions` is what the calling page is prepared to parse: the
 * transcript views take plain text only, the annotator also takes the formats
 * it can write back out.
 */
export async function readTextFile(
  file: File | undefined | null,
  extensions: string[] = ['txt'],
): Promise<ReadResult> {
  const fail = (error: string): ReadResult => ({ text: '', error })
  if (!file) return fail('No file arrived. Drop a transcript here, or choose one.')

  const pattern = new RegExp(`\\.(${extensions.join('|')})$`, 'i')
  if (!pattern.test(file.name)) {
    return fail(`\u201c${file.name}\u201d is not a file this page can read. Drop a ${spell(extensions)} transcript instead.`)
  }
  if (file.size > MAX_TEXT_BYTES) {
    return fail(`That file is ${Math.round(file.size / 1024)} KB, and the limit is 400 KB. Drop a shorter transcript.`)
  }

  try {
    const content = await file.text()
    return { text: content.replace(/\r\n?/g, '\n').trim(), error: null }
  } catch {
    return fail('That file could not be read. Check that it is still where it was, then drop it again.')
  }
}

/** ".txt", or ".json, .tsv or .xml" \u2014 a list a sentence can carry. */
function spell(extensions: string[]): string {
  const dotted = extensions.map((extension) => `.${extension}`)
  if (dotted.length === 1) return dotted[0]
  return `${dotted.slice(0, -1).join(', ')} or ${dotted[dotted.length - 1]}`
}
