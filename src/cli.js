#!/usr/bin/env node

import './polyfills.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { PostOnlyStreamableHttpTransport } from './postOnlyStreamableHttpTransport.js'

function usage() {
  return [
    'Usage: node ./src/cli.js <https://server-url> [--header "Name: Value"] [--allow-http] [--debug]',
    '',
    'Examples:',
    '  node ./src/cli.js https://remote.mcp.server/mcp',
    '  node ./src/cli.js https://remote.mcp.server/mcp --header "Authorization: Bearer ${TOKEN}"',
  ].join('\n')
}

function formatForLog(value) {
  if (value instanceof Error) {
    return value.stack || value.message
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function createLogger(enabled) {
  return (...args) => {
    if (!enabled) {
      return
    }

    process.stderr.write(`[node-mcp-client] ${args.map(formatForLog).join(' ')}\n`)
  }
}

function writeStderr(...args) {
  process.stderr.write(`[node-mcp-client] ${args.map(formatForLog).join(' ')}\n`)
}

function expandEnv(value) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
    const envValue = process.env[name]
    if (envValue === undefined) {
      throw new Error(`Missing environment variable: ${name}`)
    }
    return envValue
  })
}

function parseHeader(rawHeader) {
  const separator = rawHeader.indexOf(':')
  if (separator === -1) {
    throw new Error(`Invalid --header value: ${rawHeader}`)
  }

  const name = rawHeader.slice(0, separator).trim()
  const value = expandEnv(rawHeader.slice(separator + 1).trim())

  if (!name) {
    throw new Error(`Invalid --header value: ${rawHeader}`)
  }

  return [name, value]
}

function parseArgs(argv) {
  let serverUrlText = undefined
  let allowHttp = false
  let debug = false
  const headers = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      console.error(usage())
      process.exit(0)
    }

    if (arg === '--allow-http') {
      allowHttp = true
      continue
    }

    if (arg === '--debug') {
      debug = true
      continue
    }

    if (arg === '--header') {
      const headerValue = argv[index + 1]
      if (!headerValue) {
        throw new Error('--header requires a value')
      }
      const [name, value] = parseHeader(headerValue)
      headers[name] = value
      index += 1
      continue
    }

    if (!serverUrlText) {
      serverUrlText = arg
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!serverUrlText) {
    throw new Error('Missing server URL')
  }

  const serverUrl = new URL(serverUrlText)
  if (serverUrl.protocol !== 'https:' && !(allowHttp && serverUrl.protocol === 'http:')) {
    throw new Error('Only HTTPS URLs are allowed. Use --allow-http to connect to HTTP endpoints.')
  }

  return {
    serverUrl,
    headers,
    debug,
  }
}

async function main() {
  const { serverUrl, headers, debug } = parseArgs(process.argv.slice(2))
  const log = createLogger(debug)
  const localTransport = new StdioServerTransport()
  const remoteTransport = new PostOnlyStreamableHttpTransport(serverUrl, { headers, debug })

  let shuttingDown = false

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)

    await Promise.allSettled([remoteTransport.close(), localTransport.close()])
    process.exit(exitCode)
  }

  const handleFatalError = async (error) => {
    writeStderr('Fatal bridge error', error)
    log('Fatal bridge error', error)
    await shutdown(1)
  }

  process.on('uncaughtException', (error) => {
    writeStderr('Uncaught exception', error)
    void shutdown(1)
  })

  process.on('unhandledRejection', (reason) => {
    writeStderr('Unhandled rejection', reason)
    void shutdown(1)
  })

  const handleSigint = () => {
    void shutdown(0)
  }

  const handleSigterm = () => {
    void shutdown(0)
  }

  process.on('SIGINT', handleSigint)
  process.on('SIGTERM', handleSigterm)

  localTransport.onmessage = (message) => {
    log('Local -> Remote', message.method ?? message.id ?? 'message')
    void remoteTransport.send(message).catch(handleFatalError)
  }

  remoteTransport.onmessage = (message) => {
    log('Remote -> Local', message.method ?? message.id ?? 'message')
    void localTransport.send(message).catch(handleFatalError)
  }

  localTransport.onerror = (error) => {
    void handleFatalError(error)
  }

  remoteTransport.onerror = (error) => {
    void handleFatalError(error)
  }

  localTransport.onclose = () => {
    log('Local STDIO transport closed')
    void shutdown(0)
  }

  remoteTransport.onclose = () => {
    log('Remote HTTP transport closed')
  }

  await remoteTransport.start()
  await localTransport.start()
  log('Bridge ready', { url: serverUrl.href })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage())
  process.exit(1)
})
