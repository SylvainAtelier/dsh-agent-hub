/** IBM Plex Mono fixed faces; only UI/code weights and Latin subsets are bundled. */
import latin400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'
import latin500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'
import latin600 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2'
import latin700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2'
import latinExt400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-normal.woff2'
import latinExt500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-500-normal.woff2'
import latinExt600 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-600-normal.woff2'
import latinExt700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-700-normal.woff2'
import type { FaceSource } from './chunk.ts'

const latin = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const latinExt = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

export const FACES: readonly FaceSource[] = [
  { data: latin400, unicodeRange: latin, weight: '400' },
  { data: latin500, unicodeRange: latin, weight: '500' },
  { data: latin600, unicodeRange: latin, weight: '600' },
  { data: latin700, unicodeRange: latin, weight: '700' },
  { data: latinExt400, unicodeRange: latinExt, weight: '400' },
  { data: latinExt500, unicodeRange: latinExt, weight: '500' },
  { data: latinExt600, unicodeRange: latinExt, weight: '600' },
  { data: latinExt700, unicodeRange: latinExt, weight: '700' },
]
