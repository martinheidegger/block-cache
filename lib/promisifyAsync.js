'use strict'

// This promisify variant is optimised for performance
// because it lacks several checks that are not needed
// in our case (also its rather tiny).
module.exports = (op, cb) => {
  let promise
  if (cb === undefined || cb === null) {
    let _cb
    promise = new Promise((resolve, reject) => {
      _cb = (err, data) => err ? reject(err) : resolve(data)
    })
    cb = (err, data) => _cb(err, data)
  }
  op(cb)
  return promise
}
