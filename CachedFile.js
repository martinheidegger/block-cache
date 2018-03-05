'use strict'
const Readable = require('readable-stream').Readable
const mem = require('./lib/memorizeAsync')
const err = require('./lib/err')
const promisifyAsync = require('./lib/promisifyAsync')

function sizeForStat (stat) {
  if (stat.size !== null && stat.size !== undefined) {
    return stat.size
  }
  if (stat.blkSize === 0) {
    return 0
  }
  return stat.blkSize * stat.blocks
}

function getSafeSize (start, end, size) {
  let safeStart = start
  if (start === -1 || start === undefined || start === null) {
    safeStart = 0
  }
  let safeEnd = end
  if (end === -1 || end === undefined || end === null) {
    safeEnd = size
  }
  return {start: safeStart, end: safeEnd, size: safeEnd - safeStart}
}

class CachedFile {
  constructor (fsCache, path, opts) {
    this.fsCache = fsCache
    this.path = path
    this.position = 0
    this._reading = 0
    this.blkSize = (opts && opts.blkSize) || fsCache.opts.blkSize || CachedFile.DEFAULT_BLK_SIZE
    this.fd = mem.promise(cb => fsCache.fs.open(path, 'r', cb))
    this.stat = mem.promise(cb => fsCache.fs.stat(path, cb))
    this.prefix = mem.promise(cb => this.stat((err, stat) => {
      if (err) return cb(err)
      cb(null, `${path}:${stat.mtime.getTime().toString(32)}:`)
    }))
    this.size = mem.promise(cb => this.stat((err, stat) => {
      if (err) return cb(err)
      cb(null, sizeForStat(stat))
    }))
    this._fdSize = mem.props({
      fd: this.fd,
      size: this.size,
      prefix: this.prefix
    })
    this.close = mem.promise(cb =>
      this.fd((err, fd) => {
        if (err) return cb(err)
        const noReader = () => {
          this.fsCache.fs.close(fd, cb)
        }
        const check = () => {
          if (this._reading === 0) {
            this._closed = () => {}
            noReader()
          }
        }
        this._closed = check
        check()
      })
    )
  }

  getRange (rangeIndex, size) {
    let rangeStart = rangeIndex * this.blkSize
    let rangeEnd = rangeStart + this.blkSize
    let rangeSize = this.blkSize
    if (rangeEnd > size) {
      rangeEnd = size
      rangeSize = size - rangeStart
    }
    return {rangeStart, rangeEnd, rangeSize}
  }

  _readRange (start, end, process, cb) {
    this._fdSize((error, fdSize) => {
      if (error) return cb(error)
      const size = fdSize.size
      const fd = fdSize.fd
      const prefix = fdSize.prefix
      if (start < 0 || end > size) {
        return cb(err('ERR_RANGE', `Invalid Range: ${start}:${end} of '${this.path}' (size: ${size})`))
      }
      if (end !== null && end !== undefined && end < start) {
        return cb(err('ERR_RANGE', `Invalid Range: start(${start}) is after end(${end})`))
      }
      const safe = getSafeSize(start, end, size)
      if (safe.size === 0) {
        return cb(null, Buffer.allocUnsafe(0), 0, safe)
      }
      const firstIndex = safe.start / this.blkSize | 0
      const lastIndex = (safe.end - 1) / this.blkSize | 0
      const nextRange = index => {
        const range = this.getRange(index, size)
        const rangeEnd = range.rangeEnd
        const rangeStart = range.rangeStart
        let rangeSize = range.rangeSize
        if (this._closed !== undefined) return cb(err('ERR_CLOSED', `File pointer has been closed.`))
        this._reading++
        this.fsCache._readCached(fd, prefix, rangeStart, rangeEnd, (err, data) => {
          this._reading--
          if (this._closed !== undefined) this._closed()
          if (err) return cb(err)
          let rightCut = rangeSize
          let leftCut = 0
          if (index === lastIndex) {
            rightCut = rangeSize - (rangeEnd - safe.end)
          }
          if (index === firstIndex) {
            leftCut = safe.start - rangeStart
          }
          if (leftCut > 0 || rightCut < rangeSize) {
            // TODO: Data.slice creates a new Buffer, which is unnecessary
            // for `read` but neccesseary for `readStream` maybe can be split?
            data = data.slice(leftCut, rightCut)
            rangeSize = rightCut - leftCut
          }
          if (index === lastIndex) {
            return cb(null, data, rangeSize, safe)
          } else {
            process(data, rangeSize, safe)
            nextRange(index + 1)
          }
        })
      }
      nextRange(firstIndex)
    })
  }

  createReadStream (opts) {
    if (this._closed) {
      throw err('ERR_CLOSED', 'File pointer has been closed.')
    }
    const stream = new Readable({read: () => {}})
    if (!opts) opts = {}
    this._readRange(
      opts.start,
      opts.end,
      buffer => stream.push(buffer),
      (err, endBuffer) => {
        if (err) {
          return stream.destroy(err)
        }
        stream.push(endBuffer)
        stream.push(null)
      }
    )
    return stream
  }

  _read (buffer, offset, length, start, cb) {
    if (start === undefined || start === null) {
      start = this.position
    }
    const end = (length === undefined || length === null) ? null : start + length
    if (end === undefined || end === null) {
      this.position = 0
    } else {
      this.position = end
    }
    return promisifyAsync(cb2 => {
      if (buffer) {
        if (offset === undefined || offset === null) {
          offset = 0
        } else if (offset < 0) {
          return cb2(err('ERR_INVALID_ARG_TYPE', 'offset can not be negative'))
        } else if (offset > buffer.length - 1) {
          return cb2(err('ERR_INVALID_ARG_TYPE', 'offset bigger than the provided bufferr'))
        }
        if (length > (buffer.length - offset)) {
          return cb2(err('ERR_RANGE', `Invalid Range: ${start}+${length} is bigger than the space left in the provided buffer ${buffer.length}(offset: ${offset})`))
        }
      } else {
        offset = 0
      }
      this._readRange(
        start,
        end,
        (partBuffer, bufferLength, safe) => {
          if (buffer === undefined || buffer === null) {
            buffer = Buffer.allocUnsafe(safe.size)
          }
          partBuffer.copy(buffer, offset, 0, bufferLength)
          offset += bufferLength
        },
        (err, endBuffer, endBufferLength, safe) => {
          if (err) return cb2(err)
          if (buffer === undefined || buffer === null) {
            return cb2(null, endBuffer)
          }
          endBuffer.copy(buffer, offset, 0, endBufferLength)
          cb2(null, buffer)
        }
      )
    }, cb)
  }

  read (buffer, offset, length, position, cb) {
    if (typeof buffer === 'function') {
      return this._read(undefined, undefined, undefined, undefined, buffer)
    }
    if (typeof offset === 'function') {
      return this._read(buffer, undefined, undefined, undefined, offset)
    }
    if (typeof length === 'function') {
      return this._read(buffer, offset, undefined, undefined, length)
    }
    if (typeof position === 'function') {
      return this._read(buffer, offset, length, undefined, position)
    }
    return this._read(buffer, offset, length, position, cb)
  }
}
CachedFile.DEFAULT_BLK_SIZE = 512

module.exports = CachedFile
