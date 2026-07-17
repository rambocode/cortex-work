import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import electronViteConfig from '../electron.vite.config.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')

describe('desktop release toolchain contract', () => {
  it('keeps Cortex_Helper compatible with the macos-15 runner Swift toolchain', () => {
    const manifest = readFileSync(resolve(desktopRoot, 'native/Cortex_Helper/Package.swift'), 'utf8')
    expect(manifest.split('\n', 1)[0]).toBe('// swift-tools-version: 6.1')
  })

  it('treats node-mac-permissions as an optional platform dependency', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.dependencies?.['node-mac-permissions']).toBeUndefined()
    expect(packageJson.optionalDependencies?.['node-mac-permissions']).toBe('^2.5.0')
  })

  it('externalizes the optional native module from the main-process bundle', () => {
    const mainPlugins = electronViteConfig.main?.plugins ?? []
    const externalizePlugin = mainPlugins.flat().find((plugin) => plugin?.name === 'vite:externalize-deps')
    const config = {}
    externalizePlugin.config(config)
    expect(config.build.rollupOptions.external).toContain('node-mac-permissions')
  })
})
