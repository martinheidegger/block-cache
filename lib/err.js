'use strict'
module.exports = function err (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
