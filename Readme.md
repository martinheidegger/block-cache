# block-cache

[![Build Status](https://travis-ci.org/martinheidegger/block-cache.svg?branch=master)](https://travis-ci.org/martinheidegger/block-cache)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Maintainability](https://api.codeclimate.com/v1/badges/16ad2e5bd41ce529ae97/maintainability)](https://codeclimate.com/github/martinheidegger/block-cache/maintainability)
[![Test Coverage](https://api.codeclimate.com/v1/badges/16ad2e5bd41ce529ae97/test_coverage)](https://codeclimate.com/github/martinheidegger/block-cache/test_coverage)

`block-cache` is a transparent(ish) cache that keeps data split in blocks in
an in-memory lru-cache. This is useful if you want to process a file, reusing
previously downloaded parts and improving the general performance without
caching more than your given memory limit.

The cache does not expose the passed-in API at any point which makes it
suitable as a Sandbox.

`npm i block-cache --save`

## Usage

The API of `block-cache` is comparable to the
[`fs`](https://nodejs.org/api/fs.html) API but all callbacks are optional and
if omitted will result in a Promise returned.

Here is a simple example of reading a file into the local cache.

```javascript
const fs = require('fs')
const {Cache, CachedFile} = require('block-cache')

const cache = new Cache(fs, {
  blkSize: 1024,
  cacheSize: 2 * 1024 * 1024 // 2 MB
})
const fp = await cache.open('./Readme.md')
const data = await cache.read(fp)

console.log(data)

await cache.close(fp)
```

This example reads the entirety of the `./Readme.md` file into a 2 mega-byte
cache in 1 kilo-byte sized blocks and then closes the data. Even if the fp is
closed: the block stay in the cache!

## Use-case: file parsing

This library usually comes in play when you have to parse parts of a file
depending on the header. Take the beginning of this GIF parser for example:

```javascript
const fs = require('fs')
const {Cache, CachedFile} = require('block-cache')

const cache = new Cache(fs, {
  blkSize: 1024,
  cacheSize: 2 * 1024 * 1024 // 2 MB
})
const fp = await cache.open('./Readme.md')
const signature = (await fp.read(null, 0, 6)).toString()
if (signature === 'GIF87a' || signature === 'GIF89a') {
  const packed = await fp.read(null, 0, 10)
  // etc.
}

await cache.close(fp)
```

As you can see in this example code, it is necessary to read only parts of a
file at a time. Very small parts. But most of those bytes are already
present in the cache. So, while the first operation needed to read 1Kb of
the file, the second operation can already use it from the cached data.

## API

- [`Cache`](#Cache)
    - [`.open`](#cache.open)
    - [`.close`](#cache.close)
    - [`.disconnect`](#cache.disconnect)
    - [`.openSync`](#cache.openSync)
    - [`.read`](#cache.read)
    - [`.createReadStream`](#cache.createReadStream)
    - [`DEFAULT_CACHE_SIZE`](#Cache.DEFAULT_CACHE_SIZE)
- [`CachedFile`](#CachedFile)
    - [`.close`](#cachedFile.close)
    - [`.read`](#cachedFile.read)
    - [`.createReadStream`](#cachedFile.createReadStream)
    - [`.size`](#cachedFile.size)
    - [`.stat`](#cachedFile.stat)
    - [`DEFAULT_BLK_SIZE`](#CachedFile.DEFAULT_BLK_SIZE)

---

<a name="Cache"></a>

```javascript
new Cache(fs[, opts])
```

- `fs` is a [FileSystem](https://nodejs.org/api/fs.html) (`require('fs')`)) or
    [Hyperdrive](https://github.com/mafintosh/hyperdrive) archive (object).
- `opts.cache` is a [`lru-cache`](https://github.com/isaacs/node-lru-cache)
    instance (object, optional).
- `opts.cacheSize` is the size of the lru-cache to be created in case a
    `opts.cache` is missing. Defaults to
    [`Cache.DEFAULT_CACHE_SIZE`](#Cache.DEFAULT_CACHE_SIZE) (integer).
- `opts.blkSize` is the default size in bytes of a cache-block. Defaults to
    [`CachedFile.DEFAULT_BLK_SIZE`](#CachedFile.DEFAULT_BLK_SIZE). (integer).
- `opts.prefix` is an optional prefix that can be added to the cached data,
    useful if you want to reuse the same `opts.cache` for multiple
    `Cache` instances. Defaults to `''`. (string)

---

<a name="cache.open"></a>

```javascript
cache.open(path[, opts, cb])
```

Creates a cached file pointer reference for a given path. Note: It will open
the file reference in `r` mode.

- `path` path to read the file from (string).
- `opts.blkSize` is the size in bytes of a cache-block. Defaults to the
    `opts.blkSize` defined in the `Cache`.
- `cb(Error, CachedFile)` is an optional async callback handler method.
    The method will return a `Promise` if the callback is not defined.

---

<a name="cache.close"></a>

```javascript
cache.close(fp[, cb])
```

Closes a created file pointer reference. After closing, future requests
on the `CachedFile` will result in an `err.code === 'ERR_CLOSED` error.

- `fp` is a [`CachedFile`](#CachedFile) instance, created
    with [`.open`](#cache.open) or [`.openSync`](#cache.openSync)
- `cb(Error)` is an optional async callback handler method.
    The method will return a `Promise` if the callback is not defined.

---

<a name="cache.disconnect"></a>

```javascript
cache.disconnect()
```

Disconnects the cache from the file system instance. Any future operations on
the Cache or CachedFile instances create with the Cache  will result in
an `err.code === 'ERR_DISCONNECTED'` error. Disconnect also closes all open
file pointer references on the underlying file system.  

---

<a name="cache.openSync"></a>

```javascript
cache.openSync(path[, opts])
```

like `cache.open` but synchronous.

---

<a name="cache.read"></a>

```javascript
cache.read(fd[, buffer, offset, length, position, cb])
```

Reads the content of an opened file into a given buffer.

- `fd` is a [`CachedFile`](#CachedFile) instance, created
    with [`.open`](#cache.open) or [`.openSync`](#cache.openSync)
- `buffer` is a [`Buffer`](https://nodejs.org/api/buffer.html) instance to
    write into. Unlike the Node API, this is optional which means that the
    reader will create a buffer instance if `null` or `undefined` is passed-in.
- `offset` is the offset in the buffer to start writing at.
- `length` is an integer specifying the number of bytes to read into buffer,
    defaults to length of the file (integer).
- `position` is an argument specifying where to begin reading from in the file.
    The file descriptor will remember the end of the last read in the
   `fd.position` property. It will default to 0.
- `cb(Error, Buffer)` is an optional async callback handler method. The method
    will return a `Promise` if the callback is not defined.

---

<a name="cache.createReadStream"></a>

```javascript
cache.createReadStream(path[, opts, cb])
```

Creates a cached file pointer reference for a given path and then reads it
through a stream.

- `path` is the path to read the file from (string).
- `opts.blkSize` is the block size for each block to be cached. Defaults
    to [`cache.opts.blkSize`](#Cache). (integer).
- `opts.start` is the start from while to read the file. Defaults to 0. (integer)
- `opts.end` is the end until which to read the file. Defaults to the end of
    the file. (integer)

<a name="Cache.DEFAULT_CACHE_SIZE"></a>

```javascript
Cache.DEFAULT_CACHE_SIZE
```

The default size of a cache created if `opts.cache` is not passed in: 10485760
(integer, equals 10 MegaByte)

---

<a name="CachedFile"></a>

```javascript
new CachedFile(cache, path[, opts])
```

Creates a new instance for reading one file. The blocks will still be stored in
the passed-in `cache` object. While it is possible to instantiate a new
`CachedFile`, you can not pass-in a cache directly, use the
[`.open`](#cache.open), [`.openSync`](#cache.openSync) or
[`.createReadStream`](#cache.createReadStream) to interact with the cache

- `cacheInternal` a subset of the `Cache` API that is not accessible from
    outside.
- `cacheInternal.open(path, opts, cb)` opens a file pointer to a given `path`
    on the underlying `fs`.
- `cacheInternal.stat(path, cb)` receives the `stat` file from the underlying
   `fs`
- `cacheInternal.close(fp, cb)` closes a file pointer on the underlying `fs`.
- `cacheInternal.read(fp, prefix, start, end, cb)` reads bytes from the
    underlying `fs` into a buffer.
- `opts.blkSize` specifies the block size for this file pointer (integer).
    Defaults to [`CachedFile.DEFAULT_BLK_SIZE`](#CachedFile.DEFAULT_BLK_SIZE).

---

<a name="cachedFile.close"></a>

```javascript
cachedFile.close([cb])
```

Closes the instance. After closing, future requests
on the `CachedFile` will result in an `err.code === 'ERR_CLOSED` error.

- `cb(Error)` is an optional async callback handler method.
    The method will return a `Promise` if the callback is not defined.

---

<a name="cachedFile.read"></a>

```javascript
cachedFile.read([buffer, offset, length, position, cb])
```

Like [`cache.read`](#cache.read) but without the need to pass a descriptor.

---

<a name="cachedFile.createReadStream"></a>

```javascript
cachedFile.createReadStream([opts, cb])
```

Like [`cache.createReadStream`](#cache.createReadStream) but without the need
to pass a descriptor.

---

<a name="cachedFile.size"></a>

```javascript
cachedFile.size([cb])
```

The size of the file as noted in the file descriptor.

---

<a name="cachedFile.stat"></a>

```javascript
cachedFile.stat([cb])
```

Retreives the actual
[`Stats`](https://nodejs.org/api/fs.html#fs_class_fs_stats) of the file
through [`fs.stat`](https://nodejs.org/api/fs.html#fs_class_fs_stats).

---

<a name="CachedFile.DEFAULT_BLK_SIZE"></a>

```javascript
CachedFile.DEFAULT_BLK_SIZE
```

The default `opts.blkSize` used for caching: 512 (integer, equals 512 Byte).

## Acknowledgement

This project was made for and supported by [dotloom](https://github.com/dotloom).

## License

MIT
