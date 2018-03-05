'use strict'
const err = require('./lib/err')
const megaByte10 = (10 * 1024 * 1024)
const createLRUCache = require('lru-cache')
const CachedFile = require('./CachedFile')
const promisifyAsync = require('./lib/promisifyAsync')

module.exports = class Cache {
  constructor (fs, cacheOpts) {
    if (!fs) throw err('ERR_INVALID_ARG_TYPE', 'fs option required, this package doesnt assume which fs you want to use, see: hyperdrive')

    cacheOpts = Object.assign({
      cacheSize: megaByte10,
    }, cacheOpts)

    if (!cacheOpts.cache) {
      cacheOpts.cache = createLRUCache({
        max: cacheOpts.cacheSize,
        length: buf => buf.length
      })
    }

    const read = (fp, prefix, start, end, cb) => {
      const key = `${prefix}${start}:${end}`
      const cached = cacheOpts.cache.get(key)
      if (cached) {
        return cb(null, cached)
      }
      const size = end - start
      const buffer = Buffer.allocUnsafe(size)
      fs.read(fp, buffer, 0, size, start, err => {
        if (err) return cb(err)
        cacheOpts.cache.set(key, buffer)
        cb(null, buffer)
      })
    }

    Object.defineProperties(this, {
      _readCached: {
        value: read,
        enumerable: false
      },
      openSync: {
        value: (path, fileOpts) => {
          if (!path) throw err('ERR_INVALID_ARG_TYPE', 'path required')
          fileOpts = Object.assign({
            blkSize: cacheOpts.blkSize
          }, fileOpts)
          return new CachedFile(internal, path, fileOpts)
        },
        enumerable: false
      }
    })

    const internal = {
      open (path, opts, cb) {
        fs.open(path, opts, cb)
      },
      stat (path, cb) {
        fs.stat(path, cb)
      },
      close (path, cb) {
        fs.close(path, cb)
      },
      read
    }
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
