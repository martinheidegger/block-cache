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

function setterGetter (initial) {
  let value = initial
  return {
    get: () => value,
    set: newValue => { value = newValue }
  }
}

function property (value) {
  return { value }
}

function trimBlock (data, index, range, block) {
  let rightCut = block.size
  let leftCut = 0
  if (index === range.lastIndex) {
    rightCut = block.size - (block.end - range.end)
  }
  if (index === range.firstIndex) {
    leftCut = range.start - block.start
  }
  if (leftCut > 0 || rightCut < block.size) {
    // TODO: Data.slice creates a new Buffer, which is unnecessary
    // for `read` but neccesseary for `readStream` maybe can be split?
    data = data.slice(leftCut, rightCut)
  }
  return data
}

class CachedFile {
  constructor (internal, path, opts) {
    let isClosed = false
    let closeCb
    let reading = 0
    const init = mem.props({
      fp: cb => internal.open(path, 'r', cb),
      prefix: cb => this.stat((err, stat) => {
        if (err) return cb(err)
        cb(null, `${path}:${stat.mtime.getTime().toString(32)}:`)
      })
    })
    Object.defineProperties(this, {
      _isClosed: { get: () => isClosed },
      position: setterGetter(0),
      blkSize: property((opts && opts.blkSize) || CachedFile.DEFAULT_BLK_SIZE),
      close: mem.property(cb => {
        isClosed = true
        init((err, parts) => {
          if (err) return cb(err)
          closeCb = () => internal.close(parts.fp, cb)
          if (reading === 0) {
            closeCb()
          }
        })
      }),
      stat: mem.property(cb => internal.stat(path, cb)),
      size: mem.property(cb => this.stat((err, stat) => {
        if (err) return cb(err)
        cb(null, sizeForStat(stat))
      })),
      _readCached: property((block, cb) => init((error, parts) => {
        if (error) return cb(error)
        if (isClosed) return cb(err('ERR_CLOSED', `File pointer has been closed.`))
        reading++
        internal.read(parts.fp, parts.prefix, block.start, block.end, (err, data) => {
          reading--
          if (closeCb !== undefined && reading === 0) closeCb()
          cb(err, data)
        })
      }))
    })
  }

  _getBlock (blkIndex, total) {
    let size = this.blkSize
    let start = blkIndex * size
    let end = start + size
    if (end > total) {
      end = total
      size = total - start
    }
    return {start, end, size}
  }

  _getSafeRange (start, end, cb) {
    this.size((error, size) => {
      if (error) return cb(error)
      if (start < 0 || end > size) {
        return cb(err('ERR_RANGE', `Invalid Range: ${start}:${end} (size: ${size})`))
      }
      if (end !== null && end !== undefined && end < start) {
        return cb(err('ERR_RANGE', `Invalid Range: start(${start}) is after end(${end})`))
      }
      if (start === -1 || start === undefined || start === null) {
        start = 0
      }
      if (end === -1 || end === undefined || end === null) {
        end = size
      }
      cb(null, {
        start,
        end,
        size: end - start,
        total: size,
        firstIndex: start / this.blkSize | 0,
        lastIndex: (end - 1) / this.blkSize | 0
      })
    })
  }

  _readRange (start, end, process, cb) {
    this._getSafeRange(start, end, (error, range) => {
      if (error) return cb(error)
      if (range.total === 0) {
        return cb(null, Buffer.allocUnsafe(0), 0)
      }
      const nextRange = index => {
        const block = this._getBlock(index, range.total)
        this._readCached(block, (err, data) => {
          if (err) return cb(err)
          data = trimBlock(data, index, range, block)
          if (index === range.lastIndex) {
            return cb(null, data, data.length)
          } else {
            process(data, data.length, range)
            nextRange(index + 1)
          }
        })
      }
      nextRange(range.firstIndex)
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
        (partBuffer, bufferLength, range) => {
          if (buffer === undefined || buffer === null) {
            buffer = Buffer.allocUnsafe(range.size)
          }
          partBuffer.copy(buffer, offset, 0, bufferLength)
          offset += bufferLength
        },
        (err, endBuffer, endBufferLength) => {
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
