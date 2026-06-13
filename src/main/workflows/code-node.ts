import { runInNewContext } from 'vm'

// Run a small user-authored JS snippet over the workflow vars in a restricted vm context.
// This is NOT a security sandbox against a malicious author — it's the SAME trust level as a shell
// node (the user wrote the workflow). The point is a clean input/output, no require/network/process,
// and a hard timeout so an accidental infinite loop can't hang the run.
// The vm `timeout` only bounds SYNCHRONOUS execution — an async/microtask loop (e.g.
// `Promise.resolve().then(function f(){return Promise.resolve().then(f)})`) returns instantly,
// escapes the timeout, and then spins the event loop into an UN-catchable OOM crash of the main
// process. Reject async/timer/Promise/import constructs up front so a snippet can only do bounded
// synchronous work; everything left is interrupted by the 1s timeout and surfaces as a node error.
const ASYNC_BANNED = /\b(async|await|import|require|Promise|setTimeout|setInterval|setImmediate|queueMicrotask)\b/

export function runUserCode(
  code: string,
  context: { vars: Record<string, string>; last: unknown; input: string }
): string {
  if (ASYNC_BANNED.test(code)) {
    throw new Error('code: async / await / Promise / Timer / import / require sind im Code-Knoten nicht erlaubt — nutze ein synchrones Snippet.')
  }
  const sandbox: Record<string, unknown> = {
    vars: context.vars,
    last: context.last,
    input: context.input,
    JSON,
    Math,
    Date,
    // swallow console so a snippet's logs don't crash on a missing console in the vm context
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    result: undefined as unknown
  }
  // the snippet runs as a function body, so it can `return <value>` or assign to vars.
  const wrapped = `result = (function(){ "use strict";\n${code}\n})();`
  runInNewContext(wrapped, sandbox, { timeout: 1000, displayErrors: true })
  const out = sandbox.result
  if (out === undefined || out === null) return ''
  return typeof out === 'string' ? out : JSON.stringify(out)
}
