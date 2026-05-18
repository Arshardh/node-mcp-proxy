import AbortController from 'abort-controller'

if (typeof globalThis.AbortController === 'undefined') {
  globalThis.AbortController = AbortController
}
