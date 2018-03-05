'use strict'
const bb = require('bluebird')
const test = require('tap').test
const Cache = require('../Cache')
const promisify = require('../lib/promisifyAsync')
const createDrive = require('./lib/drive')
const toPromise = require('stream-to-promise')

test('Fail without fs', t => {
  try {
    // eslint-disable-next-line no-new
    (new Cache())
    t.fail('Passed without a filesystem')
  } catch (err) {
    t.equals(err.code, 'ERR_INVALID_ARG_TYPE')
    t.end()
  }
})

test('creating a reader requires a path', t => {
  const c = new Cache({})
  try {
    c.openSync()
    // eslint-disable-next-line no-new
    t.fail('Passed without a filesystem')
  } catch (err) {
    t.equals(err.code, 'ERR_INVALID_ARG_TYPE')
    t.end()
  }
})

test('convenience API: createReadStream', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const c = new Cache(drive)
      return toPromise(c.createReadStream('hello'))
    })
    .then(data => t.equals(data.toString(), 'world'))
)

test('convenience API: createReadStream should close', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      let opened = 0
      drive._open = drive.open
      drive.open = (name, flags, mode, opts, cb) => {
        return drive._open(name, flags, mode, opts, (err, data) => {
          opened += 1
          cb(err, data)
        })
      }
      let closed = 0
      drive._close = drive.close
      drive.close = (fp, cb) => {
        closed += 1
        return drive._close(fp, cb)
      }
      const c = new Cache(drive)
      return toPromise(c.createReadStream('hello'))
        .then(data => {
          t.equals(data.toString(), 'world')
          t.equals(closed, 1)
          t.equals(opened, 1)
        })
    })
)

test('compatibility API: read', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const c = new Cache(drive)
      return c.open('hello')
        .then(fp => c.read(fp))
        .then(data => t.equals(data.toString(), 'world'))
    })
)

test('convenience API: close', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const c = new Cache(drive)
      return c.open('hello')
        .then(fp => c.close(fp)
          .then(() => {
            fp.read()
              .then(() => Promise.reject(new Error('shouldt work while closed')))
              .catch(err => {
                t.equals(err.code, 'ERR_CLOSED')
              })
          })
        )
    })
)

test('convenience API: read cb', t =>
  createDrive([{ name: 'hello', data: 'world' }])
    .then(drive => {
      const c = new Cache(drive)
      return new Promise((resolve, reject) => {
        c.open('hello', (err, data) => {
          if (err) return reject(err)
          resolve(data)
        })
      })
        .then(fp => c.read(fp))
        .then(data => t.equals(data.toString(), 'world'))
    })
)

test('reading a file', t => {
  const fs = {
    read (fd, buffer, offset, size, start, cb) {
      t.equals(buffer.length, 31, 'Buffer size is as big as the range')
      t.equals(offset, 0, 'offset is supposed to be starting at 0')
      t.equals(start, 2)
      t.type(cb, 'function')
      cb()
    }
  }
  const c = new Cache(fs)
  c._readCached(null, 'x', 2, 33, err => {
    t.equals(null, err)
    t.end()
  })
})

test('reading from cache', t => {
  let once = true
  const fs = {
    read (fd, buffer, offset, size, start, cb) {
      if (!once) {
        t.fail('read called twice')
      }
      once = false
      cb()
    }
  }
  const c = new Cache(fs)
  c._readCached(null, 'x', 2, 33, (_, buffer) => {
    c._readCached(null, 'x', 2, 33, (_, buffer2) => {
      t.equals(buffer, buffer2)
      t.end()
    })
  })
})

test('two different files/ranges from the same cache', t => {
  let called = 0
  const fs = {
    read (fd, buffer, offset, size, start, cb) {
      called += 1
      cb()
    }
  }
  const c = new Cache(fs)
  c._readCached(null, 'x', 2, 33, (_, buffer) => {
    c._readCached(null, 'y', 2, 33, (_, buffer2) => {
      t.equals(called, 2)
      t.notEqual(buffer, buffer2)
      t.end()
    })
  })
})

test('exceeding the (custom) cache-size should drop old data', t => {
  const fs = {
    read (fd, buffer, offset, size, start, cb) { cb() }
  }
  const c = new Cache(fs, {cacheSize: 30})
  const read = (path, start, end) => promisify(cb => c._readCached(null, path, start, end, cb))

  return bb.mapSeries(['x', 'y', 'z'], path => read(path, 0, 15))
    .then(([x, y, z]) =>
      bb.mapSeries(['x', 'z', 'y'], path => read(path, 0, 15))
        .then(([x2, z2, y2]) => {
          t.notEqual(x2, x)
          t.equal(z2, z)
          t.notEqual(y2, y)
        })
    )
})

test('custom cache is used', t => {
  const fs = {
    read (fd, buffer, offset, size, start, cb) {
      cb()
    }
  }
  let stored
  const c = new Cache(fs, {
    cache: {
      get: (key) => {
        if (key === 'x2:33') {
          return true
        }
        t.same(key, 'y2:33')
        return null
      },
      set: (key, value) => {
        t.same(key, 'y2:33', '')
        t.type(value, Buffer)
        stored = value
      }
    }
  })
  c._readCached(null, 'x', 2, 33, (_, res) => {
    t.equal(res, true, 'Received the cached result')
    c._readCached(null, 'y', 2, 33, (_, buffer2) => {
      t.equal(buffer2, stored, 'Recieved the same instance that is stored')
      t.end()
    })
  })
})

test('reading errors bubble through', t => {
  const fs = {
    read (fd, buffer, offset, size, start, cb) {
      cb(new Error('custom error'))
    }
  }
  const c = new Cache(fs)
  c._readCached(null, 'x', 1, 20, err => {
    t.equals(err.message, 'custom error')
    t.end()
  })
})
