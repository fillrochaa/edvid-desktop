import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

const macSigningIdentity = process.env.EDVID_MAC_SIGN_IDENTITY?.trim();

// Notarizacao so entra quando as tres credenciais estiverem no ambiente:
// EDVID_APPLE_ID (e-mail da conta), EDVID_APPLE_APP_PASSWORD (senha de app
// gerada em appleid.apple.com) e EDVID_APPLE_TEAM_ID. Sem elas o build segue
// local (ad-hoc), como sempre.
const appleId = process.env.EDVID_APPLE_ID?.trim();
const appleAppPassword = process.env.EDVID_APPLE_APP_PASSWORD?.trim();
const appleTeamId = process.env.EDVID_APPLE_TEAM_ID?.trim();
const canNotarize = Boolean(macSigningIdentity && appleId && appleAppPassword && appleTeamId);

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.creatorfactory.edvid',
    appCategoryType: 'public.app-category.video',
    icon: path.resolve('src/brand/edvid-icon'),
    asar: true,
    extraResource: [
      'resources/runtime-manifest.json',
      'resources/runtimes',
      'resources/remotion-template',
      'resources/helpers',
    ],
    osxSign:
      process.platform === 'darwin'
        ? {
            identity: macSigningIdentity || '-',
            identityValidation: Boolean(macSigningIdentity),
            optionsForFile: macSigningIdentity
              ? () => ({
                  // Producao: Hardened Runtime e entitlements que cobrem o V8
                  // e os runtimes embutidos (Python/PyTorch, FFmpeg, Node).
                  hardenedRuntime: true,
                  entitlements: path.resolve('entitlements.mac.plist'),
                })
              : () => ({ entitlements: path.resolve('entitlements.mac.dev.plist') }),
          }
        : undefined,
    osxNotarize: canNotarize
      ? {
          appleId: appleId as string,
          appleIdPassword: appleAppPassword as string,
          teamId: appleTeamId as string,
        }
      : undefined,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'edvid', setupIcon: path.resolve('src/brand/edvid-icon.ico') }),
    new MakerDMG(
      {
        background: path.resolve('src/brand/dmg-background.png'),
        icon: path.resolve('src/brand/edvid-icon.icns'),
        iconSize: 104,
        contents: (options) => [
          {
            x: 180,
            y: 220,
            type: 'file',
            path: options.appPath,
          },
          {
            x: 480,
            y: 220,
            type: 'link',
            path: '/Applications',
          },
        ],
        additionalDMGOptions: {
          window: {
            position: { x: 160, y: 80 },
            size: { width: 660, height: 400 },
          },
        },
      },
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Edvid does not persist Electron cookies. Keeping this fuse disabled avoids
      // initializing Chromium Safe Storage (and prompting for the macOS Keychain)
      // while Codex authentication remains isolated in its own CODEX_HOME.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
