import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const platform = readArg('platform', process.platform)
const arch = readArg('arch', process.arch)
const builderOs = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
const extension = platform === 'win32' ? '.exe' : ''
const packageRoot = resolve(desktopRoot, 'node_modules/agent-browser')
const source = resolve(packageRoot, 'bin', `agent-browser-${platform}-${arch}${extension}`)
const outputDir = resolve(desktopRoot, 'resources/agent-browser', `${builderOs}-${arch}`)
const output = resolve(outputDir, `agent-browser${extension}`)
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))

await mkdir(outputDir, { recursive: true })
await copyFile(source, output)
await copyFile(resolve(packageRoot, 'LICENSE'), resolve(outputDir, 'LICENSE'))
await writeFile(resolve(outputDir, 'VERSION'), `${packageJson.version}\n`, 'utf8')
if (platform !== 'win32') await chmod(output, 0o755)

console.log(`prepared agent-browser ${packageJson.version}: ${platform}/${arch} -> ${output}`)
