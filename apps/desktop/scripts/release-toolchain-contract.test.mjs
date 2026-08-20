import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
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

  it('keeps the renderer-only views workspace out of packaged production dependencies', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.dependencies?.['@cortex-work/views']).toBeUndefined()
    expect(packageJson.devDependencies?.['@cortex-work/views']).toBe('workspace:*')
  })

  it('runs the Windows packager through a cross-platform Node launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.scripts?.['build:win-x64']).toBe('node scripts/build-win-x64.mjs')
  })

  it('pins and prepares the target agent-browser binary before every platform package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.dependencies?.['agent-browser']).toBe('0.31.1')
    expect(packageJson.scripts?.['prepare:agent-browser']).toBe('node scripts/prepare-agent-browser.mjs')
    expect(packageJson.scripts?.['prepackage:mac-arm64']).toContain(
      'pnpm run prepare:agent-browser -- --platform darwin --arch arm64',
    )
    expect(packageJson.scripts?.['prepackage:mac-x64']).toContain(
      'pnpm run prepare:agent-browser -- --platform darwin --arch x64',
    )
    expect(packageJson.scripts?.['prepackage:win-x64']).toContain(
      'pnpm run prepare:agent-browser -- --platform win32 --arch x64',
    )

    const builderConfig = load(readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf8'))
    expect(builderConfig.extraResources).toContainEqual({
      from: 'resources/agent-browser/${os}-${arch}',
      to: 'agent-browser',
    })
  })

  it('uses a Windows artifact name that matches the updater manifest URL', () => {
    const builderConfig = load(readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf8'))
    expect(builderConfig.win?.artifactName).toBe('${productName}-Setup-${version}.${ext}')
  })

  it('publishes macOS auto-updates as ZIP-only assets', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.scripts?.['build:mac-arm64']).toBe(
      'electron-builder --mac zip --arm64 --publish never',
    )
    expect(packageJson.scripts?.['build:mac-x64']).toBe(
      'electron-builder --mac zip --x64 --publish never',
    )

    const builderConfig = load(readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf8'))
    expect(builderConfig.mac?.target).toEqual([{ target: 'zip', arch: ['arm64', 'x64'] }])

    const localRelease = readFileSync(resolve(desktopRoot, '../../scripts/local-release-mac.sh'), 'utf8')
    const releaseUi = readFileSync(resolve(desktopRoot, '../../scripts/release-ui/steps.mjs'), 'utf8')
    const workflow = readFileSync(resolve(desktopRoot, '../../.github/workflows/desktop-release.yml'), 'utf8')
    expect(localRelease).not.toContain('.dmg')
    expect(releaseUi).not.toContain('.dmg')
    expect(workflow).not.toContain('.dmg')
  })

  it('bypasses Actions artifact storage when publishing a release', () => {
    const workflow = load(
      readFileSync(resolve(desktopRoot, '../../.github/workflows/desktop-release.yml'), 'utf8'),
    )
    const publishModesCondition = "!contains(fromJSON('[\"publish-self\", \"publish-draft\", \"publish-release\"]')"

    expect(workflow.jobs['prepare-release']).toBeDefined()

    for (const jobName of ['build-macos-arm64', 'build-macos-x64', 'build-windows-x64']) {
      const steps = workflow.jobs[jobName].steps
      const workflowArtifactStep = steps.find((step) => step.name === 'Upload workflow artifact')
      const directReleaseStep = steps.find((step) => step.name === 'Upload assets directly to draft release')

      expect(workflowArtifactStep?.if).toContain(publishModesCondition)
      expect(directReleaseStep?.if).toContain('contains(fromJSON')
      expect(directReleaseStep?.run).toContain('gh release upload')
    }

    const publishSteps = workflow.jobs.publish.steps
    expect(publishSteps.some((step) => step.uses?.startsWith('actions/download-artifact@'))).toBe(false)
    expect(publishSteps.find((step) => step.name === 'Download release manifests')?.run).toContain(
      'gh release download',
    )
    expect(publishSteps.find((step) => step.name === 'Verify draft release asset inventory')?.run).toContain(
      '${product_name}-Setup-${version}.exe',
    )
    const finalizeStep = publishSteps.find((step) => step.name === 'Finalize GitHub release')
    expect(finalizeStep?.run).toContain('--json databaseId')
    expect(finalizeStep?.run).not.toContain('gh api "repos/$RELEASE_REPO/releases/tags/')
  })
})
