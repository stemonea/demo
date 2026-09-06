/**
 * The alphabet the generated noise is drawn from — marks and letters, not
 * words, so a run of it reads as a model mid-generation rather than as text.
 * Shared by the hero field and by the hover effect, so the two are visibly the
 * same substance.
 */
export const GLYPHS =
  '░╱╲│─┆┊·:;.,~^*+=-_/\\|<>()[]{}#%&$§¶†‡0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * The subset a run of noise is drawn from when it is set in the display face
 * rather than in the monospace one.
 *
 * The full alphabet above contains the shaded block and the box-drawing rules,
 * which the display face does not carry: setting them in it makes the browser
 * fall back to another font mid-animation, whose metrics are not the display
 * face's, and the line the heading sits on grows and shrinks with them. These
 * are the marks that face does have, so a heading being scrambled stays the
 * size it was.
 */
export const TEXT_GLYPHS =
  '·:;.,~^*+=-_/\\|<>()[]{}#%&$0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]

/** A run of `length` random glyphs, from `alphabet`. */
export function noise(length: number, alphabet: string = GLYPHS): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
