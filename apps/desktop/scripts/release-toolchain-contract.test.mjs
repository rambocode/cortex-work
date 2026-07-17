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

  it('runs the Windows packager through a cross-platform Node launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
    expect(packageJson.scripts?.['build:win-x64']).toBe('node scripts/build-win-x64.mjs')
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
    const finalizeStep = publishSteps.find((step) => step.name === 'Finalize GitHub release')
    expect(finalizeStep?.run).toContain('--json databaseId')
    expect(finalizeStep?.run).not.toContain('gh api "repos/$RELEASE_REPO/releases/tags/')
  })
})
