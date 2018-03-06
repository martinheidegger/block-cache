'use strict'
const err = require('./lib/err')
const createLRUCache = require('lru-cache')
const CachedFile = require('./CachedFile')
const promisifyAsync = require('./lib/promisifyAsync')
const mem = require('./lib/memorizeAsync')
const DEFAULT_CACHE_SIZE = (10 * 1024 * 1024)

function disconnected () {
  return err('ERR_DISCONNECTED', 'The filesystem has been disconnected')
}

function sendDisconnected (cb) {
  setImmediate(() => cb(disconnected()))
}

const DISCONNECTED_FS = {
  open (path, opts, cb) {
    sendDisconnected(cb)
  },
  stat (path, cb) {
    sendDisconnected(cb)
  },
  close (path, cb) {
    sendDisconnected(cb)
  },
  read (fp, buffer, position, size, start, cb) {
    sendDisconnected(cb)
  }
}

// Keeps track of all open file pointers
class FpMemory {
  constructor (fs) {
    this.fs = fs
    this.opened = []
    this.allClosed = false
  }
  open (path, opts, cb) {
    this.fs.open(path, opts, (err, fp) => {
      if (err) return cb(err)
      if (this.allClosed) {
        // In case closeAll happened between
        // fs.open and the return, close the fp again
        // and err as disconnected
        return this.fs.close(fp, () => cb(disconnected()))
      }
      this.opened.push(fp)
      cb(null, fp)
    })
  }
  close (fp, cb) {
    const index = this.opened.indexOf(fp)
    if (index !== -1) {
      this.opened.splice(index, 1)
    }
    this.fs.close(fp, cb)
  }
  closeAll (cb) {
    this.allClosed = true
    let returned = 0
    let errors = null
    if (this.opened.length === 0) {
      return cb(null)
    }
    this.opened.forEach(fp => this.fs.close(fp, err => {
      returned += 1
      if (err) {
        if (errors === null) errors = []
        errors.push(err)
      }
      if (returned === this.opened.length) {
        cb(errors)
      }
    }))
  }
}

function wrapFs (fs, cacheOpts) {
  let fpMemory = new FpMemory(fs)
  return {
    open: (path, opts, cb) => fpMemory.open(path, opts, cb),
    close: (fp, cb) => fpMemory.close(fp, cb),
    disconnect: mem.promise(cb => {
      const _fpMemory = fpMemory
      fpMemory = DISCONNECTED_FS
      fs = DISCONNECTED_FS
      _fpMemory.closeAll(cb)
    }),
    stat: (path, cb) => fs.stat(path, cb),
    read (fp, prefix, start, end, cb) {
      const key = `${cacheOpts.prefix}${prefix}${start}:${end}`
      const cached = cacheOpts.cache.get(key)
      if (cached) return cb(null, cached)
      const size = end - start
      const buffer = Buffer.allocUnsafe(size)
      fs.read(fp, buffer, 0, size, start, err => {
        if (err) return cb(err)
        cacheOpts.cache.set(key, buffer)
        cb(null, buffer)
      })
    }
  }
}

class Cache {
  constructor (fs, cacheOpts) {
    if (!fs) throw err('ERR_INVALID_ARG_TYPE', 'fs option required, this package doesnt assume which fs you want to use, see: hyperdrive')

    cacheOpts = Object.assign({
      cacheSize: DEFAULT_CACHE_SIZE,
      prefix: ''
    }, cacheOpts)

    if (!cacheOpts.cache) {
      cacheOpts.cache = createLRUCache({
        max: cacheOpts.cacheSize,
        length: buf => buf.length
      })
    }

    const internal = wrapFs(fs, cacheOpts)

    Object.defineProperties(this, {
      _readCached: {
        value: internal.read,
        enumerable: false
      },
      disconnect: {
        value: internal.disconnect
      },
      openSync: {
        value: (path, fileOpts) => {
          if (!path) throw err('ERR_INVALID_ARG_TYPE', 'path required')
          fileOpts = Object.assign({
            blkSize: cacheOpts.blkSize
          }, fileOpts)
          const file = new CachedFile(internal, path, fileOpts)
          Object.freeze(file)
          return file
        },
        enumerable: false
      }
    })
  }

  open (path, opts, cb) {
    if (typeof opts === 'function') {
      return this.open(path, null, opts)
    }
    return promisifyAsync(cb2 => cb2(null, this.openSync(path, opts)), cb)
  }

  close (fd, cb) {
    return fd.close(cb)
  }

  createReadStream (path, opts) {
    const fp = this.openSync(path, opts)
    const stream = fp.createReadStream(opts)
    stream.on('end', () => fp.close())
    return stream
  }

  read (fd, buffer, offset, length, position, cb) {
    return fd.read(buffer, offset, length, position, cb)
  }
}
Cache.DEFAULT_CACHE_SIZE = DEFAULT_CACHE_SIZE

module.exports = Cache
