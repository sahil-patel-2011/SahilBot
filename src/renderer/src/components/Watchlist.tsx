import { useEffect, useRef, useState } from 'react'
import type { WatchlistItem } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { asOfText, compose, money, pct, signed, useWatchlist, watchlist } from '../lib/stocks'
import { ChartIcon } from './StockCard'

// The stock watchlist (side panel tab): symbols with their last price, day change and a sparkline.
// Add, remove and reorder (drag, or the arrow buttons / ⌥↑↓); clicking a symbol asks about it in the
// composer. Prices come from a market refresh when the engine offers one, else from the latest stock
// card the chat showed for that symbol.

type Refresher = (symbols: string[]) => Promise<WatchlistItem[]>

/** The market engine's quote refresh, when the preload exposes one (markets.quotes / markets.watchlist). */
function refresher(): Refresher | null {
  const m = (api as unknown as { markets?: Record<string, unknown> }).markets
  const fn = m && (m.quotes ?? m.watchlistQuotes ?? m.refreshWatchlist)
  return typeof fn === 'function' ? (fn as Refresher) : null
}

function Spark({ values, tone }: { values?: number[]; tone: 'up' | 'down' | 'flat' }) {
  const w = 72, h = 26
  if (!values || values.length < 2) return <span className="wl-spark empty" aria-hidden />
  const lo = Math.min(...values), hi = Math.max(...values)
  const x = (i: number): number => 1 + (i / (values.length - 1)) * (w - 2)
  const y = (v: number): number => 2 + (1 - (v - lo) / (hi - lo || 1)) * (h - 4)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <svg className={`wl-spark ${tone}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** The sparkline's colour follows its own period (first vs last close), not just today's move. */
const trend = (v?: number[]): 'up' | 'down' | 'flat' => (!v || v.length < 2 || v[v.length - 1] === v[0] ? 'flat' : v[v.length - 1] > v[0] ? 'up' : 'down')

export function Watchlist() {
  const list = useWatchlist()
  const [sym, setSym] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [updated, setUpdated] = useState<number | null>(null)
  const refresh = refresher()
  const auto = useRef(false)

  const doRefresh = async (): Promise<void> => {
    if (!refresh || !list.length) return
    setBusy(true)
    try {
      await watchlist.update(await refresh(list.map((x) => x.symbol)))
      setUpdated(Date.now())
    } catch (e) {
      toast(`Couldn't refresh prices: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  // With a refresh available, update stale prices (older than 15 minutes) once when the tab opens.
  useEffect(() => {
    if (auto.current || !refresh || !list.length) return
    auto.current = true
    if (list.some((x) => !x.asOf || Date.now() - x.asOf > 15 * 60_000)) void doRefresh()
  }, [list.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = (e: React.FormEvent): void => {
    e.preventDefault()
    const s = sym.trim().toUpperCase()
    if (!/^[A-Z0-9.\-^=]{1,15}$/.test(s)) { toast('Enter a ticker symbol, like MSFT or BRK.B', 'error'); return }
    if (watchlist.has(s)) { toast(`${s} is already on your watchlist`); setSym(''); return }
    void watchlist.add(s).then(() => { setSym(''); if (refresh) void refresh([s]).then((x) => watchlist.update(x)).catch(() => undefined) })
  }

  return (
    <div className="watchlist" data-testid="watchlist">
      <div className="wl-head">
        <ChartIcon size={16} />
        <b>Watchlist</b>
        <span className="hint">{list.length ? `${list.length} symbol${list.length === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer" />
        {refresh && (
          <button className="icon-btn" onClick={() => void doRefresh()} disabled={busy || !list.length} title="Refresh prices" aria-label="Refresh prices" data-testid="watchlist-refresh">
            {busy ? <span className="spin" /> : <span className="wl-refresh" aria-hidden>↻</span>}
          </button>
        )}
      </div>
      <form className="wl-add" onSubmit={add}>
        <input value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} placeholder="Add a symbol, e.g. MSFT" maxLength={15}
          aria-label="Ticker symbol to add" spellCheck={false} autoCapitalize="characters" data-testid="watchlist-input" />
        <button className="btn" type="submit" disabled={!sym.trim()} data-testid="watchlist-add"><I.Plus size={13} />Add</button>
      </form>

      {list.length === 0 ? (
        <div className="wl-empty">
          <ChartIcon size={22} />
          <p>No symbols yet. Add one above, or press <b>Add to watchlist</b> on a stock card in the chat.</p>
        </div>
      ) : (
        <ol className="wl-list" aria-label="Watchlist symbols" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}>
          {list.map((it, i) => {
            const tone = (it.changePct ?? 0) > 0 ? 'up' : (it.changePct ?? 0) < 0 ? 'down' : 'flat'
            const stale = !!it.asOf && Date.now() - it.asOf > 4 * 864e5
            return (
              <li key={it.symbol} className={`wl-row${drag === it.symbol ? ' dragging' : ''}${over === i && drag && drag !== it.symbol ? ' drop' : ''}`}
                data-testid="watchlist-row" data-symbol={it.symbol} draggable
                onDragStart={(e) => { setDrag(it.symbol); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.symbol) }}
                onDragEnd={() => { setDrag(null); setOver(null) }}
                onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(i) } }}
                onDrop={(e) => { e.preventDefault(); if (drag && drag !== it.symbol) void watchlist.move(drag, i); setDrag(null); setOver(null) }}>
                <span className="wl-grip" aria-hidden>⋮⋮</span>
                <button className="wl-main" onClick={() => compose(`How is ${it.symbol} doing?`)} title={`Ask how ${it.symbol} is doing`}
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault()
                      void watchlist.move(it.symbol, i + (e.key === 'ArrowUp' ? -1 : 1)).then(() => requestAnimationFrame(() => (document.querySelector(`[data-symbol="${it.symbol}"] .wl-main`) as HTMLElement | null)?.focus()))
                    }
                  }}>
                  <span className="wl-id">
                    <b className="wl-sym">{it.symbol}</b>
                    <span className="wl-name">{it.name ?? (it.price === undefined ? 'No price yet' : '')}</span>
                  </span>
                  <Spark values={it.spark} tone={trend(it.spark)} />
                  <span className="wl-nums" title={it.asOf ? `As of ${asOfText(it.asOf)}` : 'Ask about this symbol to fetch a price'}>
                    <span className={`wl-price${stale ? ' stale' : ''}`}>{it.price !== undefined ? money(it.price, it.currency ?? 'USD') : '–'}</span>
                    {it.changePct !== undefined ? (
                      <span className={`wl-chg ${tone}`}>
                        <span aria-hidden>{tone === 'up' ? '▲' : tone === 'down' ? '▼' : ''}</span>
                        <span className="stk-sr">{tone === 'up' ? 'Up' : tone === 'down' ? 'Down' : 'Unchanged'}</span>
                        {pct(it.changePct)}
                        {it.changeAbs !== undefined && <span className="wl-abs"> {signed(it.changeAbs)}</span>}
                      </span>
                    ) : <span className="wl-chg flat">{stale ? 'old' : ''}</span>}
                  </span>
                </button>
                <span className="wl-actions">
                  <button className="icon-btn" disabled={i === 0} onClick={() => void watchlist.move(it.symbol, i - 1)} title="Move up (⌥↑)" aria-label={`Move ${it.symbol} up`}><I.Up size={13} /></button>
                  <button className="icon-btn" disabled={i === list.length - 1} onClick={() => void watchlist.move(it.symbol, i + 1)} title="Move down (⌥↓)" aria-label={`Move ${it.symbol} down`}><I.Down size={13} /></button>
                  <button className="icon-btn" onClick={() => void watchlist.remove(it.symbol)} title="Remove" aria-label={`Remove ${it.symbol}`} data-testid="watchlist-remove"><I.Close size={13} /></button>
                </span>
              </li>
            )
          })}
        </ol>
      )}

      {list.length > 0 && (
        <div className="wl-note">
          {refresh
            ? updated ? `Refreshed ${asOfText(updated)}.` : 'Press ↻ to refresh prices.'
            : 'Prices are from the latest stock card in your chats. Ask about a symbol to update it.'}
          {' '}Click a symbol to ask about it. For information only, not financial advice.
        </div>
      )}
    </div>
  )
}
