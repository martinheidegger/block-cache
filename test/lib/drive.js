'use-strict'
const ram = require('random-access-memory')
const hyperdrive = require('hyperdrive')
const bb = require('bluebird')

function writeFile (drive, file) {
  return new Promise((resolve, reject) => {
    drive.writeFile(file.name, file.data, (err) => err ? reject(err) : resolve())
  })
}

module.exports = (files) => {
  const drive = hyperdrive(ram)
  return bb.mapSeries(files, writeFile.bind(null, drive)).then(() => drive)
}
