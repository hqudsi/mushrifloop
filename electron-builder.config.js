/**
 * Windows packaging (SPEC.md §12 phase 6, NOTES.md §32).
 *
 *   npm run pack        # builds, then writes release/ — NSIS installer + portable exe, x64
 *
 * Everything that names the app is derived from APP_NAME, so a rename stays a one-line change
 * (CLAUDE.md): the product name, the install folder, the shortcut, the appId — which must keep
 * matching the AppUserModelID `main.ts` sets, or Windows notifications and the taskbar grouping
 * come apart — and the copyright line.
 *
 * This is a JS config rather than YAML because those values live in TypeScript: it reads them from
 * the compiled `dist/shared/app-config.js`, which `npm run pack` builds first.
 *
 * Not signed, and there is no auto-update (SPEC.md §13). NOTES.md §32 says what SmartScreen does.
 */

const fs = require('node:fs');
const path = require('node:path');

const COMPILED = path.join(__dirname, 'dist', 'shared', 'app-config.js');
if (!fs.existsSync(COMPILED)) {
  throw new Error(`${COMPILED} is missing — run \`npm run build:main\` first (npm run pack does).`);
}
const { APP_NAME, APP_SLUG, APP_COPYRIGHT } = require(COMPILED);

module.exports = {
  appId: `com.${APP_SLUG}.app`,
  productName: APP_NAME,
  copyright: APP_COPYRIGHT,
  directories: { output: 'release', buildResources: 'assets' },

  // The app is dist/ plus package.json; everything else (src, bench, schemas…) is either not needed
  // at runtime or ships as a resource below.
  files: [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/browser/**/*',
    'dist/shared/**/*',
    '!**/*.map',
    'package.json',
  ],

  /**
   * schemas/, agents/ and assets/ ship next to the asar, not inside it: `resourceRoot()` points at
   * `process.resourcesPath` in a packaged build, and these have to stay ordinary files on disk —
   * the icon is handed to Windows, and a path inside an asar is not a file any other process can
   * open.
   */
  extraResources: [
    { from: 'schemas', to: 'schemas' },
    { from: 'agents', to: 'agents' },
    // The NSIS include is a build input, not something the app ships.
    { from: 'assets', to: 'assets', filter: ['**/*', '!*.nsh'] },
  ],

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'assets/icon.ico',
    // No publisherName: in electron-builder 26 it belongs to the signing options, and this build is
    // unsigned. The publisher Windows shows comes from package.json's `author`.
    artifactName: '${productName}-${version}-${arch}-setup.${ext}',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: APP_NAME,
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    installerHeaderIcon: 'assets/icon.ico',
    // The app's own data (settings.json, tasks/) is the user's, and an uninstall must not take it:
    // it lives in %APPDATA%/<APP_NAME>, which the uninstaller never touches (NOTES.md §32).
    deleteAppDataOnUninstall: false,
    // … but the caches it leaves in %LOCALAPPDATA% do go, including the 111 MB copy of the
    // installer NSIS keeps for an auto-update this app does not have.
    include: 'assets/uninstaller.nsh',
  },

  portable: {
    artifactName: '${productName}-${version}-${arch}-portable.${ext}',
    // A stable folder, so a portable run reuses one unpack directory instead of a fresh temp one.
    unpackDirName: `${APP_NAME}-portable`,
  },

  // No signing, no auto-update (SPEC.md §13).
  forceCodeSigning: false,
  npmRebuild: false,
  electronDownload: { cache: path.join(__dirname, '.electron-cache') },
};
