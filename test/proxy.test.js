import assert from 'assert'
import { once } from 'events'
import { createServer } from 'http'
import { resolve } from 'path'
import '../src/polyfills.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { PostOnlyStreamableHttpTransport } from '../src/postOnlyStreamableHttpTransport.js'

async function createMockRemoteServer() {
  const state = {
    getRequests: 0,
    deleteRequests: 0,
    initializeProtocolVersion: undefined,
    toolsListProtocolHeader: undefined,
    toolsListSessionHeader: undefined,
  }

  const server = createServer(async (request, response) => {
    if (!request.url || !request.url.startsWith('/mcp')) {
      response.writeHead(404).end()
      return
    }

    if (request.method === 'GET') {
      state.getRequests += 1
      response.writeHead(405, { 'content-type': 'text/plain' })
      response.end('GET not supported')
      return
    }

    if (request.method === 'DELETE') {
      state.deleteRequests += 1
      response.writeHead(204).end()
      return
    }

    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }

    const chunks = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const message = Array.isArray(payload) ? payload[0] : payload

    if (message.method === 'initialize') {
      state.initializeProtocolVersion = message.params.protocolVersion
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'mcp-session-id': 'session-123',
      })
      response.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: 'mock-remote',
              version: '1.0.0',
            },
          },
        })}\n\n`,
      )
      response.end()
      return
    }

    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }

    if (message.method === 'tools/list') {
      state.toolsListProtocolHeader = request.headers['mcp-protocol-version']
      state.toolsListSessionHeader = request.headers['mcp-session-id']
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'ping',
                description: 'Test tool',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
        })}\n\n`,
      )
      response.end()
      return
    }

    response.writeHead(200, {
      'content-type': 'application/json',
    })
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: {
          code: -32601,
          message: `Unsupported method: ${message.method}`,
        },
      }),
    )
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server port')
  }

  return {
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose())
      }),
    state,
    url: `http://127.0.0.1:${address.port}/mcp`,
  }
}

async function main() {
  await testInsecureTlsIsEnabledByDefault()
  await testSecureTlsOverrideDisablesHttpsAgent()

  const remote = await createMockRemoteServer()
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(process.cwd(), 'src/cli.js'), remote.url, '--allow-http'],
    env: process.env,
  })

  const client = new Client(
    {
      name: 'proxy-test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  )

  try {
    await client.connect(transport)

    const result = await client.request(
      {
        method: 'tools/list',
        params: {},
      },
      ListToolsResultSchema,
    )

    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].name, 'ping')
    assert.equal(remote.state.getRequests, 0)
    assert.equal(remote.state.toolsListSessionHeader, 'session-123')
    assert.equal(remote.state.toolsListProtocolHeader, remote.state.initializeProtocolVersion)
    console.log('proxy test passed')
  } finally {
    await client.close().catch(() => {})
    await remote.close()
  }
}

async function testInsecureTlsIsEnabledByDefault() {
  let capturedInit

  const transport = new PostOnlyStreamableHttpTransport('https://example.com/mcp', {
    fetchImpl: async (_url, init) => {
      capturedInit = init
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === 'content-type') {
              return 'application/json'
            }
            return null
          },
        },
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '1.0.0' } } }),
        text: async () => '',
      }
    },
  })

  await transport.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  })

  assert.ok(capturedInit.agent)
  assert.equal(capturedInit.agent.options.rejectUnauthorized, false)
}

async function testSecureTlsOverrideDisablesHttpsAgent() {
  let capturedInit

  const transport = new PostOnlyStreamableHttpTransport('https://example.com/mcp', {
    insecureTls: false,
    fetchImpl: async (_url, init) => {
      capturedInit = init
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === 'content-type') {
              return 'application/json'
            }
            return null
          },
        },
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '1.0.0' } } }),
        text: async () => '',
      }
    },
  })

  await transport.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  })

  assert.equal(capturedInit.agent, undefined)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})