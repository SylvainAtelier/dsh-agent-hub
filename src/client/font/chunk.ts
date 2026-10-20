/**
 * Fira Code (variable, weights 300–700), built into its own lazy chunk
 * (`lib/client.font.fira-code.js`). Each Unicode subset
 * is a separate face, so a page decodes only the subsets its text needs.
 * SIL Open Font License 1.1: lib/FiraCode-OFL.txt.
 */

import latin from '@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2'
import latinExt from '@fontsource-variable/fira-code/files/fira-code-latin-ext-wght-normal.woff2'
import symbols2 from '@fontsource-variable/fira-code/files/fira-code-symbols2-wght-normal.woff2'
import greek from '@fontsource-variable/fira-code/files/fira-code-greek-wght-normal.woff2'
import greekExt from '@fontsource-variable/fira-code/files/fira-code-greek-ext-wght-normal.woff2'
import cyrillic from '@fontsource-variable/fira-code/files/fira-code-cyrillic-wght-normal.woff2'
import cyrillicExt from '@fontsource-variable/fira-code/files/fira-code-cyrillic-ext-wght-normal.woff2'

export interface FaceSource {
  /** The woff2 file, base64. */
  data: string
  unicodeRange: string
  /** Omitted by variable fonts; fixed-face families set the exact weight. */
  weight?: string
  style?: string
}

// Ranges from @fontsource-variable/fira-code's unicode.json.
export const FACES: readonly FaceSource[] = [
  { data: latin, unicodeRange: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  { data: latinExt, unicodeRange: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  { data: symbols2, unicodeRange: 'U+2000-2001,U+2004-2008,U+200A,U+23B8-23BD,U+2500-259F' },
  { data: greek, unicodeRange: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF' },
  { data: greekExt, unicodeRange: 'U+1F00-1FFF' },
  { data: cyrillic, unicodeRange: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' },
  { data: cyrillicExt, unicodeRange: 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F' },
]
