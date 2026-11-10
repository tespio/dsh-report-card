/**
 * A local, deterministic stand-in for the DeepSeek Messages endpoint.
 *
 * The harness never calls a real model. Instead the throwaway profile gets
 * `DEEPSEEK_BASE_URL` pointed at this server, so a scripted turn runs to
 * completion while the *request the harness actually assembled* is captured
 * verbatim — which is the measurement: exact system prompt, tool schemas, and
 * message list for that turn.
 *
 * The wire shape is the Anthropic-style Messages SSE stream the shipped
 * `@deepseek-ai/dsh-llm-deepseek` transport parses: message_start,
 * content_block_start/delta/stop, message_delta, message_stop.
 */
import http from 'node:http'

/** Fixed assistant reply; one short text block keeps the turn deterministic. */
const DEFAULT_REPLY = 'OK'

/** Build one SSE frame. `event:` and `data.type` must agree or the parser rejects it. */
function frame(payload) {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** The fixed stream: one text block, then a settled end_turn with usage. */
function replyBody({ reply, model, inputTokens, outputTokens }) {
  const messageId = 'msg_report_card_fixture'
  return [
    frame({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }),
    frame({ type: 'message_stop' }),
  ].join('')
}

/** The four-characters-per-token heuristic the shipped token meter documents. */
export function heuristicTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/**
 * Start the fixture endpoint on a free loopback port.
 * @param options {{ reply?: string, host?: string, log?: (line: string) => void }}
 * @returns {Promise<{ url: string, port: number, requests: Array, close: () => Promise<void> }>}
 */
export async function startMockLlm(options = {}) {
  const reply = options.reply ?? DEFAULT_REPLY
  const log = options.log ?? (() => {})
  const requests = []

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const path = (req.url ?? '/').split('?')[0]
      let body
      try {
        body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'))
      } catch {
        body = null
      }
      const record = { at: Date.now(), method: req.method, path, bytes: raw.length, body }
      requests.push(record)

      if (req.method === 'GET' && path.endsWith('/models')) {
        const payload = JSON.stringify({
          data: [{ id: 'deepseek-flash', type: 'model', display_name: 'deepseek-flash' }],
          has_more: false,
        })
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.method !== 'POST' || !path.endsWith('/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: `no route ${req.method} ${path}` } }))
        return
      }

      const model = typeof body?.model === 'string' ? body.model : 'deepseek-flash'
      const inputTokens = heuristicTokens(raw.toString('utf8'))
      const outputTokens = Math.max(1, heuristicTokens(reply))
      log(`mock llm: request #${requests.length} ${raw.length}B path=${path} model=${model}`)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': `report-card-${requests.length}`,
      })
      res.end(replyBody({ reply, model, inputTokens, outputTokens }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
