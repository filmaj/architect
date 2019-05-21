let aws = require('aws-sdk')
let chalk = require('chalk')
let parallel = require('run-parallel')
let series = require('run-series')
let eq = require('shallow-equal/objects')
let path = require('path')
let fs = require('fs')
let readArc = require('../util/read-arc')
let isReserved = require('./_is-reserved')

// local helpers
let inventory = require('../inventory')
let _longest = require('./_get-longest')
let _all = require('./_all')
let error = msg=> console.log(chalk.bold.red('Error'), chalk.bold.white(msg))

module.exports = function _verify(appname, callback) {
  parallel({
    // get the env vars
    env(callback) {
      _all(appname, callback)
    },
    // get the lambdas
    lambdas(callback) {
      let {arc, raw} = readArc()
      inventory(arc, raw, callback)
    }
  },
  function done(err, result) {
    if (err) {
      error(err.message)
    }
    else {
      let lambda = new aws.Lambda({region: process.env.AWS_REGION})
      let testing = result.env.filter(e=> e.env === 'testing')
      let staging = result.env.filter(e=> e.env === 'staging')
      let production = result.env.filter(e=> e.env === 'production')

      // write a local .arc-env
      let envPath = path.join(process.cwd(), '.arc-env')
      fs.writeFileSync(envPath, toArc(testing, staging, production))

      // printers
      let longest = _longest(result.lambdas.lambdas)
      let _pads = v=> chalk.dim(`${v} `.padEnd(longest, '.')) + ' '
      let error = msg=> console.log(chalk.bold.red('Error'), chalk.bold.white(msg))
      let notfound = name=> console.log(_pads(name), chalk.yellow('not found (run inventory and create to fix)'))
      let ok = name=> console.log(_pads(name), chalk.green('env ok'))

      // walk each lambda
      series(result.lambdas.lambdas.map(FunctionName=> {
        return function _verifyLambda(callback) {
          setTimeout(function _delay() {
            lambda.getFunctionConfiguration({FunctionName}, function _prettyPrint(err, result) {
              if (err && err.code === 'ResourceNotFoundException') {
                notfound(FunctionName)
                callback()
              }
              else if (err) {
                error(err.message)
                callback()
              }
              else {
                // clean env vars of anything reserved
                let copy = {}
                let saves = {}
                for (let key in result.Environment.Variables) {
                  if (!isReserved(key)) {
                    copy[key] = result.Environment.Variables[key]
                  }
                  else {
                    saves[key] = result.Environment.Variables[key]
                  }
                }

                let isProduction = result.Environment.Variables.NODE_ENV === 'production'
                let expected = toEnv(isProduction? production : staging)

                if (eq(expected, copy)) {
                  ok(FunctionName)
                  callback()
                }
                else {
                  lambda.updateFunctionConfiguration({
                    FunctionName,
                    Environment: {
                      Variables: {
                        ...expected,
                        ...saves,
                      }
                    }
                  },
                  function _syncd(err) {
                    if (err) error(err.message)
                    else ok(FunctionName)
                    callback()
                  })
                }
              }
            })
          }, 100) // 100ms == 10 Lambda TPS, same as deploy default
        }
      }), callback)
    }
  })
}

function toEnv(vars) {
  let done = {}
  vars.forEach(v=> done[v.name] = v.value)
  return done
}

function toArc(testing, staging, production) {
  let done = '# Caution: this file was generated by running npx env\n'
  done += '@testing\n'
  testing.forEach(v=> done += `${v.name} ${v.value}\n`)
  done += '\n@staging\n'
  staging.forEach(v=> done += `${v.name} ${v.value}\n`)
  done += '\n@production\n'
  production.forEach(v=> done += `${v.name} ${v.value}\n`)
  return done
}
