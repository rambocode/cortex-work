// 回归(用户实测):deck 文件从 488KB 涨到 1,583,043 字节,里面有 11 个 <style>、其中 10 个是
// 完全相同的 92,449 字节应用 CSS —— 压缩 runtime 的 loader 在 main.ts 之前就把应用 CSS 注入了
// <head>,而 save.ts 的 capturePristine() 克隆的是注入之后的活 DOM,于是每个「发生过保存的
// 世代」都会把这份 CSS 再烙进文件一次,一路逼近 fs:readFile 的 2MB 截断线。
// 本单测把「重复 <style> 垃圾」按等价形态手工造出来(真实 loader 的注入无法在 node 下复现),
// 断言规范化后壳里只剩一份、而 #bento-doc 块逐字节不动。
import { describe, expect, it } from 'vitest'
import { extractBentoDocJson, injectBentoDocJson } from './bento-embed'
import { normalizeDeckHtml } from './normalize-deck-html'

/** 模拟被反复烙进文件的应用 CSS(真实体积 92KB,这里只要「够大且完全相同」)。 */
const APP_CSS = '.bento-el{position:absolute;box-sizing:border-box}'.repeat(40)

/** 当前 runtime 空壳:结构对齐真实产物(空 #bento-doc 块 + 唯一一份应用 CSS)。 */
const RUNTIME_SHELL =
  '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n' +
  '<title>演示文稿</title>\n' +
  '<meta name="cortex-slides-runtime" content="runtime-b">\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  `<style id="bento-css">${APP_CSS}</style>\n` +
  '<script type="text/plain" id="bento-rt">RUNTIME-B-PAYLOAD</script>\n' +
  '</head><body><div id="app"></div><script id="bento-loader">boot()</script></body></html>'

/** 存量 deck:壳里多出 `copies` 份完全相同的 <style>(每个保存世代烙一份)。 */
function bloatedDeck(docJson: string, copies = 3): string {
  const withDoc = injectBentoDocJson(RUNTIME_SHELL, docJson)!
  const junk = `<style>${APP_CSS}</style>\n`.repeat(copies)
  return withDoc.replace('</head>', `${junk}</head>`)
}

/** 键序刻意不按 canonical 排,缩进为 2 空格 —— 用来验证「原文透传」不做 stringify。 */
const PRETTY_DOC_JSON = [
  '{',
  '  "slides": [',
  '    { "id": "s1", "elements": [{ "id": "e1", "type": "text", "html": "第一页" }], "notes": "" }',
  '  ],',
  '  "title": "季度汇报",',
  '  "format": "bento/slides",',
  '  "version": 1',
  '}'
].join('\n')

const byteLength = (text: string): number => new TextEncoder().encode(text).length

describe('normalizeDeckHtml', () => {
  it('把 doc 块搬到当前 runtime 壳,重复 <style> 垃圾全部消失且 doc 块逐字节保留', () => {
    const incoming = bloatedDeck(PRETTY_DOC_JSON)
    expect(incoming.match(/<style/g)).toHaveLength(4)

    const result = normalizeDeckHtml(incoming, RUNTIME_SHELL)
    expect(result).toMatchObject({ ok: true, mode: 'reshelled', stripped: [] })
    if (!result.ok) return

    expect(result.html.match(/<style/g)).toHaveLength(1)
    // doc 块逐字节等于传入的那一份(既不重排键序,也不改缩进)
    expect(extractBentoDocJson(result.html)).toBe(extractBentoDocJson(incoming))
    expect(result.html).toContain('\n  "slides": [')
    // 壳换成了当前 runtime 的载荷,<title> 跟着文档标题走
    expect(result.html).toContain('RUNTIME-B-PAYLOAD')
    expect(result.html).toContain('<title>季度汇报</title>')
  })

  it('产物字节数小于传入(治体积膨胀是这个模块存在的唯一理由)', () => {
    const incoming = bloatedDeck(PRETTY_DOC_JSON, 9)
    const result = normalizeDeckHtml(incoming, RUNTIME_SHELL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(byteLength(result.html)).toBeLessThan(byteLength(incoming))
  })

  it('幂等:对产物再跑一次得到完全相同的字符串(否则每次保存都会 churn 出无意义 diff)', () => {
    const once = normalizeDeckHtml(bloatedDeck(PRETTY_DOC_JSON), RUNTIME_SHELL)
    expect(once.ok).toBe(true)
    if (!once.ok) return
    const twice = normalizeDeckHtml(once.html, RUNTIME_SHELL)
    expect(twice).toEqual(once)
  })

  it('不改动入参(纯函数)', () => {
    const incoming = bloatedDeck(PRETTY_DOC_JSON)
    const snapshot = incoming
    normalizeDeckHtml(incoming, RUNTIME_SHELL)
    expect(incoming).toBe(snapshot)
  })

  it('带 collab 的存量 deck:产物不含 collab,stripped 报告剥离项', () => {
    const withCollab = JSON.stringify({
      format: 'bento/slides',
      version: 1,
      title: 'deck',
      collab: { room: 'wss://sync.bento.page/d/wXXXX', key: 'k', on: true, sync: { v: 2, lamport: 98 } },
      slides: [{ id: 's1', elements: [], notes: '' }]
    })
    const result = normalizeDeckHtml(bloatedDeck(withCollab), RUNTIME_SHELL)
    expect(result).toMatchObject({ ok: true, mode: 'reshelled', stripped: ['collab'] })
    if (!result.ok) return
    expect(result.html).not.toContain('sync.bento.page')
    expect(JSON.parse(extractBentoDocJson(result.html)!)).not.toHaveProperty('collab')
    expect(JSON.parse(extractBentoDocJson(result.html)!).slides).toHaveLength(1)
  })

  // 转义红线:JSON 里的 `<` 必须变成 <,否则正文里的 </script> 会提前闭合宿主脚本。
  // 两条路径都要覆盖:原文透传(无 collab)与 stringify 重写(有 collab)。
  it('doc JSON 含 </script> 与 U+2028 时产物仍可被读回,且 script 开闭数不失衡', () => {
    const payload = {
      format: 'bento/slides',
      title: 'a<b>标题</b>',
      slides: [{ id: 's1', elements: [{ id: 'e1', type: 'text', html: '</script><img src=x>  末' }], notes: '' }]
    }
    for (const doc of [payload, { ...payload, collab: { on: true, room: 'wss://x' } }]) {
      const result = normalizeDeckHtml(bloatedDeck(JSON.stringify(doc)), RUNTIME_SHELL)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const back = extractBentoDocJson(result.html)
      expect(back).not.toBeNull()
      expect(JSON.parse(back!).slides).toEqual(payload.slides)
      const opens = result.html.match(/<script\b/g)?.length ?? 0
      const closes = result.html.split('</script>').length - 1
      expect(closes).toBe(opens)
    }
  })

  // 加密 deck:块里是 bento/enc 信封,既无法 sanitize 也不该在这里猜结构 —— 原样保存。
  it('bento/enc 信封走 passthrough,产物与传入完全一致', () => {
    const envelope = JSON.stringify({ format: 'bento/enc', v: 1, it: 300000, salt: 's', iv: 'i', data: 'cipher' })
    const incoming = bloatedDeck(envelope)
    const result = normalizeDeckHtml(incoming, RUNTIME_SHELL)
    expect(result).toEqual({ ok: true, html: incoming, mode: 'passthrough', stripped: [] })
  })

  it('JSON 解析失败走 passthrough(宁可不动,也不要写坏用户的文件)', () => {
    const incoming = injectBentoDocJson(RUNTIME_SHELL, '{"format":"bento/slides",')!
    const result = normalizeDeckHtml(incoming, RUNTIME_SHELL)
    expect(result).toEqual({ ok: true, html: incoming, mode: 'passthrough', stripped: [] })
  })

  it('doc 块不是对象(数组/字符串)时走 passthrough', () => {
    for (const json of ['[1,2,3]', '"just text"', 'null', '42']) {
      const incoming = injectBentoDocJson(RUNTIME_SHELL, json)!
      expect(normalizeDeckHtml(incoming, RUNTIME_SHELL)).toEqual({
        ok: true,
        html: incoming,
        mode: 'passthrough',
        stripped: []
      })
    }
  })

  it('空字符串 / 无 #bento-doc 块 / 空块 → no_doc_block', () => {
    for (const incoming of ['', '<html><head></head><body>x</body></html>', RUNTIME_SHELL]) {
      const result = normalizeDeckHtml(incoming, RUNTIME_SHELL)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('no_doc_block')
      expect(result.message).toBeTruthy()
    }
  })

  it('runtime 壳缺 #bento-doc 块 → bad_shell(损坏的壳绝不静默产出坏文件)', () => {
    const result = normalizeDeckHtml(bloatedDeck(PRETTY_DOC_JSON), '<html><head></head><body></body></html>')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('bad_shell')
    expect(result.message).toBeTruthy()
  })
})
