// bento-embed 的单测:#bento-doc 块提取/注入的往返一致性与转义红线。
// 合同对齐上游 bento save.ts 的 serializeBody:块内容为 '\n' + JSON(`<`→`<`) + '\n'。
import { describe, expect, it } from 'vitest'
import { extractBentoDocJson, injectBentoDoc } from './bento-embed'

/** 最小化的 bento 空壳(结构对齐真实 runtime:head 内空 #bento-doc 块 + 其它脚本)。 */
const SHELL =
  '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n' +
  '<title>Bento Slides</title>\n' +
  '<script type="application/bento+json" id="bento-doc"></script>\n' +
  '<script type="text/plain" id="bento-rt">AAAA</script>\n' +
  '</head><body><div id="app"></div><script id="bento-loader">boot()</script></body></html>'

const doc = {
  format: 'bento/slides',
  version: 1,
  title: '测试<deck>',
  size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#111', accent: '#3b82d8', fontFamily: 'sans-serif' },
  slides: [
    {
      id: 's1',
      background: '#fff',
      transition: 'fade',
      // 藏一个 </script> 与 HTML 标签,验证转义后不破坏宿主 HTML
      elements: [{ id: 't1', type: 'text', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1, html: 'a<b>粗</b></script>' }],
      notes: '',
    },
  ],
}

describe('injectBentoDoc / extractBentoDocJson', () => {
  it('注入后可提取,JSON.parse 往返一致(含 </script> 与 < 的文本)', () => {
    const html = injectBentoDoc(SHELL, doc)
    expect(html).not.toBeNull()
    const back = extractBentoDocJson(html!)
    expect(back).not.toBeNull()
    expect(JSON.parse(back!)).toEqual(doc)
  })

  it('注入产物内不得出现裸的 </script> 增量(转义红线:script 闭合数与开启数一致)', () => {
    const html = injectBentoDoc(SHELL, doc)!
    const opens = html.match(/<script\b/g)?.length ?? 0
    const closes = html.split('</script>').length - 1
    expect(closes).toBe(opens)
  })

  it('注入会把 <title> 同步为文档标题', () => {
    const html = injectBentoDoc(SHELL, doc)!
    expect(html).toContain('<title>测试&lt;deck&gt; — Bento Slides</title>')
  })

  it('壳内无 #bento-doc 块时注入返回 null(损坏壳不静默产出坏文件)', () => {
    expect(injectBentoDoc('<html><head></head><body></body></html>', doc)).toBeNull()
  })

  it('空块(全新空壳)提取返回 null', () => {
    expect(extractBentoDocJson(SHELL)).toBeNull()
  })

  it('重复注入(覆盖旧文档)仍只有一个 #bento-doc 块', () => {
    const once = injectBentoDoc(SHELL, doc)!
    const twice = injectBentoDoc(once, { ...doc, title: 'v2' })!
    expect(twice.match(/id="bento-doc"/g)?.length).toBe(1)
    expect(JSON.parse(extractBentoDocJson(twice)!).title).toBe('v2')
  })
})
