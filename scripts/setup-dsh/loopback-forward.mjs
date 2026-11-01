// Bridge 127.0.0.1:<port> to the dsh Web UI listener on <target-host>:<port>.
//
// `dsh web` binds one concrete address, so a LAN bind stops answering on
// loopback. This bridge holds no session or token of its own: it forwards the
// browser's bytes unchanged, including its `Host: 127.0.0.1:<port>` header,
// which the listener accepts as a loopback authority.
//
// Usage: node loopback-forward.mjs <port> <target-host>
import { connect, createServer } from 'node:net'

const [rawPort, targetHost] = process.argv.slice(2)
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535 || !targetHost) {
  console.error('usage: node loopback-forward.mjs <port> <target-host>')
  process.exit(2)
}

const server = createServer((client) => {
  const upstream = connect({ host: targetHost, port })
  client.pipe(upstream)
  upstream.pipe(client)
  // Either half closing ends the pair; destroying both avoids leaking a
  // half-open socket when the UI restarts or the browser navigates away.
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
  client.on('close', close)
  upstream.on('close', close)
})

server.on('error', (error) => {
  console.error(`loopback-forward: ${error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`loopback-forward: 127.0.0.1:${port} -> ${targetHost}:${port}`)
})
