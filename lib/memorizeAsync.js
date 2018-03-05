'use strict'
const promisifyAsync = require('./promisifyAsync')

function memorizeAsync (op) {
  let current = cb => {
    let cbs = [cb]
    current = cb2 => cbs.push(cb2)
    op((err, data) => {
      current = cb3 => cb3(err, data)
      cbs.forEach(cb3 => cb3(err, data))
    })
  }
  return cb => current(cb)
}
memorizeAsync.props = (obj) => {
  return memorizeAsync(cb => {
    const res = {}
    const keys = Object.keys(obj)
    let count = keys.length
    let hasError = false
    keys.forEach(key => {
      obj[key]((error, data) => {
        if (hasError) return
        if (error) {
          hasError = true
          cb(error)
        }
        res[key] = data
        count -= 1
        if (count === 0) {
          cb(null, res)
        }
      })
    })
  })
}
memorizeAsync.promise = op => {
  const mem = memorizeAsync(op)
  return cb => {
    return promisifyAsync(mem, cb)
  }
}

module.exports = memorizeAsync
