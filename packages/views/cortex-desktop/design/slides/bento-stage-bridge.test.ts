// 注入式桥的页内合同测试:shim 源码是字符串,直接在测试里 eval 到一个假 window 上,
// 验证保存 drain、作者名刷新、选区 seq 三条语义 —— 这些坑在真机上只表现为「静默不生效」。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  APPLY_BENTO_DOC_SOURCE,
  DRAIN_BENTO_SAVE_SOURCE,
  READ_BENTO_SELECTION_SOURCE,
  buildBentoHostShimSource,
  parseBentoApplyResult,
  parseBentoSaveDrain
} from './bento-stage-bridge'

type FakeWindow = Record<string, unknown>

/** 在隔离的假 window 上执行 shim / 表达式,模拟 webview 的 executeJavaScript。 */
function makeRunner(): { win: FakeWindow; run: (source: string) => unknown } {
  const win: FakeWindow = {}
  const run = (source: string): unknown =>
    new Function('window', `return (${source})`)(win)
  return { win, run }
}

describe('buildBentoHostShimSource', () => {
  let ctx: ReturnType<typeof makeRunner>
  beforeEach(() => {
    ctx = makeRunner()
  })

  it('注入后挂上宿主契约:save / selectionChanged / authorName', () => {
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
    const host = ctx.win.cortexSlidesHost as Record<string, unknown>
    expect(typeof host.save).toBe('function')
    expect(typeof host.selectionChanged).toBe('function')
    expect(host.authorName).toBe('我')
  })

  it('保存只留最新一份,drain 取后即清', () => {
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
    const host = ctx.win.cortexSlidesHost as { save: (html: string) => unknown }
    host.save('<html>v1</html>')
    host.save('<html>v2</html>')
    expect(ctx.run(DRAIN_BENTO_SAVE_SOURCE)).toBe('<html>v2</html>')
    expect(ctx.run(DRAIN_BENTO_SAVE_SOURCE)).toBeNull()
  })

  // 这是原实现的真实缺陷:首行 `if (window.__cortexDrainDeckSave) return true` 直接短路,
  // dom-ready 重注时作者名永远停在首次注入的值。
  it('重复注入是幂等的,但 authorName 必须被刷新', () => {
    ctx.run(buildBentoHostShimSource({ authorName: '旧名' }))
    const host = ctx.win.cortexSlidesHost as { save: (html: string) => unknown }
    host.save('<html>pending</html>')

    ctx.run(buildBentoHostShimSource({ authorName: '新名' }))
    expect((ctx.win.cortexSlidesHost as Record<string, unknown>).authorName).toBe('新名')
    // 幂等:不能把已暂存但未 drain 的保存冲掉
    expect(ctx.run(DRAIN_BENTO_SAVE_SOURCE)).toBe('<html>pending</html>')
  })

  it('作者名缺失时不注入该字段,让页内回退到自己问', () => {
    ctx.run(buildBentoHostShimSource({}))
    expect((ctx.win.cortexSlidesHost as Record<string, unknown>).authorName).toBeUndefined()
  })

  // 第三道防协作闸(前两道在主进程剥离 collab、vendor 不建 SyncSession):
  // 存量 deck 已带 collab 且 runtime 尚未重建的窗口期,靠这个偏好挡住 joinFromDoc。
  it('注入时置上 bento-offline 偏好(切断在线中继)', () => {
    const store = new Map<string, string>()
    ctx.win.localStorage = {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null
    }
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
    expect(store.get('bento-offline')).toBe('on')
  })

  it('幂等重注时也会重新置位(用户可能在设置里手动取消过)', () => {
    const store = new Map<string, string>()
    ctx.win.localStorage = { setItem: (k: string, v: string) => store.set(k, v), getItem: () => null }
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
    store.delete('bento-offline')
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
    expect(store.get('bento-offline')).toBe('on')
  })

  it('没有 localStorage 的环境不抛异常(shim 仍要挂上宿主契约)', () => {
    expect(() => ctx.run(buildBentoHostShimSource({ authorName: '我' }))).not.toThrow()
    expect(ctx.win.cortexSlidesHost).toBeTruthy()
  })

  it('作者名里的引号/换行不会破坏注入脚本', () => {
    const nasty = `a'b"c\\d\ne</script>`
    ctx.run(buildBentoHostShimSource({ authorName: nasty }))
    expect((ctx.win.cortexSlidesHost as Record<string, unknown>).authorName).toBe(nasty)
  })
})

describe('选区读取(状态语义,非事件语义)', () => {
  let ctx: ReturnType<typeof makeRunner>
  const read = (lastSeq: number): unknown => ctx.run(READ_BENTO_SELECTION_SOURCE(lastSeq))

  beforeEach(() => {
    ctx = makeRunner()
    ctx.run(buildBentoHostShimSource({ authorName: '我' }))
  })

  const push = (payload: string): void => {
    ;(ctx.win.cortexSlidesHost as { selectionChanged: (p: string) => unknown }).selectionChanged(payload)
  }

  it('尚未推送过选区时返回 null', () => {
    expect(read(0)).toBeNull()
  })

  it('seq 变化时返回 { seq, payload }', () => {
    push('{"slideIndex":0}')
    const first = read(0) as { seq: number; payload: string }
    expect(first.seq).toBe(1)
    expect(first.payload).toBe('{"slideIndex":0}')
  })

  // 选区是「当前状态」而非「待处理事件」:读取不清空,否则轮询会自己把状态吃掉。
  it('seq 未变时返回 null,但状态仍在(读取不清空)', () => {
    push('{"a":1}')
    const first = read(0) as { seq: number }
    expect(read(first.seq)).toBeNull()
    // 用更早的 seq 再读,依然拿得到 —— 证明没有被 drain 掉
    expect(read(0)).not.toBeNull()
  })

  it('覆盖式存储:只保留最新一份选区,seq 单调递增', () => {
    push('{"v":1}')
    push('{"v":2}')
    const latest = read(0) as { seq: number; payload: string }
    expect(latest.payload).toBe('{"v":2}')
    expect(latest.seq).toBe(2)
  })

  it('清空选区(null)也是一次状态变化,要能被宿主看到', () => {
    push('{"v":1}')
    const first = read(0) as { seq: number }
    ;(ctx.win.cortexSlidesHost as { selectionChanged: (p: unknown) => unknown }).selectionChanged(null)
    const cleared = read(first.seq) as { seq: number; payload: unknown }
    expect(cleared.seq).toBe(2)
    expect(cleared.payload).toBeNull()
  })

  it('shim 未注入时表达式安全返回 null(webview 刚重载的窗口期)', () => {
    const bare = makeRunner()
    expect(bare.run(READ_BENTO_SELECTION_SOURCE(0))).toBeNull()
    expect(bare.run(DRAIN_BENTO_SAVE_SOURCE)).toBeNull()
  })
})

describe('热应用表达式', () => {
  it('未注入时安全返回 null(旧壳 / webview 刚重载的窗口期 → 宿主回落重载)', () => {
    const ctx = makeRunner()
    expect(ctx.run(APPLY_BENTO_DOC_SOURCE('{"a":1}', 5))).toBeNull()
  })

  it('调用页内入口并透传 json 与 revision', () => {
    const ctx = makeRunner()
    const calls: Array<[string, number]> = []
    ctx.win.__cortexApplyDeckDoc = (json: string, revision: number) => {
      calls.push([json, revision])
      return true
    }
    expect(ctx.run(APPLY_BENTO_DOC_SOURCE('{"title":"x"}', 7))).toBe(true)
    expect(calls).toEqual([['{"title":"x"}', 7]])
  })

  // 文档 JSON 里必然出现引号、反斜杠、换行,甚至 </script> 与 U+2028;
  // 注入脚本一旦语法错误就是「热应用永远静默失败」。
  it('危险字符不破坏注入脚本', () => {
    const ctx = makeRunner()
    let received = ''
    ctx.win.__cortexApplyDeckDoc = (json: string) => {
      received = json
      return true
    }
    const nasty = JSON.stringify({ html: '</script>\u2028\u2029"quoted"\\back\n换行' })
    expect(ctx.run(APPLY_BENTO_DOC_SOURCE(nasty, 1))).toBe(true)
    expect(received).toBe(nasty)
  })

  it('revision 非整数时归一化(不把 NaN 注进脚本)', () => {
    const ctx = makeRunner()
    let seen = -1
    ctx.win.__cortexApplyDeckDoc = (_json: string, revision: number) => {
      seen = revision
      return true
    }
    ctx.run(APPLY_BENTO_DOC_SOURCE('{}', Number.NaN))
    expect(seen).toBe(0)
    ctx.run(APPLY_BENTO_DOC_SOURCE('{}', 3.9))
    expect(seen).toBe(3)
  })
})

describe('parseBentoApplyResult', () => {
  it('只有 true 算成功;其余一律回落重载', () => {
    expect(parseBentoApplyResult(true)).toBe(true)
    for (const v of [false, null, undefined, 'true', 1, {}]) {
      expect(parseBentoApplyResult(v)).toBe(false)
    }
  })
})

describe('parseBentoSaveDrain', () => {
  it('只认非空字符串', () => {
    expect(parseBentoSaveDrain('<html>')).toBe('<html>')
    for (const raw of [null, undefined, '', 0, {}]) {
      expect(parseBentoSaveDrain(raw)).toBeNull()
    }
  })
})
