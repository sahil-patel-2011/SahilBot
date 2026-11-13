import { test, expect } from 'vitest'
import { parseHTML } from 'linkedom'
import { buildPage } from '../../src/main/agent/tools/pages'
// The helper library injected into every Page (window.sb), run against a small DOM.
test('sb.chart and sb.table render without errors', () => {
  const doc = buildPage('T', '<div id="c"></div><div id="p"></div><div id="l"></div><div id="t"></div>')
  const script = /<script id="sb-lib">([\s\S]*?)<\/script>/.exec(doc)![1]
  const { window, document } = parseHTML(doc) as any
  const w: any = window
  w.Intl = Intl
  new Function('window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', script)(w, document, () => 0, () => 0)
  const sb = w.sb
  sb.chart('#c', { type: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [1, -2, 3] }, { name: 'y', values: [2, 3, 4] }] })
  sb.chart('#c', { type: 'bar', stacked: true, labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [2, 3] }] })
  sb.chart('#l', { type: 'line', area: true, labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [10, 20, 15] }], format: { style: 'currency' } })
  sb.chart('#p', { type: 'donut', labels: ['a', 'b'], series: [{ values: [3, 1] }] })
  sb.chart('#p', { type: 'pie', labels: ['a'], series: [{ values: [3] }] })
  const t = sb.table('#t', [['Name', 'Price'], ['b', '$10'], ['a', '$2']])
  expect(document.querySelectorAll('rect').length).toBeGreaterThan(3)
  expect(document.querySelectorAll('polyline').length).toBe(1)
  expect(document.querySelectorAll('path').length).toBeGreaterThan(2)
  expect(document.querySelector('#c').textContent).not.toMatch(/Chart error/)
  expect(document.querySelector('#p').textContent).not.toMatch(/Chart error/)
  expect(t.querySelectorAll('td.num').length).toBe(2)
  expect(sb.fmt(1234.5, { style: 'currency' })).toBe('$1,234.50')
  expect(sb.fmt(1200, { style: 'currency' })).toBe('$1,200')
  // Sorting by the numeric column puts $2 first.
  t.querySelectorAll('th')[1].dispatchEvent(new w.Event('click'))
  expect(t.querySelector('tbody td').textContent).toBe('a')
})
