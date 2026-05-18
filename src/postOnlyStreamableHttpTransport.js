import https from 'https'
import fetch, { Headers } from 'node-fetch'

function isObject(value) {
  return typeof value === 'object' && value !== null
}

function isInitializeRequest(message) {
  return isObject(message) && message.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')
}

function expandError(status, statusText, responseText) {
  const suffix = responseText ? `: ${responseText}` : ''
  const error = new Error(`Remote HTTP request failed with ${status} ${statusText}${suffix}`)
  error.status = status
  return error
}

async function readResponseText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function splitNextEvent(buffer) {
  const match = buffer.match(/\r?\n\r?\n/)
  if (!match || match.index === undefined) {
    return null
  }

  const eventText = buffer.slice(0, match.index)
  const rest = buffer.slice(match.index + match[0].length)
  return { eventText, rest }
}

function parseSseEvent(eventText) {
  const lines = eventText.replace(/\r\n/g, '\n').split('\n')
  const data = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue
    }

    if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }

  return data.join('\n')
}

async function consumeSseResponse(stream, onmessage) {
  if (!stream) {
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader()

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const nextEvent = splitNextEvent(buffer)
        if (!nextEvent) {
          break
        }

        buffer = nextEvent.rest
        const data = parseSseEvent(nextEvent.eventText)
        if (!data) {
          continue
        }

        const payload = JSON.parse(data)
        if (Array.isArray(payload)) {
          for (const message of payload) {
            onmessage(message)
          }
        } else {
          onmessage(payload)
        }
      }
    }
  } else {
    for await (const value of stream) {
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const nextEvent = splitNextEvent(buffer)
        if (!nextEvent) {
          break
        }

        buffer = nextEvent.rest
        const data = parseSseEvent(nextEvent.eventText)
        if (!data) {
          continue
        }

        const payload = JSON.parse(data)
        if (Array.isArray(payload)) {
          for (const message of payload) {
            onmessage(message)
          }
        } else {
          onmessage(payload)
        }
      }
    }
  }

  buffer += decoder.decode()
  const trailingData = parseSseEvent(buffer)
  if (!trailingData) {
    return
  }

  const payload = JSON.parse(trailingData)
  if (Array.isArray(payload)) {
    for (const message of payload) {
      onmessage(message)
    }
    return
  }

  onmessage(payload)
}

export class PostOnlyStreamableHttpTransport {
  constructor(url, options = {}) {
    this.url = typeof url === 'string' ? new URL(url) : url
    this.baseHeaders = options.headers ?? {}
    this.insecureTls = options.insecureTls ?? true
    this.httpsAgent = this.insecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined
    this.baseFetchImpl = options.fetchImpl ?? fetch
    this.fetchImpl = (requestUrl, init = {}) => this._fetch(requestUrl, init)
    this.debug = options.debug ?? false
    this.started = false
    this.closed = false
    this.sessionId = undefined
    this.protocolVersion = undefined
    this.pendingProtocolVersion = undefined
    this.inFlightControllers = new Set()
    this.onmessage = undefined
    this.onerror = undefined
    this.onclose = undefined
  }

  _fetch(requestUrl, init = {}) {
    const fetchInit = { ...init }

    if (this.httpsAgent && new URL(requestUrl).protocol === 'https:') {
      fetchInit.agent = this.httpsAgent
    }

    return this.baseFetchImpl(requestUrl, fetchInit)
  }

  async start() {
    if (this.closed) {
      throw new Error('Transport is already closed')
    }

    this.started = true
  }

  async close() {
    if (this.closed) {
      return
    }

    this.closed = true

    for (const controller of this.inFlightControllers) {
      controller.abort()
    }
    this.inFlightControllers.clear()

    if (this.sessionId) {
      const headers = new Headers(this.baseHeaders)
      headers.set('mcp-session-id', this.sessionId)
      if (this.protocolVersion) {
        headers.set('mcp-protocol-version', this.protocolVersion)
      }

      try {
        await this.fetchImpl(this.url, {
          method: 'DELETE',
          headers,
        })
      } catch {
        // Ignore shutdown errors.
      }
    }

    this.onclose?.()
  }

  async send(message) {
    if (!this.started) {
      await this.start()
    }

    if (this.closed) {
      throw new Error('Transport is closed')
    }

    const messages = Array.isArray(message) ? message : [message]
    const initializeRequest = messages.find(isInitializeRequest)
    if (initializeRequest && typeof initializeRequest.params?.protocolVersion === 'string') {
      this.pendingProtocolVersion = initializeRequest.params.protocolVersion
    }

    const headers = new Headers(this.baseHeaders)
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')

    if (this.sessionId) {
      headers.set('mcp-session-id', this.sessionId)
    }

    if (!initializeRequest && this.protocolVersion) {
      headers.set('mcp-protocol-version', this.protocolVersion)
    }

    const controller = new AbortController()
    this.inFlightControllers.add(controller)

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId) {
        this.sessionId = sessionId
      }

      if (!response.ok) {
        throw expandError(response.status, response.statusText, await readResponseText(response))
      }

      if (response.status === 202 || response.status === 204) {
        await readResponseText(response)
        return
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/event-stream')) {
        await consumeSseResponse(response.body, (incomingMessage) => {
          this._handleIncomingMessage(incomingMessage)
        })
        return
      }

      if (contentType.includes('application/json')) {
        const payload = await response.json()
        if (Array.isArray(payload)) {
          for (const incomingMessage of payload) {
            this._handleIncomingMessage(incomingMessage)
          }
          return
        }

        this._handleIncomingMessage(payload)
        return
      }

      const responseText = await readResponseText(response)
      if (!responseText.trim()) {
        return
      }

      throw new Error(`Unsupported remote content type: ${contentType || 'unknown'}`)
    } catch (error) {
      this.onerror?.(error)
      throw error
    } finally {
      this.inFlightControllers.delete(controller)
    }
  }

  _handleIncomingMessage(message) {
    if (typeof message?.result?.protocolVersion === 'string') {
      this.protocolVersion = message.result.protocolVersion
      this.pendingProtocolVersion = undefined
    } else if (!this.protocolVersion && this.pendingProtocolVersion) {
      this.protocolVersion = this.pendingProtocolVersion
      this.pendingProtocolVersion = undefined
    }

    this.onmessage?.(message)
  }
}
