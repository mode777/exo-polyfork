/*
 * Injected before page scripts (Playwright addInitScript).
 *
 * Replaces `window.showDirectoryPicker` with an in-memory File System Access
 * handle seeded from the e2e fixture server. This is what makes the deployed
 * shell testable headlessly: the shell's folder provider only depends on the
 * standard FSA surface, so a faithful fake is enough.
 *
 * The test API lives on `window.__EXO_E2E__`:
 *   config       injected before this script: { base, name, paths }
 *   reads        per-path getFile() counters
 *   writes       per-path createWritable().close() counters
 *   hash(path)   SHA-256 hex of current bytes
 *   touch(path)  bump lastModified (simulates an external edit)
 *   write(path, text) replace contents and bump lastModified
 *   remove(path) delete a file (simulates an external delete)
 */
(() => {
  'use strict'

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = {
    root: null,
    rootHandle: null,
    reads: Object.create(null),
    writes: Object.create(null),
  }

  const domException = (name, message) => new DOMException(message || name, name)

  function makeNode(kind, name, parent) {
    const path = parent === null ? '/' : (parent.path === '/' ? '' : parent.path) + '/' + name
    return {
      kind,
      name,
      path,
      parent,
      content: new Uint8Array(0),
      lastModified: 1000,
      children: new Map(),
    }
  }

  function findNode(path) {
    const segments = path.split('/').filter(Boolean)
    let node = state.root
    for (const segment of segments) {
      if (!node || node.kind !== 'directory') throw new Error('missing directory for ' + path)
      node = node.children.get(segment)
    }
    if (!node) throw new Error('missing ' + path)
    return node
  }

  function seed(root, path, bytes) {
    const segments = path.split('/').filter(Boolean)
    let node = root
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment)
      if (!child) {
        child = makeNode('directory', segment, node)
        node.children.set(segment, child)
      }
      node = child
    }
    const name = segments[segments.length - 1]
    const file = makeNode('file', name, node)
    file.content = bytes
    node.children.set(name, file)
  }

  class FakeFileHandle {
    constructor(node) {
      this.kind = 'file'
      this.node = node
    }

    get name() {
      return this.node.name
    }

    isSameEntry(other) {
      return Promise.resolve(other instanceof FakeFileHandle && other.node === this.node)
    }

    getFile() {
      const node = this.node
      state.reads[node.path] = (state.reads[node.path] || 0) + 1
      const snapshot = new Uint8Array(node.content)
      const file = {
        name: node.name,
        size: snapshot.byteLength,
        lastModified: node.lastModified,
        type: 'application/octet-stream',
        webkitRelativePath: '',
        arrayBuffer: () => Promise.resolve(snapshot.buffer.slice(0)),
        bytes: () => Promise.resolve(new Uint8Array(snapshot)),
        text: () => Promise.resolve(decoder.decode(snapshot)),
        slice: () => file,
        stream: () => new ReadableStream(),
      }
      return Promise.resolve(file)
    }

    createWritable() {
      const node = this.node
      const chunks = []
      return Promise.resolve({
        write: (data) => {
          if (typeof data === 'string') {
            chunks.push(encoder.encode(data))
          } else if (data instanceof Blob) {
            return data.arrayBuffer().then((buffer) => chunks.push(new Uint8Array(buffer)))
          } else if (data instanceof ArrayBuffer) {
            chunks.push(new Uint8Array(data.slice(0)))
          } else if (ArrayBuffer.isView(data)) {
            chunks.push(
              new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
            )
          }
          return Promise.resolve()
        },
        close: () => {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) {
            merged.set(chunk, offset)
            offset += chunk.byteLength
          }
          node.content = merged
          node.lastModified += 1000
          state.writes[node.path] = (state.writes[node.path] || 0) + 1
          return Promise.resolve()
        },
        abort: () => Promise.resolve(),
        seek: () => Promise.resolve(),
        truncate: () => Promise.resolve(),
      })
    }
  }

  class FakeDirectoryHandle {
    constructor(node) {
      this.kind = 'directory'
      this.node = node
    }

    get name() {
      return this.node.name
    }

    isSameEntry(other) {
      return Promise.resolve(other instanceof FakeDirectoryHandle && other.node === this.node)
    }

    getDirectoryHandle(name, options = {}) {
      let child = this.node.children.get(name)
      if (child) {
        if (child.kind !== 'directory') return Promise.reject(domException('TypeMismatchError'))
        return Promise.resolve(new FakeDirectoryHandle(child))
      }
      if (!options.create) return Promise.reject(domException('NotFoundError'))
      child = makeNode('directory', name, this.node)
      this.node.children.set(name, child)
      return Promise.resolve(new FakeDirectoryHandle(child))
    }

    getFileHandle(name, options = {}) {
      let child = this.node.children.get(name)
      if (child) {
        if (child.kind !== 'file') return Promise.reject(domException('TypeMismatchError'))
        return Promise.resolve(new FakeFileHandle(child))
      }
      if (!options.create) return Promise.reject(domException('NotFoundError'))
      child = makeNode('file', name, this.node)
      this.node.children.set(name, child)
      return Promise.resolve(new FakeFileHandle(child))
    }

    removeEntry(name, options = {}) {
      const child = this.node.children.get(name)
      if (!child) return Promise.reject(domException('NotFoundError'))
      if (child.kind === 'directory' && !options.recursive && child.children.size > 0) {
        return Promise.reject(domException('InvalidModificationError'))
      }
      this.node.children.delete(name)
      return Promise.resolve()
    }

    async *entries() {
      for (const [name, child] of this.node.children) {
        yield [
          name,
          child.kind === 'directory' ? new FakeDirectoryHandle(child) : new FakeFileHandle(child),
        ]
      }
    }

    async *values() {
      for await (const [, handle] of this.entries()) yield handle
    }

    async *keys() {
      for (const name of this.node.children.keys()) yield name
    }

    queryPermission() {
      return Promise.resolve('granted')
    }

    requestPermission() {
      return Promise.resolve('granted')
    }
  }

  async function buildRoot() {
    const config = window.__EXO_E2E_CONFIG__ || { base: '', name: 'e2e-workspace', paths: [] }
    const root = makeNode('directory', config.name || 'e2e-workspace', null)
    for (const path of config.paths) {
      const encoded = path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      const response = await fetch(config.base + '/files/' + encoded, { cache: 'no-store' })
      if (!response.ok) throw new Error('fixture fetch failed: ' + path + ' (' + response.status + ')')
      seed(root, path, new Uint8Array(await response.arrayBuffer()))
    }
    state.root = root
    state.rootHandle = new FakeDirectoryHandle(root)
    return state.rootHandle
  }

  window.__EXO_E2E__ = {
    reads: state.reads,
    writes: state.writes,
    async hash(path) {
      const node = findNode(path)
      const digest = await crypto.subtle.digest('SHA-256', node.content)
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    },
    size(path) {
      return findNode(path).content.byteLength
    },
    touch(path) {
      const node = findNode(path)
      node.lastModified += 1000
    },
    write(path, content) {
      const node = findNode(path)
      node.content = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content)
      node.lastModified += 1000
    },
    text(path) {
      return decoder.decode(findNode(path).content)
    },
    remove(path) {
      const node = findNode(path)
      if (node.parent) node.parent.children.delete(node.name)
    },
  }

  window.showDirectoryPicker = async () => {
    try {
      if (!state.rootHandle) {
        state.rootHandle = await buildRoot()
      }
      return state.rootHandle
    } catch (error) {
      const message = String((error && error.message) || error)
      window.__EXO_E2E__.lastError = message
      console.error('EXO_E2E_PICKER_FAILED', message)
      throw error
    }
  }
})()
