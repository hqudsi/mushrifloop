/** One third-party package that ships inside the app, as Settings → About lists it (SPEC.md §11). */

/** `main`: loaded by the main process; `renderer`: bundled into the UI; `runtime`: Electron itself. */
export type LicenseUse = 'main' | 'renderer' | 'runtime';

export interface LicenseEntry {
  name: string;
  version: string;
  /** SPDX expression from package.json, or "UNKNOWN". */
  license: string;
  /** Copyright lines found in the license file. */
  copyright: string[];
  /** package.json `author`, for packages whose license file names no copyright holder. */
  author: string | null;
  homepage: string | null;
  /** The license file as shipped, or null when the package has none. */
  text: string | null;
  usedBy: LicenseUse[];
}
