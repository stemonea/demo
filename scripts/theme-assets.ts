import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import type { Plugin } from 'vite'

/** Keep standalone browser icons and HTML metadata in sync with the CSS palette. */
export function themeAssets(): Plugin {
  let palettePath: string
  let templatePath: string
  let publicPath: string

  function readPalette() {
    const css = readFileSync(palettePath, 'utf8')
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1]
    if (!root) throw new Error('colours.css must contain a :root palette.')
    const tokens = new Map(
      [...root.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]),
    )
    function colour(name: string, visited = new Set<string>()): string {
      if (visited.has(name)) throw new Error(`Circular colour alias: ${name}`)
      visited.add(name)
      const value = tokens.get(name) ?? ''
      const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1]
      if (alias) return colour(alias, visited)
      if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
        throw new Error(`${name} in colours.css must be a hex colour or a var(--token) alias for icon/HTML generation.`)
      }
      return value
    }
    return colour
  }

  function writeAsset(name: string, content: string | Buffer) {
    const path = resolve(publicPath, name)
    const bytes = Buffer.from(content)
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) writeFileSync(path, bytes)
  }

  function syncIcons() {
    const colour = readPalette()
    const svg = readFileSync(templatePath, 'utf8').replace(/var\((--[\w-]+)\)/g, (_, name: string) => colour(name))
    // iOS supplies the corner mask; its source icon must fill the whole square.
    const appleSvg = svg.replace('rx="16"', 'rx="0"').replace(/\s*<rect x="\.5"[^>]+\/>/, '')
    writeAsset('icons.svg', svg)
    writeAsset('favicon-32.png', new Resvg(svg, { fitTo: { mode: 'width', value: 32 }, font: { loadSystemFonts: false } }).render().asPng())
    writeAsset('apple-touch-icon.png', new Resvg(appleSvg, { fitTo: { mode: 'width', value: 180 }, font: { loadSystemFonts: false } }).render().asPng())
  }

  return {
    name: 'argustream-theme-assets',
    configResolved(config) {
      palettePath = resolve(config.root, 'src/styles/colours.css')
      templatePath = resolve(config.root, 'scripts/logo.svg')
      publicPath = config.publicDir
    },
    buildStart() {
      syncIcons()
      this.addWatchFile(palettePath)
      this.addWatchFile(templatePath)
    },
    configureServer(server) {
      server.watcher.add([palettePath, templatePath])
    },
    handleHotUpdate(context) {
      if (context.file === palettePath || context.file === templatePath) {
        syncIcons()
        context.server.ws.send({ type: 'full-reload' })
        return []
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%THEME_COLOR%', readPalette()('--bg')),
    },
  }
}
