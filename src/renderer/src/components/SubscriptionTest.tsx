import { useEffect, useRef, useState } from 'react'
import type { SubscriptionTest } from '@shared/chatgpt-plan'

/**
 * Setup's last check for a subscription connection: one real message through it, with the reply shown,
 * so "Connected" means a chat actually works. auto: send it once as soon as the connection is ready.
 */
export function SubscriptionTestChat({ run, auto, testId }: { run: () => Promise<SubscriptionTest>; auto?: boolean; testId: string }) {
  const [state, setState] = useState<'idle' | 'sending' | SubscriptionTest>('idle')
  const sent = useRef(false)
  const send = async (): Promise<void> => {
    sent.current = true
    setState('sending')
    setState(await run().catch((e: unknown) => ({ ok: false, error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })))
  }
  useEffect(() => { if (auto && !sent.current) void send() }, [auto]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text">
        <div className="set-row-title">Test chat</div>
        <div className="set-row-sub" role="status" data-testid={`${testId}-result`}>
          {state === 'idle' ? 'Sends one short message through this subscription and shows the reply.'
            : state === 'sending' ? 'Sending a test message…'
            : state.ok ? <>Works. Reply: <i>“{state.reply}”</i></>
            : <span className="ui-text-danger">Didn't work: {state.error}</span>}
        </div>
      </div>
      <div className="set-row-ctl">
        <button className="btn" disabled={state === 'sending'} onClick={() => void send()} data-testid={`${testId}-send`}>
          {state === 'idle' ? 'Send a test message' : 'Send again'}
        </button>
      </div>
    </div>
  )
}

/** While Terminal installs a CLI and signs in, check again every few seconds (for up to 10 minutes). */
export function usePollWhile(active: boolean, check: () => void, everyMs = 5000): void {
  const latest = useRef(check)
  latest.current = check
  useEffect(() => {
    if (!active) return
    const started = Date.now()
    const t = setInterval(() => { if (Date.now() - started < 10 * 60_000) latest.current() }, everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
}
