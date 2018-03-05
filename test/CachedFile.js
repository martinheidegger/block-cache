'use strict'
const toPromise = require('stream-to-promise')
const test = require('tap').test
const createDrive = require('./lib/drive')
const Cache = require('../Cache')
const CachedFile = require('../CachedFile')
const promisifyAsync = require('../lib/promisifyAsync')

function cachedFile (drive, path, opts) {
  return Object.freeze(new Cache(drive).openSync(path, opts))
}

function testError (t, name, op, validate) {
  return op()
    .then(() => t.fail(`no error occured?! ${name}`))
    .catch(validate)
}

const noop = () => {}

test('stat-errors bubble', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      drive.stat = (_, cb) => {
        cb(new Error('custom - stat - error'))
      }
      const testErr = (name, op) => testError(t, name, op, (err) => t.equals(err.message, 'custom - stat - error', `error thrown during ${name}`))
      const c = cachedFile(drive, 'hello')
      return Promise.all([
        testErr('size', () => c.size()),
        testErr('stat', () => c.stat()),
        testErr('read', () => c.read()),
        testErr('_readCached', () => new Promise((resolve, reject) => {
          c._readCached({start: 0, end: 10}, err => err ? reject(err) : resolve())
        }))
      ])
    })
)

test('fd-errors bubble', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      drive.open = (_, _2, cb) => {
        cb(new Error('custom - open - error'))
      }
      const testErr = (name, op) => testError(t, name, op, (err) => t.equals(err.message, 'custom - open - error', `error thrown during ${op}`))
      const c = cachedFile(drive, 'hello')
      return Promise.all([
        testErr('close', () => c.close()),
        c.stat(),
        c.size()
      ])
    })
)

test('read-errors bubble', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      drive.read = (fd, buffer, offset, size, start, cb) => {
        cb(new Error('custom - read - error'))
      }
      const c = cachedFile(drive, 'hello')
      return Promise.all([
        testError(t, 'read', () => c.read(), err => t.equals(err.message, 'custom - read - error')),
        new Promise((resolve, reject) => {
          const stream = c.createReadStream()
          stream.on('error', err => {
            t.equals(err.message, 'custom - read - error')
            resolve()
          })
          stream.on('end', () => {
            reject(new Error('unexpected error'))
          })
        }),
        c.stat(),
        c.size()
      ])
    })
)

test('default block size', t => {
  t.equals(CachedFile.DEFAULT_BLK_SIZE, 512)
  const c = cachedFile(require('fs'), './Readme.md', {open: noop, stat: noop})
  t.equals(c.blkSize, CachedFile.DEFAULT_BLK_SIZE)
  t.end()
})

test('trying to read invalid ranges', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello'))
    .then(file => Promise.all([
      testError(t, 'end before start', () => file.read(null, 0, -1, 2), (err) => t.equals(err.code, 'ERR_RANGE')),
      testError(t, 'start after size', () => file.read(null, 0, 1, 101), (err) => t.equals(err.code, 'ERR_RANGE')),
      testError(t, 'end after size', () => file.read(null, 0, 101, 2), (err) => t.equals(err.code, 'ERR_RANGE'))
    ]))
)

test('various read fallbacks', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello'))
    .then(file => Promise.all([
      promisifyAsync((cb) => file.read(cb))
        .then(data => t.equal(data.toString(), 'world')),
      promisifyAsync((cb) => file.read(Buffer.from('xxxxxx'), cb))
        .then(data => t.equal(data.toString(), 'worldx')),
      promisifyAsync((cb) => file.read(Buffer.from('xxx'), 1, cb))
        .then(data => t.equal(data.toString(), 'xwo')),
      promisifyAsync((cb) => file.read(Buffer.from('xxx'), 1, 1, cb))
        .then(data => t.equal(data.toString(), 'xwx')),
      promisifyAsync((cb) => file.read(Buffer.from('xxx'), 1, 1, 1, cb))
        .then(data => t.equal(data.toString(), 'xox'))
    ]))
)

test('last block arrives seperately', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 2}))
    .then(file => file.read(null, 0, 2, 2))
    .then(data => t.equal(data.toString(), 'rl'))
)

test('last block gets cut', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(null, 0, 2, 4))
    .then(data => t.equal(data.toString(), 'ds'))
)

test('two block get merged together', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(null, 0, 3, 2))
    .then(data => t.equal(data.toString(), 'rld'))
)

test('first block gets passed as is', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(null, 0, 3, 0))
    .then(data => t.equal(data.toString(), 'wor'))
)

test('reading into an existing buffer', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(Buffer.from('abcdef'), 0, 3, 0))
    .then(data => t.equal(data.toString(), 'wordef'))
)

test('reading into an existing buffer ... at an offset', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(Buffer.from('abcdef'), 2, 3, 0))
    .then(data => t.equal(data.toString(), 'abworf'))
)

test('end assumed when writing in buffer', t =>
  createDrive([{ name: 'hello', data: 'worlds' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 3}))
    .then(file => file.read(Buffer.from('abc'), 2))
    .then(data => t.equal(data.toString(), 'abw'))
)

test('trying to read invalid buffer ranges', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello'))
    .then(file => Promise.all([
      testError(t, 'negative offset', () => file.read(Buffer.from(''), -1), (err) => t.equals(err.code, 'ERR_INVALID_ARG_TYPE')),
      testError(t, 'too big offset', () => file.read(Buffer.from(''), 1), (err) => t.equals(err.code, 'ERR_INVALID_ARG_TYPE')),
      testError(t, 'invalid range if buffer too small', () => file.read(Buffer.from(''), null, 2, 0), (err) => t.equals(err.code, 'ERR_RANGE'))
    ]))
)

test('streams over block', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 2}))
    .then(file => toPromise(file.createReadStream()))
    .then(data => t.equals(data.toString(), 'world'))
)

test('streams impossible after closing', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => cachedFile(drive, 'hello', {blkSize: 2}))
    .then(file => file.close().then(() => file))
    .then(file => {
      try {
        file.createReadStream()
        t.fail('readstream should not be possible')
      } catch (e) {
        t.equals(e.code, 'ERR_CLOSED')
      }
    })
)

test('file systems with block stat', t => {
  const mockFs = {
    open: (_, _2, cb) => cb(null, {}),
    read: (fd, buffer, offset, size, start, cb) => {
      buffer.write('worlds', 0)
      cb(null)
    },
    stat: (_, cb) => cb(null, {
      blkSize: 3,
      isFile: () => true,
      blocks: 2,
      mtime: new Date()
    })
  }
  const file = cachedFile(mockFs, 'hello')
  return file.read().then(data => t.equals(data.toString(), 'worlds'))
})

test('file systems with empty block stat', t => {
  const mockFs = {
    open: (_, _2, cb) => cb(null, {}),
    read: (fd, buffer, offset, size, start, cb) => cb(new Error('not supposed to be called')),
    stat: (_, cb) => cb(null, {
      blkSize: 0,
      mtime: new Date()
    })
  }
  const file = cachedFile(mockFs, 'hello')
  return file.read().then(data => t.equals(data.toString(), ''))
})

test('closing while reading', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const fdA = new Cache(drive).openSync('hello')
      drive._read = drive.read
      let closed
      let isClosed = false
      const closedP = new Promise((resolve, reject) => {
        closed = (err, data) => {
          isClosed = true
          err ? reject(err) : resolve()
        }
      })
      drive.read = (fd, buffer, offset, length, position, cb) => {
        setImmediate(() => {
          fdA.close(closed)
          setImmediate(() => {
            t.equal(fdA._isClosed, true)
            drive._read(fd, buffer, offset, length, position, cb)
          })
        })
      }
      return fdA.read()
        .then((buffer) => {
          t.equals(buffer.toString(), 'world')
          t.equals(fdA.position, 0)
          t.equals(isClosed, true)
          return closedP
        })
    })
)

test('Simply reading a file', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const fd = new Cache(drive).openSync('hello')
      return fd.read()
        .then(buffer => {
          t.equals(buffer.toString(), 'world')
          t.equals(fd.position, 0)
        })
    })
)

test('Reading a file in two parts', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const fd = new Cache(drive).openSync('hello')
      const promiseA = fd.read(undefined, 0, 3)
      t.equals(fd.position, 3)
      return Promise.all([
        promiseA,
        fd.read(undefined, 0, 2)
      ])
    }).then(buffers => {
      t.equals(buffers[0].toString(), 'wor')
      t.equals(buffers[1].toString(), 'ld')
    })
)

test('Reading a file over multiple blocks', t =>
  createDrive([{ name: 'hello', data: 'itstheendoftheworldasweknowit' }])
    .then(drive => {
      const fd = new Cache(drive).openSync('hello', {blkSize: 5})
      return fd.read(null, undefined, 21, 2)
    }).then(buffer => {
      t.equals(buffer.toString(), 'stheendoftheworldaswe')
    })
)

test('Reading the whole stream', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => new Cache(drive).openSync('hello').read(null, null, null, 1))
    .then(buffer => t.equals(buffer.toString(), 'orld'))
)

test('Reading in block', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => new Cache(drive).openSync('hello', {blkSize: 2}).read())
    .then(buffer => t.equals(buffer.toString(), 'world'))
)

test('Reading with callback', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => new Promise((resolve, reject) => {
      new Cache(drive).openSync('hello').read((err, buffer) => {
        if (err) return reject(err)
        t.equals(buffer.toString(), 'world')
        resolve()
      })
    }))
)

test('Reading a stream', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => toPromise(new Cache(drive).openSync('hello').createReadStream()))
    .then(buffer => t.equals(buffer.toString(), 'world'))
)

test('read an empty range', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => new Cache(drive).openSync('hello').read(null, 0, 0, 2))
    .then(buffer => t.equals(buffer.toString(), ''))
)
