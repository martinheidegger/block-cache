'use strict'
const err = require('./lib/err')
const megaByte10 = (10 * 1024 * 1024)
const createLRUCache = require('lru-cache')
const CachedFile = require('./CachedFile')
const promisifyAsync = require('./lib/promisifyAsync')

module.exports = class Cache {
  constructor (fs, opts) {
    if (!fs) throw err('ERR_INVALID_ARG_TYPE', 'fs option required, this package doesnt assume which fs you want to use, see: hyperdrive')

    opts = Object.assign({
      cacheSize: megaByte10
    }, opts)

    if (!opts.cache) {
      opts.cache = createLRUCache({
        max: opts.cacheSize,
        length: buf => buf.length
      })
    }

    this.fs = fs
    this.opts = opts
  }

  open (path, opts, cb) {
    if (typeof opts === 'function') {
      return this.open(path, null, opts)
    }
    return promisifyAsync(cb2 => cb2(null, this.openSync(path, opts)), cb)
  }

  openSync (path, opts) {
    if (!path) throw err('ERR_INVALID_ARG_TYPE', 'path required')
    return new CachedFile(this, path, opts)
  }

  close (fd, cb) {
    return fd.close(cb)
  }

  createReadStream (path, opts) {
    const fp = this.openSync(path, opts)
    const stream = fp.createReadStream(opts)
    stream.on('end', () => {
      fp.close()
    })
    return stream
  }

  read (fd, buffer, offset, length, position, cb) {
    return fd.read(buffer, offset, length, position, cb)
  }

  _readCached (fd, prefix, start, end, cb) {
    const key = `${prefix}${start}:${end}`
    const cached = this.opts.cache.get(key)
    if (cached) {
      return cb(null, cached)
    }
    const size = end - start
    const buffer = Buffer.allocUnsafe(size)
    this.fs.read(fd, buffer, 0, size, start, err => {
      if (err) return cb(err)
      this.opts.cache.set(key, buffer)
      cb(null, buffer)
    })
  }
}
