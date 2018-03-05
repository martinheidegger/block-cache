'use strict'
const test = require('tap').test
const blockCache = require('../')
const Cache = require('../Cache')
const CachedFile = require('../CachedFile')

test('API exposure', t => {
  t.deepEquals(blockCache, {
    Cache,
    CachedFile
  })
  t.end()
})
