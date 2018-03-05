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
  constructor (internal, path, opts) {
    const fp = mem.promise(cb => internal.open(path, 'r', cb))
    const init = mem.props({
      fp,
      prefix: mem.promise(cb => this.stat((err, stat) => {
        if (err) return cb(err)
        cb(null, `${path}:${stat.mtime.getTime().toString(32)}:`)
      }))
    })
    let position = 0
    let _isClosed = false
    Object.defineProperties(this, {
      blkSize: {
        value: (opts && opts.blkSize) || CachedFile.DEFAULT_BLK_SIZE
      },
      position: {
        get: () => position,
        set: (pos) => { position = pos }
      },
      _isClosed: {
        get: () => _isClosed
      },
      stat: {
        value: mem.promise(cb => internal.stat(path, cb))
      },
      size: {
        value: mem.promise(cb => this.stat((err, stat) => {
          if (err) return cb(err)
          cb(null, sizeForStat(stat))
        }))
      }
    })
    let reading = 0
    let closer
    this._readCached = (rangeStart, rangeEnd, cb) => {
      init((error, parts) => {
        if (error) return cb(error)
        if (closer !== undefined) return cb(err('ERR_CLOSED', `File pointer has been closed.`))
        reading++
        internal.read(parts.fp, parts.prefix, rangeStart, rangeEnd, (err, data) => {
          reading--
          if (closer !== undefined) closer()
          cb(err, data)
        })
      })
    }
    this.close = mem.promise(cb => {
      _isClosed = true
      fp((err, fp) => {
        if (err) return cb(err)
        const noReader = () => {
          internal.close(fp, cb)
        }
        const check = () => {
          if (reading === 0) {
            closer = () => {}
            noReader()
          }
        }
        closer = check
        check()
      })
    })
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
    this.size((error, size) => {
      if (error) return cb(error)
      if (start < 0 || end > size) {
        return cb(err('ERR_RANGE', `Invalid Range: ${start}:${end} (size: ${size})`))
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
        this._readCached(rangeStart, rangeEnd, (err, data) => {
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
    if (this._isClosed) {
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
